import crypto from "node:crypto";
import { Run, type Box, type RunCost, type RunStatus } from "@upstash/box";
import { z, type ZodType } from "zod";
import type { ZodType as ZodTypeV3 } from "zod/v3";
import {
  assertNativeAutomationMapping,
  boundedResult,
  readAutomation,
  reconcileStaleRuns,
  runInFlight,
  runsForMapping,
  storeRun,
  syncScheduledRuns,
  type AutomationOptions,
  type StoredRun,
} from "../automation.js";
import { ensureRunning, openBox, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { ask, requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, PluginError, type Writer } from "../result.js";
import { readState, withMappingLock, type StateOptions } from "../state.js";
import { remoteWorkingDirectory } from "../start.js";

export const DEFAULT_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
});

export const STALE_RUN_GRACE_MS = 60_000;

export function oneLinePrompt(value: string): string {
  const prompt = value.trim();
  if (!prompt || /[\r\n]/.test(value)) {
    throw new PluginError("invalid_run_prompt", "The run prompt must be one non-empty line.");
  }
  return prompt;
}

export function responseSchemaFromJson(value: string): {
  json: unknown;
  schema: ZodType;
} {
  if (/[\r\n]/.test(value)) {
    throw new PluginError("invalid_response_schema", "The JSON Schema must be one line.");
  }
  let json: unknown;
  try {
    json = value.trim() === "" ? DEFAULT_RESPONSE_SCHEMA : JSON.parse(value);
  } catch (error) {
    throw new PluginError(
      "invalid_response_schema",
      `Invalid JSON Schema JSON: ${errorMessage(error)}`,
    );
  }
  try {
    return {
      json,
      schema: z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]),
    };
  } catch (error) {
    throw new PluginError(
      "invalid_response_schema",
      `Unsupported JSON Schema: ${errorMessage(error)}`,
    );
  }
}

export function formatCost(cost: RunCost | null): string {
  if (!cost) return "Cost unavailable";
  return `Cost: $${cost.totalUsd.toFixed(6)} · ${cost.inputTokens} input / ${cost.outputTokens} output tokens · ${cost.computeMs} ms`;
}

