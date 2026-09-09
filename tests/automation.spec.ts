import fs from "node:fs";
import path from "node:path";
import type { BoxRunData, Run, Schedule } from "@upstash/box";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundedResult,
  emptyAutomation,
  readAutomation,
  runsForMapping,
  storeRun,
  syncScheduledRuns,
  updateAutomation,
  validateAutomation,
  type StoredRun,
} from "../src/automation.js";
import { DEFAULT_CONFIG, validateConfig } from "../src/config.js";
import {
  DEFAULT_RESPONSE_SCHEMA,
  describeFailure,
  responseSchemaFromJson,
  runTypedTask,
  showRunResults,
} from "../src/panes/agent-runs.js";
import { runDashboardPane } from "../src/panes/dashboard.js";
import {
  parseScheduleCommand,
  resolveScheduleId,
  runSchedulesPane,
} from "../src/panes/schedules.js";
import { updateState, withMappingLock } from "../src/state.js";
import {
  fakeBox,
  fakeClient,
  MAPPING_ID,
  remove,
  sampleMapping,
  temporaryDirectory,
} from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

async function nativeState() {
  const directory = temporaryDirectory();
  directories.push(directory);
  await updateState(
    (state) => {
      state.mappings[MAPPING_ID] = sampleMapping({ mode: "native" });
    },
    { directory },
  );
  return { directory };
}

function storedRun(id: string, mappingId = MAPPING_ID): StoredRun {
  return {
    id,
    mappingId,
    boxId: "box-1",
    source: "manual",
    scheduleId: null,
    prompt: id,
    responseSchema: DEFAULT_RESPONSE_SCHEMA,
    status: "completed",
    result: { answer: id },
    resultTruncated: false,
    error: null,
    cost: null,
    createdAt: `2026-09-09T10:00:${id.padStart(2, "0")}.000Z`,
    completedAt: `2026-09-09T10:00:${id.padStart(2, "0")}.000Z`,
  };
}

describe("automation state", () => {
  it("validates schema v1 and rejects malformed records", () => {
    expect(validateAutomation(emptyAutomation())).toEqual(emptyAutomation());
    expect(() => validateAutomation({ schemaVersion: 2, runs: [], schedules: [] })).toThrow(
      /Unsupported automation schema/,
    );
    expect(() =>
      validateAutomation({ schemaVersion: 1, runs: [{ id: "bad" }], schedules: [] }),
    ).toThrow(/automation.json is invalid/);
  });

  it("writes privately and atomically under concurrent updates", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    await Promise.all([
      updateAutomation((state) => void state.runs.push(storedRun("1")), { directory }),
      updateAutomation((state) => void state.runs.push(storedRun("2")), { directory }),
    ]);
    expect(readAutomation({ directory }).runs).toHaveLength(2);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(directory, "automation.json")).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("prunes history per mapping without pruning other mappings", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    await storeRun(storedRun("1"), { directory, historyLimit: 2 });
    await storeRun(storedRun("2"), { directory, historyLimit: 2 });
    await storeRun(storedRun("3"), { directory, historyLimit: 2 });
    await storeRun(storedRun("4", "other"), { directory, historyLimit: 2 });
    expect(runsForMapping(readAutomation({ directory }), MAPPING_ID).map((run) => run.id)).toEqual([
      "3",
      "2",
    ]);
    expect(runsForMapping(readAutomation({ directory }), "other")).toHaveLength(1);
  });

  it("caps serialized result bytes and marks truncation", () => {
    const bounded = boundedResult({ answer: "x".repeat(1000) }, 80);
    expect(bounded.resultTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(bounded.result))).toBeLessThanOrEqual(80);
    expect(boundedResult({ answer: "ok" }, 80)).toEqual({
      result: { answer: "ok" },
      resultTruncated: false,
    });
  });
});

