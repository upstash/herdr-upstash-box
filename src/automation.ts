import fs from "node:fs";
import path from "node:path";
import type { BoxRunData, RunCost, Schedule } from "@upstash/box";
import { z } from "zod";
import { AUTOMATION_SCHEMA_VERSION } from "./constants.js";
import { PluginError } from "./result.js";
import { acquireLock, stateDirectory, type Mapping, type StateOptions } from "./state.js";

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

const costSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  computeMs: z.number().nonnegative(),
  totalUsd: z.number().nonnegative(),
});

export const storedRunSchema = z.object({
  id: z.string().min(1),
  mappingId: z.string().min(1),
  boxId: z.string().min(1),
  source: z.enum(["manual", "scheduled"]),
  scheduleId: z.string().min(1).nullable(),
  prompt: z.string(),
  responseSchema: jsonValue.nullable(),
  status: z.enum(["running", "completed", "failed", "cancelled", "detached", "skipped"]),
  result: jsonValue.nullable(),
  resultTruncated: z.boolean(),
  error: z.string().nullable(),
  cost: costSchema.nullable(),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});

export type StoredRun = z.infer<typeof storedRunSchema>;

export const storedScheduleSchema = z.object({
  id: z.string().min(1),
  mappingId: z.string().min(1),
  boxId: z.string().min(1),
  type: z.enum(["exec", "prompt"]),
  cron: z.string().min(1),
  prompt: z.string().nullable(),
  folder: z.string().nullable(),
  model: z.string().nullable(),
  timeout: z.number().int().positive().nullable(),
  status: z.enum(["active", "paused", "deleted"]),
  lastRunAt: z.string().datetime().nullable(),
  lastRunStatus: z.enum(["completed", "failed", "skipped"]).nullable(),
  totalRuns: z.number().int().nonnegative(),
  totalFailures: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type StoredSchedule = z.infer<typeof storedScheduleSchema>;

const automationSchema = z.object({
  schemaVersion: z.literal(AUTOMATION_SCHEMA_VERSION),
  runs: z.array(storedRunSchema),
  schedules: z.array(storedScheduleSchema),
});

export interface AutomationState {
  schemaVersion: typeof AUTOMATION_SCHEMA_VERSION;
  runs: StoredRun[];
  schedules: StoredSchedule[];
}

export type AutomationOptions = StateOptions;

export function emptyAutomation(): AutomationState {
  return { schemaVersion: AUTOMATION_SCHEMA_VERSION, runs: [], schedules: [] };
}

export function validateAutomation(candidate: unknown): AutomationState {
  const version =
    candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? (candidate as Record<string, unknown>).schemaVersion
      : undefined;
  if (version !== AUTOMATION_SCHEMA_VERSION) {
    throw new PluginError(
      version === undefined ? "invalid_automation_state" : "unsupported_automation_version",
      version === undefined
        ? "Automation state must contain a schemaVersion."
        : `Unsupported automation schema: ${String(version)}.`,
    );
  }
  const parsed = automationSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PluginError(
      "invalid_automation_state",
      `automation.json is invalid: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function automationPath(directory?: string, env?: NodeJS.ProcessEnv): string {
  return path.join(directory ?? stateDirectory(env), "automation.json");
}

export function readAutomation(options: AutomationOptions = {}): AutomationState {
  const file = options.file ?? automationPath(options.directory, options.env);
  if (!fs.existsSync(file)) return emptyAutomation();
  try {
    return validateAutomation(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(
      "invalid_automation_state",
      `Could not read ${file}: ${(error as Error).message}`,
    );
  }
}

export type AutomationChange = (
  state: AutomationState,
) => AutomationState | void | Promise<AutomationState | void>;

export async function updateAutomation(
  change: AutomationChange,
  options: AutomationOptions = {},
): Promise<AutomationState> {
  const directory = options.directory ?? stateDirectory(options.env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = options.file ?? path.join(directory, "automation.json");
  const lockPath = `${file}.lock`;
  const lock = await acquireLock(lockPath);
  let temporary: string | null = null;
  try {
    const draft = structuredClone(readAutomation({ file }));
    const next = (await change(draft)) ?? draft;
    validateAutomation(next);
    temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    temporary = null;
    return next;
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

function epochToIso(value: number | undefined): string | null {
  if (value === undefined) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

export function boundedResult(
  result: unknown,
  maxBytes: number,
): { result: unknown; resultTruncated: boolean } {
  const serialized = JSON.stringify(result);
  if (serialized === undefined) return { result: null, resultTruncated: false };
  if (Buffer.byteLength(serialized) <= maxBytes) return { result, resultTruncated: false };
  const source = Buffer.from(serialized);
  let low = 0;
  let high = Math.min(source.length, maxBytes);
  let text = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${source
      .subarray(0, middle)
      .toString("utf8")
      .replace(/\uFFFD+$/u, "")}…`;
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      text = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return { result: text, resultTruncated: true };
}

export async function storeRun(
  run: StoredRun,
  options: AutomationOptions & { historyLimit: number; replaceId?: string },
): Promise<void> {
  await updateAutomation((state) => {
    state.runs = [
      run,
      ...state.runs.filter((entry) => entry.id !== run.id && entry.id !== options.replaceId),
    ];
    const keptForMapping = new Set(
      state.runs
        .filter((entry) => entry.mappingId === run.mappingId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, options.historyLimit)
        .map((entry) => entry.id),
    );
    state.runs = state.runs.filter(
      (entry) => entry.mappingId !== run.mappingId || keptForMapping.has(entry.id),
    );
  }, options);
}

function runCost(run: BoxRunData): RunCost {
  return {
    inputTokens: run.input_tokens,
    outputTokens: run.output_tokens,
    cachedInputTokens: run.cached_input_tokens ?? 0,
    computeMs: run.duration_ms,
    totalUsd: run.cost_usd,
  };
}

export function storedScheduledRun(
  mapping: Pick<Mapping, "id" | "boxId">,
  run: BoxRunData & { schedule_id: string },
  maxResultBytes: number,
): StoredRun {
  const bounded = boundedResult(run.output ?? null, maxResultBytes);
  return {
    id: run.id,
    mappingId: mapping.id,
    boxId: mapping.boxId ?? run.box_id,
    source: "scheduled",
    scheduleId: run.schedule_id,
    prompt: run.prompt ?? "",
    responseSchema: null,
    status: run.status,
    result: bounded.result,
    resultTruncated: bounded.resultTruncated,
    error: run.error_message ?? null,
    cost: runCost(run),
    createdAt: epochToIso(run.created_at) ?? new Date().toISOString(),
    completedAt: epochToIso(run.completed_at),
  };
}

export async function syncScheduledRuns(
  mapping: Pick<Mapping, "id" | "boxId">,
  runs: BoxRunData[],
  options: AutomationOptions & { historyLimit: number; maxResultBytes: number },
): Promise<void> {
  const scheduled = runs.filter(
    (run): run is BoxRunData & { schedule_id: string } => typeof run.schedule_id === "string",
  );
  if (scheduled.length === 0) return;
  await updateAutomation((state) => {
    const byId = new Map(state.runs.map((run) => [run.id, run]));
    for (const run of scheduled) {
      byId.set(run.id, storedScheduledRun(mapping, run, options.maxResultBytes));
    }
    state.runs = [...byId.values()];
    const keep = new Set(
      state.runs
        .filter((run) => run.mappingId === mapping.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, options.historyLimit)
        .map((run) => run.id),
    );
    state.runs = state.runs.filter((run) => run.mappingId !== mapping.id || keep.has(run.id));
  }, options);
}

export function storedSchedule(mappingId: string, schedule: Schedule): StoredSchedule {
  return {
    id: schedule.id,
    mappingId,
    boxId: schedule.box_id,
    type: schedule.type,
    cron: schedule.cron,
    prompt: schedule.prompt ?? null,
    folder: schedule.folder ?? null,
    model: schedule.model ?? null,
    timeout: schedule.timeout ?? null,
    status: schedule.status,
    lastRunAt: epochToIso(schedule.last_run_at),
    lastRunStatus: schedule.last_run_status ?? null,
    totalRuns: schedule.total_runs,
    totalFailures: schedule.total_failures,
    createdAt: epochToIso(schedule.created_at) ?? new Date().toISOString(),
    updatedAt: epochToIso(schedule.updated_at) ?? new Date().toISOString(),
  };
}

export async function syncSchedules(
  mappingId: string,
  schedules: Schedule[],
  options: AutomationOptions = {},
): Promise<void> {
  await updateAutomation((state) => {
    const liveIds = new Set(schedules.map((schedule) => schedule.id));
    state.schedules = [
      ...state.schedules.filter(
        (schedule) => schedule.mappingId !== mappingId || liveIds.has(schedule.id),
      ),
    ];
    const byId = new Map(state.schedules.map((schedule) => [schedule.id, schedule]));
    for (const schedule of schedules) byId.set(schedule.id, storedSchedule(mappingId, schedule));
    state.schedules = [...byId.values()];
  }, options);
}

export function runsForMapping(state: AutomationState, mappingId: string): StoredRun[] {
  return state.runs
    .filter((run) => run.mappingId === mappingId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function schedulesForMapping(state: AutomationState, mappingId: string): StoredSchedule[] {
  return state.schedules
    .filter((schedule) => schedule.mappingId === mappingId && schedule.status !== "deleted")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function removeAutomationForMapping(
  mappingId: string,
  options: AutomationOptions = {},
): Promise<void> {
  await updateAutomation((state) => {
    state.runs = state.runs.filter((run) => run.mappingId !== mappingId);
    state.schedules = state.schedules.filter((schedule) => schedule.mappingId !== mappingId);
  }, options);
}

export function assertNativeAutomationMapping(mapping: Pick<Mapping, "mode" | "boxName">): void {
  if (mapping.mode !== "native") {
    throw new PluginError(
      "automation_requires_native_mode",
      `Server-side runs and schedules require a native-mode box. ${mapping.boxName} uses TUI mode.`,
    );
  }
}

export function runInFlight(
  state: AutomationState,
  mappingId: string,
  staleAfterMs: number,
  nowMs = Date.now(),
): StoredRun | null {
  return (
    state.runs.find(
      (run) =>
        run.mappingId === mappingId &&
        run.source === "manual" &&
        run.status === "running" &&
        nowMs - Date.parse(run.createdAt) < staleAfterMs,
    ) ?? null
  );
}

// A placeholder that outlived its timeout belongs to a pane that never came back.
export async function reconcileStaleRuns(
  mappingId: string,
  options: AutomationOptions & { staleAfterMs: number; now?: number },
): Promise<number> {
  const nowMs = options.now ?? Date.now();
  let reconciled = 0;
  await updateAutomation((state) => {
    for (const run of state.runs) {
      if (
        run.mappingId === mappingId &&
        run.source === "manual" &&
        run.status === "running" &&
        nowMs - Date.parse(run.createdAt) >= options.staleAfterMs
      ) {
        run.status = "failed";
        run.error =
          "The run never reported back. The box may have been paused, stopped, or deleted while it ran.";
        run.completedAt = new Date(nowMs).toISOString();
        reconciled += 1;
      }
    }
  }, options);
  return reconciled;
}