export function describeFailure(result: unknown): string {
  if (typeof result === "string") return result;
  if (result === null || result === undefined) return "The run failed without a message.";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export interface SignalSource {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export interface AgentRunsPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  automation?: AutomationOptions;
  config?: PluginConfig;
  client?: BoxClient;
  write?: Writer;
  prompt?: (question: string) => Promise<string>;
  ensureRunning?: typeof ensureRunning;
  openBox?: typeof openBox;
  now?: () => Date;
  cancel?: AbortSignal;
  signals?: SignalSource;
  graceMs?: number;
}

interface TypedRunOptions {
  prompt: string;
  responseSchema: ZodTypeV3<unknown>;
  timeout: number;
  maxRetries: number;
  onToolUse: (tool: { name: string; input: Record<string, unknown> }) => void;
  onToolResult: (result: { output: unknown }) => void;
}

interface TypedRunResult {
  id: string;
  status: RunStatus;
  result: unknown;
  cost: RunCost;
}

function automationOptions(deps: AgentRunsPaneDeps): AutomationOptions {
  return {
    ...deps.state,
    ...deps.automation,
    env: deps.automation?.env ?? deps.state?.env ?? deps.env,
  };
}

function epochMs(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

// The SDK only hands back a run once it finishes, so a cancel finds the run id in the box's list.
export async function cancelInFlightRun(box: Box, since: string): Promise<string | null> {
  const floor = Date.parse(since) - 5_000;
  const candidates = (await box.listRuns())
    .filter(
      (run) =>
        run.type === "agent" &&
        run.status === "running" &&
        !run.schedule_id &&
        epochMs(run.created_at) >= floor,
    )
    .sort((a, b) => b.created_at - a.created_at);
  const target = candidates[0];
  if (!target) return null;
  await new Run(box, "agent", target.id).cancel();
  return target.id;
}

// The lock covers opening the box and writing the placeholder, never the model call, so stop, pause, and delete stay available.
async function executeTypedRun(
  mappingId: string,
  promptText: string,
  schemaJson: unknown,
  responseSchema: ZodType,
  deps: AgentRunsPaneDeps,
): Promise<{ stored: StoredRun; result: unknown }> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig({ env });
  const write = deps.write ?? stdoutWriter;
  const now = (): string => (deps.now?.() ?? new Date()).toISOString();
  const createdAt = now();
  const localId = `manual:${crypto.randomUUID()}`;
  const auto = automationOptions(deps);
  const placeholder: StoredRun = {
    id: localId,
    mappingId,
    boxId: "",
    source: "manual",
    scheduleId: null,
    prompt: promptText,
    responseSchema: schemaJson,
    status: "running",
    result: null,
    resultTruncated: false,
    error: null,
    cost: null,
    createdAt,
    completedAt: null,
  };
  const box = await withMappingLock(mappingId, deps.state ?? { env }, async () => {
    const mapping = readState(deps.state ?? { env }).mappings[mappingId];
    if (!mapping) {
      throw new PluginError("mapping_not_found", `Mapping ${mappingId} no longer exists.`);
    }
    assertNativeAutomationMapping(mapping);
    if (!mapping.prepared) {
      throw new PluginError(
        "mapping_not_prepared",
        "The box has no upload baseline yet. Reconnect first so preparation can finish.",
      );
    }
    const inFlight = runInFlight(
      readAutomation(auto),
      mappingId,
      config.agentRunTimeoutMs + STALE_RUN_GRACE_MS,
      Date.parse(createdAt),
    );
    if (inFlight) {
      throw new PluginError(
        "run_in_progress",
        `A typed run started at ${inFlight.createdAt} is still in flight for ${mapping.boxName}. Cancel it with Ctrl-C in its pane, or wait for it.`,
      );
    }
    const opened = await (deps.openBox ?? openBox)(mapping, { client: deps.client, env });
    await (deps.ensureRunning ?? ensureRunning)(opened, {
      onResume: () => write("Resuming the paused box...\n"),
    });
    await opened.cd(remoteWorkingDirectory(mapping));
    placeholder.boxId = mapping.boxId ?? opened.id;
    await storeRun(placeholder, { ...auto, historyLimit: config.runHistoryLimit });
    return opened;
  });
  const persist = (stored: StoredRun): Promise<void> =>
    storeRun(stored, { ...auto, historyLimit: config.runHistoryLimit, replaceId: localId });
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  const signals = deps.signals ?? process;
  signals.once("SIGINT", onSigint);
  deps.cancel?.addEventListener("abort", onSigint, { once: true });
  write("Running. Press Ctrl-C to cancel.\n");
  // maxRetries stays 0: the SDK would retry a cancelled stream as a fresh run and keep billing.
  const runAgent = box.agent.run as unknown as (
    options: TypedRunOptions,
  ) => Promise<TypedRunResult>;
  const attempt = runAgent({
    prompt: promptText,
    responseSchema: responseSchema as unknown as ZodTypeV3<unknown>,
    timeout: config.agentRunTimeoutMs,
    maxRetries: 0,
    onToolUse: (tool) => write(`→ ${tool.name} ${JSON.stringify(tool.input)}\n`),
    onToolResult: (result) => write(`← ${String(JSON.stringify(result.output)).slice(0, 240)}\n`),
  });
  const settled = attempt.then(
    (run) => ({ kind: "done" as const, run }),
    (error: unknown) => ({ kind: "error" as const, error }),
  );
  const cancellation = new Promise<{ kind: "cancelled" }>((resolve) => {
    abort.signal.addEventListener(
      "abort",
      async () => {
        write("\nCancelling the run...\n");
        await cancelInFlightRun(box, createdAt).catch((error: unknown) =>
          write(`Could not cancel in the box: ${errorMessage(error)}\n`),
        );
        resolve({ kind: "cancelled" });
      },
      { once: true },
    );
  });
  try {
    const outcome = await Promise.race([settled, cancellation]);
    // Once the cancel is sent the SDK stream errors out; that rejection must not masquerade as a failure.
    if (abort.signal.aborted) {
      await cancellation;
      await Promise.race([
        settled,
        new Promise((resolve) => setTimeout(resolve, deps.graceMs ?? 5_000)),
      ]);
      await persist({
        ...placeholder,
        status: "cancelled",
        error: "Cancelled from the pane.",
        completedAt: now(),
      });
      throw new PluginError("run_cancelled", "The run was cancelled.");
    }
    if (outcome.kind === "error") {
      await persist({
        ...placeholder,
        status: "failed",
        error: errorMessage(outcome.error),
        completedAt: now(),
      });
      throw outcome.error;
    }
    if (outcome.kind !== "done") throw new PluginError("run_cancelled", "The run was cancelled.");
    const { run } = outcome;
    const bounded = boundedResult(run.result, config.maxRunResultBytes);
    const stored: StoredRun = {
      ...placeholder,
      id: run.id || localId,
      status: run.status,
      result: bounded.result,
      resultTruncated: bounded.resultTruncated,
      error: run.status === "failed" ? describeFailure(run.result) : null,
      cost: run.cost,
      completedAt: now(),
    };
    await persist(stored);
    return { stored, result: run.result };
  } finally {
    signals.off("SIGINT", onSigint);
    deps.cancel?.removeEventListener("abort", onSigint);
  }
}

export async function runTypedTask(
  mappingId: string,
  deps: AgentRunsPaneDeps = {},
): Promise<StoredRun> {
  const prompt = deps.prompt ?? ask;
  const promptAnswer = await prompt("Task prompt: ");
  // A timed-out prompt must not start a billed run.
  if (promptAnswer === null) throw new PluginError("prompt_timed_out", "No task prompt was given.");
  const promptText = oneLinePrompt(promptAnswer);
  const defaultText = JSON.stringify(DEFAULT_RESPONSE_SCHEMA);
  const schemaInput = await prompt(`JSON Schema [${defaultText}]: `);
  if (schemaInput === null)
    throw new PluginError("prompt_timed_out", "No response schema was given.");
  const { json, schema } = responseSchemaFromJson(schemaInput);
  const { stored, result } = await executeTypedRun(mappingId, promptText, json, schema, deps);
  const write = deps.write ?? stdoutWriter;
  write(`\n${JSON.stringify(result, null, 2)}\n${formatCost(stored.cost)}\n`);
  if (stored.resultTruncated)
    write("Persisted result was truncated to the configured byte limit.\n");
  return stored;
}

function runLine(run: StoredRun): string {
  const schedule = run.scheduleId ? ` schedule ${run.scheduleId.slice(0, 10)}` : "";
  const cost = run.cost ? ` $${run.cost.totalUsd.toFixed(6)}` : "";
  return `${run.createdAt}  ${run.status.padEnd(9)}  ${run.source}${schedule}${cost}\n  ${run.prompt || "(no prompt)"}\n`;
}

export async function showRunResults(
  mappingId: string,
  deps: AgentRunsPaneDeps = {},
): Promise<StoredRun[]> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig({ env });
  const mapping = requireMappingById(mappingId, deps.state ?? { env });
  assertNativeAutomationMapping(mapping);
  const box = await (deps.openBox ?? openBox)(mapping, { client: deps.client, env });
  const remoteRuns = await box.listRuns();
  const auto = automationOptions(deps);
  await syncScheduledRuns(mapping, remoteRuns, {
    ...auto,
    historyLimit: config.runHistoryLimit,
    maxResultBytes: config.maxRunResultBytes,
  });
  await reconcileStaleRuns(mappingId, {
    ...auto,
    staleAfterMs: config.agentRunTimeoutMs + STALE_RUN_GRACE_MS,
    now: deps.now?.().getTime(),
  });
  const runs = runsForMapping(readAutomation(auto), mappingId);
  const write = deps.write ?? stdoutWriter;
  write(`Recent agent runs for ${mapping.boxName}\n\n`);
  if (runs.length === 0) write("No persisted runs.\n");
  for (const run of runs) {
    write(runLine(run));
    if (run.error) write(`  Error: ${run.error}\n`);
    if (run.result !== null) write(`  Result: ${JSON.stringify(run.result, null, 2)}\n`);
  }
  return runs;
}

export async function runAgentRunsPane(
  mode: string,
  mappingId: string,
  deps: AgentRunsPaneDeps = {},
): Promise<void> {
  if (mode === "task") {
    await runTypedTask(mappingId, deps);
    return;
  }
  if (mode === "results") {
    await showRunResults(mappingId, deps);
    return;
  }
  throw new PluginError("invalid_automation_mode", `Unknown agent-runs mode: ${mode}.`);
}