describe("typed runs", () => {
  it("converts JSON Schema with the strict answer default and names errors", () => {
    const converted = responseSchemaFromJson("");
    expect(converted.json).toEqual(DEFAULT_RESPONSE_SCHEMA);
    expect(converted.schema.parse({ answer: "yes" })).toEqual({ answer: "yes" });
    expect(() => converted.schema.parse({ answer: "yes", extra: true })).toThrow();
    expect(() => responseSchemaFromJson("{")).toThrow(/Invalid JSON Schema JSON/);
    expect(() => responseSchemaFromJson('{"type":"not-real"}')).toThrow(/Unsupported JSON Schema/);
  });

  it("runs from the mapped cwd, reports tools and persists typed result and cost", async () => {
    const state = await nativeState();
    const output: string[] = [];
    const { box, calls } = fakeBox({
      agentRun: async (options) => {
        options.onToolUse?.({ name: "Read", input: { file: "README.md" } });
        options.onToolResult?.({ output: "done" });
        return {
          id: "run-typed",
          status: "completed",
          result: { answer: "42" },
          cost: {
            inputTokens: 12,
            outputTokens: 3,
            cachedInputTokens: 2,
            computeMs: 50,
            totalUsd: 0.004,
          },
        } as Run<unknown>;
      },
    });
    const answers = ["What is the answer?", ""];
    const run = await runTypedTask(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      ensureRunning: async () => ({ status: "running", resumed: false }),
      prompt: async () => answers.shift() ?? "",
      write: (chunk) => void output.push(chunk),
    });
    expect(calls.cds).toEqual(["/workspace/home"]);
    expect(calls.agentRuns[0]).not.toHaveProperty("folder");
    expect(calls.agentRuns[0]).toMatchObject({ timeout: 600_000, maxRetries: 0 });
    expect(run.result).toEqual({ answer: "42" });
    expect(readAutomation(state).runs[0]).toMatchObject({
      id: "run-typed",
      result: { answer: "42" },
      cost: { totalUsd: 0.004 },
    });
    expect(output.join("")).toContain("Read");
    expect(output.join("")).toContain("Cost: $0.004000");
  });

  it("persists failed attempts", async () => {
    const state = await nativeState();
    const { box } = fakeBox({
      agentRun: async () => {
        throw new Error("provider unavailable");
      },
    });
    const answers = ["Do work", ""];
    await expect(
      runTypedTask(MAPPING_ID, {
        state,
        config: { ...DEFAULT_CONFIG, mode: "native" },
        env: { UPSTASH_BOX_API_KEY: "k" },
        client: fakeClient({ "box-1": box }),
        ensureRunning: async () => ({ status: "running", resumed: false }),
        prompt: async () => answers.shift() ?? "",
        write: () => undefined,
      }),
    ).rejects.toThrow(/provider unavailable/);
    expect(readAutomation(state).runs[0]).toMatchObject({
      status: "failed",
      error: "provider unavailable",
      prompt: "Do work",
    });
  });

  it("shows the complete typed result while bounding only the persisted copy", async () => {
    const state = await nativeState();
    const answer = "complete-result-".repeat(20);
    const { box } = fakeBox({
      agentRun: async () =>
        ({
          id: "run-large",
          status: "completed",
          result: { answer },
          cost: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            computeMs: 1,
            totalUsd: 0.001,
          },
        }) as Run<unknown>,
    });
    const answers = ["Return a large answer", ""];
    const output: string[] = [];
    await runTypedTask(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native", maxRunResultBytes: 80 },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      ensureRunning: async () => ({ status: "running", resumed: false }),
      prompt: async () => answers.shift() ?? "",
      write: (chunk) => void output.push(chunk),
    });
    expect(output.join("")).toContain(answer);
    expect(readAutomation(state).runs[0]).toMatchObject({ resultTruncated: true });
  });

  it("syncs scheduled Box run records as untyped output", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const run: BoxRunData = {
      id: "scheduled-run",
      box_id: "box-1",
      customer_id: "customer",
      type: "agent",
      schedule_id: "schedule-1",
      status: "completed",
      prompt: "nightly",
      output: '{"answer":"plain text"}',
      input_tokens: 2,
      output_tokens: 3,
      cost_usd: 0.01,
      duration_ms: 20,
      created_at: 1_757_412_000,
      completed_at: 1_757_412_001,
    };
    await syncScheduledRuns(sampleMapping({ mode: "native" }), [run], {
      directory,
      historyLimit: 50,
      maxResultBytes: 1000,
    });
    expect(readAutomation({ directory }).runs[0]).toMatchObject({
      source: "scheduled",
      responseSchema: null,
      result: '{"answer":"plain text"}',
    });
  });
});

function schedule(id: string, status: "active" | "paused" = "active"): Schedule {
  return {
    id,
    box_id: "box-1",
    type: "prompt",
    cron: "0 9 * * *",
    prompt: "check",
    status,
    total_runs: 0,
    total_failures: 0,
    created_at: 1_757_412_000,
    updated_at: 1_757_412_000,
  };
}

describe("schedules", () => {
  it("parses commands and resolves exact or unique prefixes", () => {
    expect(parseScheduleCommand("c 0 9 * * * | run tests")).toEqual({
      kind: "create",
      cron: "0 9 * * *",
      prompt: "run tests",
    });
    const listed = [schedule("abc-1"), schedule("abc-2"), schedule("xyz")];
    expect(resolveScheduleId(listed, "abc-1")).toBe("abc-1");
    expect(resolveScheduleId(listed, "x")).toBe("xyz");
    expect(() => resolveScheduleId(listed, "abc")).toThrow(/ambiguous/);
    expect(() => resolveScheduleId(listed, "none")).toThrow(/No schedule/);
  });

  it("creates on an idle-pausing box with mapped folder, model and timeout", async () => {
    const state = await nativeState();
    const { box, calls } = fakeBox({ keepAlive: false });
    const answers = ["c 0 9 * * * | run tests", "q"];
    await runSchedulesPane(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      prompt: async () => answers.shift() ?? "q",
      write: () => undefined,
    });
    expect(calls.scheduleAgents[0]).toEqual({
      cron: "0 9 * * *",
      prompt: "run tests",
      folder: "/workspace/home",
      model: "anthropic/claude-sonnet-5",
      timeout: 600_000,
    });
    expect(readAutomation(state).schedules[0]).toMatchObject({ status: "active" });
  });

  it("does not hold the mapping lock while waiting for delete confirmation", async () => {
    const state = await nativeState();
    const { box, calls } = fakeBox({ schedules: [schedule("schedule-long")] });
    const answers = ["d schedule", "q"];
    let confirmedOutsideLock = false;
    await runSchedulesPane(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      prompt: async (question) => {
        if (question.startsWith("Type DELETE")) {
          await withMappingLock(MAPPING_ID, state, async () => {
            confirmedOutsideLock = true;
          });
          return "DELETE";
        }
        return answers.shift() ?? "q";
      },
      write: () => undefined,
    });
    expect(confirmedOutsideLock).toBe(true);
    expect(calls.scheduleDeleted).toEqual(["schedule-long"]);
  });

  it("pauses, resumes, and confirms deletion by unique prefix", async () => {
    const state = await nativeState();
    const { box, calls } = fakeBox({ schedules: [schedule("schedule-long")] });
    const answers = ["p schedule", "r schedule", "d schedule", "DELETE", "q"];
    await runSchedulesPane(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      prompt: async () => answers.shift() ?? "q",
      write: () => undefined,
    });
    expect(calls.schedulePaused).toEqual(["schedule-long"]);
    expect(calls.scheduleResumed).toEqual(["schedule-long"]);
    expect(calls.scheduleDeleted).toEqual(["schedule-long"]);
  });
});

describe("automation config", () => {
  it("validates Phase 4 defaults and has no retry knob, since a retry cannot be told from a cancelled run", () => {
    expect(DEFAULT_CONFIG).toMatchObject({
      agentRunTimeoutMs: 600_000,
      scheduleTimeoutMs: 600_000,
      maxRunResultBytes: 262_144,
      runHistoryLimit: 50,
    });
    expect(DEFAULT_CONFIG).not.toHaveProperty("agentRunMaxRetries");
    expect(() => validateConfig({ agentRunMaxRetries: 0 })).toThrow(/Unknown config keys/);
    expect(() => validateConfig({ runHistoryLimit: 0 })).toThrow(/positive integer/);
  });
});

describe("review fixes", () => {
  function hangingBox(runId = "run-live") {
    let finish: (value: Run<unknown>) => void = () => undefined;
    const fake = fakeBox({
      agentRun: () =>
        new Promise<Run<unknown>>((resolve) => {
          finish = resolve;
        }),
      runs: [
        {
          id: runId,
          box_id: "box-1",
          customer_id: "c",
          type: "agent",
          status: "running",
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          duration_ms: 0,
          created_at: Date.now(),
        } as BoxRunData,
      ],
    });
    return { ...fake, finish: (value: Run<unknown>) => finish(value) };
  }
  const completed = (id: string): Run<unknown> =>
    ({
      id,
      status: "completed",
      result: { answer: "done" },
      cost: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, computeMs: 1, totalUsd: 0 },
    }) as Run<unknown>;
  const deps = (
    state: { directory: string },
    box: ReturnType<typeof fakeBox>["box"],
    extra: Record<string, unknown> = {},
  ) => ({
    state,
    config: { ...DEFAULT_CONFIG, mode: "native" as const },
    env: { UPSTASH_BOX_API_KEY: "k" },
    client: fakeClient({ "box-1": box }),
    ensureRunning: async () => ({ status: "running" as const, resumed: false }),
    write: () => undefined,
    signals: { once() {}, off() {} },
    graceMs: 10,
    ...extra,
  });
  const answers = () => {
    const queue = ["Long task", ""];
    return async () => queue.shift() ?? "";
  };

  it("does not hold the mapping lock during the model call and replaces its placeholder", async () => {
    const state = await nativeState();
    const { box, finish } = hangingBox();
    const running = runTypedTask(MAPPING_ID, deps(state, box, { prompt: answers() }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await withMappingLock(MAPPING_ID, state, async () => "free")).toBe("free");
    expect(readAutomation(state).runs[0]).toMatchObject({ status: "running", prompt: "Long task" });
    finish(completed("run-live"));
    const stored = await running;
    expect(stored.id).toBe("run-live");
    const runs = readAutomation(state).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: "run-live", status: "completed" });
  });

  it("refuses a second typed run while one is in flight", async () => {
    const state = await nativeState();
    const { box, finish } = hangingBox();
    const first = runTypedTask(MAPPING_ID, deps(state, box, { prompt: answers() }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      runTypedTask(MAPPING_ID, deps(state, box, { prompt: answers() })),
    ).rejects.toMatchObject({ code: "run_in_progress" });
    finish(completed("run-live"));
    await first;
  });

  it("cancels an in-flight run through its box run id and ignores a late result", async () => {
    const state = await nativeState();
    const { box, calls, finish } = hangingBox("run-live");
    const cancel = new AbortController();
    const output: string[] = [];
    const running = runTypedTask(
      MAPPING_ID,
      deps(state, box, {
        prompt: answers(),
        cancel: cancel.signal,
        write: (chunk: string) => void output.push(chunk),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancel.abort();
    await expect(running).rejects.toMatchObject({ code: "run_cancelled" });
    expect(calls.requests).toEqual(["POST /v2/box/box-1/runs/run-live/cancel"]);
    expect(readAutomation(state).runs[0]).toMatchObject({ status: "cancelled" });
    expect(output.join("")).toContain("Press Ctrl-C to cancel");
    finish(completed("run-live"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(readAutomation(state).runs.map((run) => run.status)).toEqual(["cancelled"]);
  });

  it("marks a placeholder that never came back as failed when results are shown", async () => {
    const state = await nativeState();
    const stale = {
      ...storedRun("stale"),
      status: "running" as const,
      completedAt: null,
      createdAt: "2026-09-09T08:00:00.000Z",
    };
    await storeRun(stale, { ...state, historyLimit: 10 });
    const runs = await showRunResults(
      MAPPING_ID,
      deps(state, fakeBox().box, { now: () => new Date("2026-09-09T10:00:00.000Z") }),
    );
    expect(runs[0]).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/never reported back/),
    });
  });

  it("stores a readable error for a failed typed run", async () => {
    const state = await nativeState();
    const { box } = fakeBox({
      agentRun: async () =>
        ({
          id: "run-bad",
          status: "failed",
          result: { reason: "quota" },
          cost: {
            inputTokens: 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            computeMs: 1,
            totalUsd: 0,
          },
        }) as Run<unknown>,
    });
    await runTypedTask(MAPPING_ID, deps(state, box, { prompt: answers() }));
    expect(readAutomation(state).runs[0]?.error).toBe('{"reason":"quota"}');
    expect(describeFailure(undefined)).toMatch(/without a message/);
    expect(boundedResult(undefined, 10)).toEqual({ result: null, resultTruncated: false });
  });

  it("refuses an unprepared mapping before touching the box, for runs and schedules", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    await updateState(
      (state) => {
        state.mappings[MAPPING_ID] = sampleMapping({ mode: "native", prepared: false });
      },
      { directory },
    );
    const { box, calls } = fakeBox();
    await expect(
      runTypedTask(MAPPING_ID, deps({ directory }, box, { prompt: answers() })),
    ).rejects.toMatchObject({ code: "mapping_not_prepared" });
    expect(calls.agentRuns).toEqual([]);
    const output: string[] = [];
    const queue = ["c * * * * * | tick", "", ""];
    await runSchedulesPane(MAPPING_ID, {
      state: { directory },
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      prompt: async () => queue.shift() ?? "",
      write: (chunk) => void output.push(chunk),
    });
    expect(output.join("")).toContain("no upload baseline");
    expect(calls.schedulesCreated ?? []).toEqual([]);
  });

  it("keeps the dashboard usable when the history file is corrupt", async () => {
    const state = await nativeState();
    fs.writeFileSync(path.join(state.directory, "automation.json"), "{ not json");
    const frames: string[] = [];
    async function* keys(): AsyncIterable<string> {
      yield "q";
    }
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      context: {},
      openPane: () => ({ status: 0, stdout: "", stderr: "" }),
      write: (chunk) => void frames.push(chunk),
      keys: keys(),
      listBoxes: async () => [],
      refreshMs: 0,
    });
    expect(frames.at(-1)).toContain("Run history unreadable");
    expect(frames.at(-1)).toContain(sampleMapping().boxName);
  });
});

describe("cancel race", () => {
  it("records a cancellation even when the SDK stream errors first", async () => {
    const state = await nativeState();
    let reject: (error: Error) => void = () => undefined;
    const fake = fakeBox({
      agentRun: () =>
        new Promise<Run<unknown>>((_resolve, fail) => {
          reject = fail;
        }),
      runs: [
        {
          id: "run-race",
          box_id: "box-1",
          customer_id: "c",
          type: "agent",
          status: "running",
          input_tokens: 0,
          output_tokens: 0,
          cost_usd: 0,
          duration_ms: 0,
          created_at: Date.now(),
        } as BoxRunData,
      ],
    });
    const box = fake.box as unknown as {
      _request: (method: string, url: string) => Promise<unknown>;
    };
    const original = box._request;
    box._request = async (method, url) => {
      const result = await original.call(box, method, url);
      reject(new Error("Failed to parse structured output: Unexpected end of JSON input"));
      return result;
    };
    const cancel = new AbortController();
    const queue = ["Long task", ""];
    const running = runTypedTask(MAPPING_ID, {
      state,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": fake.box }),
      ensureRunning: async () => ({ status: "running", resumed: false }),
      prompt: async () => queue.shift() ?? "",
      write: () => undefined,
      signals: { once() {}, off() {} },
      cancel: cancel.signal,
      graceMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    cancel.abort();
    await expect(running).rejects.toMatchObject({ code: "run_cancelled" });
    expect(fake.calls.requests).toEqual(["POST /v2/box/box-1/runs/run-race/cancel"]);
    expect(readAutomation(state).runs.map((run) => run.status)).toEqual(["cancelled"]);
  });
});
