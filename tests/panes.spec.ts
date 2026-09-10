import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { readAutomation, updateAutomation } from "../src/automation.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { runAgentPane } from "../src/panes/agent.js";
import { runConfirmationPane } from "../src/panes/confirmation.js";
import {
  boxCli,
  bundledBoxCli,
  childEnvironment,
  runNativePane,
  type SpawnFn,
} from "../src/panes/native.js";
import {
  applyChanges,
  pauseMapping,
  resumeMapping,
  showInfo,
  snapshotMapping,
  stopMapping,
} from "../src/panes/operation.js";
import { paneTitle, runStartPane } from "../src/panes/start.js";
import { runSync } from "../src/process.js";
import type { Attached, AttachOptions } from "../src/session.js";
import { readState, removeMapping, updateState } from "../src/state.js";
import {
  COMMIT_A,
  fakeBox,
  fakeClient,
  fakeHandle,
  listing,
  makeGitRepository,
  MAPPING_ID,
  remove,
  sampleMapping,
  temporaryDirectory,
  write,
} from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

async function stateWith(...mappings: ReturnType<typeof sampleMapping>[]) {
  const directory = temporaryDirectory();
  directories.push(directory);
  await updateState(
    (state) => {
      for (const mapping of mappings) state.mappings[mapping.id] = mapping;
    },
    { directory },
  );
  return { directory };
}

function collector() {
  const lines: string[] = [];
  return { lines, write: (chunk: string) => void lines.push(chunk) };
}

const quiet = () => undefined;
const BASELINE = "c".repeat(40);
const NEXT = "d".repeat(40);
const sha256 = (buffer: Buffer): string => crypto.createHash("sha256").update(buffer).digest("hex");

const tuiEnv = {
  UPSTASH_BOX_API_KEY: "box-key",
  ANTHROPIC_API_KEY: "provider-secret",
  HERDR_PANE_ID: "pane-9",
};

const fakeAttach = async (_box: unknown, _options: AttachOptions): Promise<Attached> => ({
  handle: fakeHandle(0),
  server: "s",
  session: "s",
  reattached: false,
});

const live = async () => ({ status: "running" as const, resumed: false });

describe("runAgentPane", () => {
  it("never reads a Claude credential name from config into a Codex reconnect", async () => {
    const state = await stateWith(
      sampleMapping({ harness: "codex", model: "openai/gpt-5.6", everAttached: true }),
    );
    const { box } = fakeBox();
    let attachOptions: AttachOptions | undefined;
    const code = await runAgentPane(MAPPING_ID, {
      env: {
        ...tuiEnv,
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-token",
        OPENAI_API_KEY: "openai-secret",
      },
      state,
      // What setup writes after choosing the subscription, before a start-codex launch.
      config: { ...DEFAULT_CONFIG, providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN" },
      client: fakeClient({ "box-1": box }),
      attach: async (target, options) => {
        attachOptions = options;
        return fakeAttach(target, options);
      },
      bridge: async () => 0,
      write: quiet,
      ensureRunning: live,
    });
    expect(code).toBe(0);
    expect(attachOptions?.credential).toEqual({ name: "OPENAI_API_KEY", value: "openai-secret" });
  });

  it("resumes the box, attaches with the mapping's history, and records the outcome", async () => {
    const state = await stateWith(sampleMapping({ everAttached: true }));
    const { box, calls } = fakeBox({ statuses: ["paused", "running"] });
    const client = fakeClient({ "box-1": box });
    let attachOptions: AttachOptions | undefined;
    let midSession: ReturnType<typeof sampleMapping> | undefined;
    const output = collector();
    const code = await runAgentPane(MAPPING_ID, {
      env: tuiEnv,
      state,
      config: { ...DEFAULT_CONFIG, agentArgs: ["--verbose"] },
      client,
      attach: async (target, options) => {
        attachOptions = options;
        return fakeAttach(target, options);
      },
      bridge: async () => {
        midSession = readState(state).mappings[MAPPING_ID];
        return 0;
      },
      write: output.write,
      ensureRunning: async (target, options) => {
        options?.onResume?.();
        await target.resume();
        return { status: "running", resumed: true };
      },
      size: { rows: 50, cols: 160 },
    });
    expect(code).toBe(0);
    expect(calls.resumed).toBe(1);
    expect(output.lines.join("")).toContain("Resuming");
    expect(attachOptions).toMatchObject({
      harnessId: "claude-code",
      model: "anthropic/claude-sonnet-5",
      credential: { name: "ANTHROPIC_API_KEY", value: "provider-secret" },
      cwd: "/workspace/home",
      resume: true,
      rows: 50,
      cols: 160,
      agentArgs: ["--verbose"],
    });
    expect(midSession?.lifecycleState).toBe("connected");
    expect(midSession?.remotePaneId).toBe("pane-9");
    expect(midSession?.connectionId).toEqual(expect.any(String));
    const after = readState(state).mappings[MAPPING_ID];
    expect(after).toMatchObject({
      lifecycleState: "ready",
      remotePaneId: null,
      connectionId: null,
      everAttached: true,
      lastError: null,
    });
  });

  it("lets a stop issued during the session win over the pane's own exit", async () => {
    const state = await stateWith(sampleMapping());
    const { box } = fakeBox({ commandOutput: () => ({ stdout: "STOPPED\n" }) });
    const client = fakeClient({ "box-1": box });
    const code = await runAgentPane(MAPPING_ID, {
      env: tuiEnv,
      state,
      config: DEFAULT_CONFIG,
      client,
      attach: fakeAttach,
      ensureRunning: live,
      bridge: async () => {
        await stopMapping(MAPPING_ID, {
          state,
          env: tuiEnv,
          client,
          closePane: quiet,
          write: quiet,
        });
        return 0;
      },
      write: quiet,
    });
    expect(code).toBe(0);
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "stopped",
      connectionId: null,
      remotePaneId: null,
    });
  });

  it("finishes quietly when the mapping was deleted during the session", async () => {
    const state = await stateWith(sampleMapping());
    const code = await runAgentPane(MAPPING_ID, {
      env: tuiEnv,
      state,
      config: DEFAULT_CONFIG,
      client: fakeClient({ "box-1": fakeBox().box }),
      attach: fakeAttach,
      ensureRunning: live,
      bridge: async () => {
        await removeMapping(MAPPING_ID, state);
        return 0;
      },
      write: quiet,
    });
    expect(code).toBe(0);
    expect(readState(state).mappings).toEqual({});
  });

  it("resets the connection when the transport fails mid-session", async () => {
    const state = await stateWith(sampleMapping());
    await expect(
      runAgentPane(MAPPING_ID, {
        env: tuiEnv,
        state,
        config: DEFAULT_CONFIG,
        client: fakeClient({ "box-1": fakeBox().box }),
        attach: fakeAttach,
        ensureRunning: live,
        bridge: async () => {
          throw new Error("socket closed");
        },
        write: quiet,
      }),
    ).rejects.toThrow(/socket closed/);
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "ready",
      remotePaneId: null,
      connectionId: null,
      lastError: "socket closed",
    });
  });

  it("recovers a crashed start: finds the box by label, finishes preparation, then attaches", async () => {
    const root = makeGitRepository();
    directories.push(root);
    const mapping = sampleMapping({
      boxId: null,
      prepared: false,
      lifecycleState: "creating",
      localRoot: root,
      localCwd: root,
      lastAppliedExportCommit: null,
    });
    const state = await stateWith(mapping);
    const { box, calls } = fakeBox({
      id: "box-7",
      commandOutput: (command) => ({
        stdout: command.includes("git rev-parse HEAD") ? `${BASELINE}\n` : "TMUX_READY\n",
      }),
    });
    const client = fakeClient({ "box-7": box }, listing([{ id: "box-7", name: mapping.boxName }]));
    let attachedCwd: string | undefined;
    const output = collector();
    const code = await runAgentPane(MAPPING_ID, {
      env: tuiEnv,
      state,
      config: DEFAULT_CONFIG,
      client,
      attach: async (target, options) => {
        attachedCwd = options.cwd;
        return fakeAttach(target, options);
      },
      ensureRunning: live,
      bridge: async () => 0,
      write: output.write,
    });
    expect(code).toBe(0);
    expect(attachedCwd).toBe("/workspace/home");
    expect(calls.uploads).toHaveLength(1);
    expect(output.lines.join("")).toContain("Uploading the worktree");
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      boxId: "box-7",
      prepared: true,
      lastAppliedExportCommit: BASELINE,
      uploadDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      lifecycleState: "ready",
    });
  });

  it("stops when another pane claims the mapping while it is still preparing", async () => {
    const state = await stateWith(sampleMapping());
    await expect(
      runAgentPane(MAPPING_ID, {
        env: tuiEnv,
        state,
        config: DEFAULT_CONFIG,
        client: fakeClient({ "box-1": fakeBox().box }),
        attach: fakeAttach,
        ensureRunning: async () => {
          await updateState((draft) => {
            const current = draft.mappings[MAPPING_ID];
            if (current) current.connectionId = "another-pane";
          }, state);
          return { status: "running", resumed: false };
        },
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "connection_superseded" });
    expect(readState(state).mappings[MAPPING_ID]?.connectionId).toBe("another-pane");
  });

  it("marks a deleted box missing and a broken attach failed", async () => {
    const gone = await stateWith(sampleMapping());
    const client = fakeClient({ "box-1": fakeBox({ statuses: ["deleted"] }).box });
    await expect(
      runAgentPane(MAPPING_ID, { env: tuiEnv, state: gone, config: DEFAULT_CONFIG, client }),
    ).rejects.toThrow(/deleted/);
    expect(readState(gone).mappings[MAPPING_ID]?.lifecycleState).toBe("missing");

    const broken = await stateWith(sampleMapping());
    await expect(
      runAgentPane(MAPPING_ID, {
        env: tuiEnv,
        state: broken,
        config: DEFAULT_CONFIG,
        client: fakeClient({ "box-1": fakeBox().box }),
        ensureRunning: live,
        attach: async () => {
          throw new Error("websocket refused");
        },
      }),
    ).rejects.toThrow(/websocket refused/);
    expect(readState(broken).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "failed",
      connectionId: null,
      lastError: "websocket refused",
    });
  });

  it("refuses a native mapping and a missing provider key", async () => {
    const native = await stateWith(sampleMapping({ mode: "native" }));
    await expect(
      runAgentPane(MAPPING_ID, { env: tuiEnv, state: native, config: DEFAULT_CONFIG }),
    ).rejects.toThrow(/native mode/);
    const tui = await stateWith(sampleMapping());
    await expect(
      runAgentPane(MAPPING_ID, { env: {}, state: tui, config: DEFAULT_CONFIG }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

interface SpawnCall {
  command: string;
  args: string[];
  options: { env: NodeJS.ProcessEnv; cwd?: string };
}

function fakeSpawn(outcome: { exit?: number; errorCode?: string } = {}) {
  const calls: SpawnCall[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    setImmediate(() => {
      if (outcome.errorCode) {
        child.emit("error", Object.assign(new Error("spawn failed"), { code: outcome.errorCode }));
      } else {
        child.emit("exit", outcome.exit ?? 0);
      }
    });
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { calls, spawn };
}

describe("runNativePane", () => {
  const env = { UPSTASH_BOX_API_KEY: "box-key", HERDR_PANE_ID: "pane-4" };

  it("runs the Box CLI REPL against the mapped box with the key in its environment", async () => {
    const state = await stateWith(sampleMapping({ mode: "native", localCwd: "/repo" }));
    const { calls, spawn } = fakeSpawn();
    const code = await runNativePane(MAPPING_ID, {
      env,
      state,
      config: { ...DEFAULT_CONFIG, mode: "native", boxBin: "/opt/box" },
      client: fakeClient({ "box-1": fakeBox().box }),
      ensureRunning: live,
      spawn,
    });
    expect(code).toBe(0);
    expect(calls[0]).toMatchObject({ command: "/opt/box", args: ["connect", "box-1"] });
    expect(calls[0]?.options.env.UPSTASH_BOX_API_KEY).toBe("box-key");
    expect(calls[0]?.options.cwd).toBe("/repo");
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "ready",
      everAttached: true,
      connectionId: null,
    });
  });

  it("explains a missing Box CLI", async () => {
    const state = await stateWith(sampleMapping({ mode: "native" }));
    const { spawn } = fakeSpawn({ errorCode: "ENOENT" });
    await expect(
      runNativePane(MAPPING_ID, {
        env,
        state,
        config: { ...DEFAULT_CONFIG, mode: "native" },
        client: fakeClient({ "box-1": fakeBox().box }),
        ensureRunning: live,
        spawn,
      }),
    ).rejects.toThrow(/ships with this plugin, so reinstall the plugin/);
    expect(readState(state).mappings[MAPPING_ID]?.lifecycleState).toBe("failed");
  });

  it("resolves the binary from config, then the environment, then the bundled CLI", () => {
    const bundled = () => "/pkg/node_modules/@upstash/box-cli/dist/cli.js";
    expect(boxCli({ boxBin: "/a" }, { HERDR_BOX_BIN: "/b" }, bundled)).toBe("/a");
    expect(boxCli({ boxBin: null }, { HERDR_BOX_BIN: "/b" }, bundled)).toBe("/b");
    expect(boxCli({ boxBin: null }, {}, bundled)).toBe(bundled());
    expect(boxCli({ boxBin: null }, {}, () => null)).toBe("box");
  });

  it("finds the CLI the plugin ships with", () => {
    const resolved = bundledBoxCli();
    expect(resolved).toMatch(/@upstash[/\\]box-cli[/\\].*cli\.js$/);
    expect(fs.existsSync(resolved ?? "")).toBe(true);
  });

  it("keeps the child on the plugin's own API, since the CLI reads a .env from the worktree", () => {
    expect(childEnvironment({ PATH: "/bin" }, "k")).toEqual({
      PATH: "/bin",
      UPSTASH_BOX_API_KEY: "k",
    });
    expect(
      childEnvironment({ UPSTASH_BOX_BASE_URL: "https://dev.example.test" }, "k")
        .UPSTASH_BOX_BASE_URL,
    ).toBe("https://dev.example.test");
  });
});

describe("runStartPane", () => {
  it("provisions a native box for the focused worktree, uploads it, and hands off to the REPL", async () => {
    const root = makeGitRepository();
    directories.push(root);
    const directory = temporaryDirectory();
    directories.push(directory);
    const { box, calls } = fakeBox({
      id: "box-new",
      commandOutput: (command) => ({
        stdout: command.includes("git rev-parse HEAD") ? `${BASELINE}\n` : "",
      }),
    });
    const client = fakeClient({ created: box, "box-new": box });
    const { calls: spawns, spawn } = fakeSpawn();
    const renames: Array<[string, string]> = [];
    const output = collector();
    const code = await runStartPane({
      env: {
        HERDR_BOX_SOURCE_CONTEXT_JSON: JSON.stringify({
          focused_pane_cwd: root,
          focused_pane_id: "p1",
        }),
        UPSTASH_BOX_API_KEY: "box-key",
        HERDR_PANE_ID: "pane-5",
      },
      state: { directory },
      config: { ...DEFAULT_CONFIG, mode: "native" },
      client,
      ensureRunning: live,
      spawn,
      rename: (paneId, title) => renames.push([paneId, title]),
      write: output.write,
    });
    expect(code).toBe(0);
    expect(renames).toEqual([["pane-5", "Upstash Box"]]);
    expect(spawns[0]?.args).toEqual(["connect", "box-new"]);
    expect(calls.uploads).toHaveLength(1);
    const mappings = Object.values(readState({ directory }).mappings);
    expect(mappings).toHaveLength(1);
    expect(mappings[0]).toMatchObject({
      mode: "native",
      boxId: "box-new",
      localRoot: root,
      branch: "main",
      sourcePaneId: "p1",
      lifecycleState: "ready",
      prepared: true,
      lastAppliedExportCommit: BASELINE,
    });
    const text = output.lines.join("");
    expect(text).toContain("Upload: 1 file");
    expect(text).toContain("Ready: ");
    expect(paneTitle("tui")).toBe("Upstash Box agent");
  });
});

describe("operation pane", () => {
  const env = { UPSTASH_BOX_API_KEY: "k" };

  it("stops a live TUI session, releases the connection, and closes the agent pane", async () => {
    const state = await stateWith(sampleMapping({ remotePaneId: "pane-9", connectionId: "tok" }));
    const { box, calls } = fakeBox({ commandOutput: () => ({ stdout: "STOPPED\n" }) });
    const closed: string[] = [];
    const outcome = await stopMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": box }),
      closePane: (paneId) => closed.push(paneId),
      write: quiet,
    });
    expect(outcome).toBe("stopped");
    expect(calls.commands[0]).toContain("kill-session");
    expect(closed).toEqual(["pane-9"]);
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "stopped",
      remotePaneId: null,
      connectionId: null,
    });
  });

  it("marks a vanished box missing instead of failing", async () => {
    const state = await stateWith(sampleMapping());
    const outcome = await stopMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": fakeBox({ statuses: ["deleted"] }).box }),
      write: quiet,
    });
    expect(outcome).toBe("missing");
    expect(readState(state).mappings[MAPPING_ID]?.lifecycleState).toBe("missing");
  });

  it("reports status, session, paths, and export markers in info", async () => {
    const state = await stateWith(sampleMapping({ relativeCwd: "app", localCwd: "/repo/app" }));
    const { box } = fakeBox({ commandOutput: () => ({ stdout: "YES\n" }) });
    const lines = await showInfo(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": box }),
      write: quiet,
    });
    expect(lines).toContain("Box status: running");
    expect(lines).toContain("Agent session: running");
    expect(lines).toContain("Remote cwd: /workspace/home/app");
    expect(lines).toContain(`Last applied export: ${COMMIT_A.slice(0, 12)}`);
  });

  it("exports a patch from the box, asks, applies it, and advances the marker", async () => {
    const root = makeGitRepository();
    directories.push(root);
    write(root, "file.txt", "before\n");
    runSync("git", ["add", "file.txt"], { cwd: root });
    runSync("git", ["commit", "-qm", "baseline"], { cwd: root });
    write(root, "file.txt", "after\n");
    const patch = Buffer.from(runSync("git", ["diff", "--binary", "HEAD"], { cwd: root }).stdout);
    runSync("git", ["restore", "file.txt"], { cwd: root });
    const state = await stateWith(sampleMapping({ localRoot: root, localCwd: root }));
    const { box } = fakeBox({
      commandOutput: () => ({ stdout: `${NEXT} ${sha256(patch)}` }),
      remoteFile: (target) => (target.endsWith(".patch") ? patch : undefined),
    });
    const deps = {
      state,
      env,
      config: DEFAULT_CONFIG,
      client: fakeClient({ "box-1": box }),
      ensureRunning: live,
      write: quiet,
    };
    const declined = await applyChanges(MAPPING_ID, { ...deps, confirm: async () => "n" });
    expect(declined).toBe("canceled");
    expect(fs.readFileSync(`${root}/file.txt`, "utf8")).toBe("before\n");
    expect(readState(state).mappings[MAPPING_ID]?.lastAppliedExportCommit).toBe(COMMIT_A);
    // A prompt that timed out answers null, which must read as "no", never as consent.
    const timedOut = await applyChanges(MAPPING_ID, { ...deps, confirm: async () => null });
    expect(timedOut).toBe("canceled");
    expect(fs.readFileSync(`${root}/file.txt`, "utf8")).toBe("before\n");
    expect(readState(state).mappings[MAPPING_ID]?.lastAppliedExportCommit).toBe(COMMIT_A);
    const applied = await applyChanges(MAPPING_ID, { ...deps, confirm: async () => "y" });
    expect(applied).toBe("applied");
    expect(fs.readFileSync(`${root}/file.txt`, "utf8")).toBe("after\n");
    expect(readState(state).mappings[MAPPING_ID]?.lastAppliedExportCommit).toBe(NEXT);
  });

  it("refuses to export before the box has a baseline", async () => {
    const state = await stateWith(
      sampleMapping({ prepared: false, lastAppliedExportCommit: null }),
    );
    await expect(
      applyChanges(MAPPING_ID, {
        state,
        env,
        client: fakeClient({ "box-1": fakeBox().box }),
        write: quiet,
      }),
    ).rejects.toThrow(/no upload baseline/);
  });
});

describe("confirmation pane", () => {
  it("does nothing without the exact word", async () => {
    const state = await stateWith(sampleMapping());
    const { box, calls } = fakeBox();
    const deleted = await runConfirmationPane("delete", MAPPING_ID, {
      state,
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      confirm: async () => "delete",
      write: quiet,
    });
    expect(deleted).toBe(false);
    expect(calls.deleted).toBe(0);
    expect(readState(state).mappings[MAPPING_ID]).toBeDefined();
  });

  it("deletes the box, forgets the mapping, and closes the agent pane on DELETE", async () => {
    const state = await stateWith(sampleMapping({ remotePaneId: "pane-9" }));
    await updateAutomation((automation) => {
      automation.schedules.push({
        id: "schedule-1",
        mappingId: MAPPING_ID,
        boxId: "box-1",
        type: "prompt",
        cron: "0 9 * * *",
        prompt: "check",
        folder: "/workspace/home",
        model: null,
        timeout: null,
        status: "active",
        lastRunAt: null,
        lastRunStatus: null,
        totalRuns: 0,
        totalFailures: 0,
        createdAt: "2026-09-09T10:00:00.000Z",
        updatedAt: "2026-09-09T10:00:00.000Z",
      });
    }, state);
    const { box, calls } = fakeBox();
    const closed: string[] = [];
    const deleted = await runConfirmationPane("delete", MAPPING_ID, {
      state,
      env: { UPSTASH_BOX_API_KEY: "k" },
      client: fakeClient({ "box-1": box }),
      confirm: async () => " DELETE ",
      closePane: (paneId) => closed.push(paneId),
      write: quiet,
    });
    expect(deleted).toBe(true);
    expect(calls.deleted).toBe(1);
    expect(closed).toEqual(["pane-9"]);
    expect(readState(state).mappings).toEqual({});
    expect(readAutomation(state).schedules).toEqual([]);
  });

  it("rejects an unknown destructive action", async () => {
    const state = await stateWith(sampleMapping());
    await expect(runConfirmationPane("replace", MAPPING_ID, { state })).rejects.toThrow(
      /Unsupported destructive action/,
    );
  });
});

describe("deletion and connection claims", () => {
  it("refuses to claim a mapping that is being deleted, missing, or provisional", async () => {
    for (const lifecycleState of ["deleting", "missing", "provisional"] as const) {
      const state = await stateWith(sampleMapping({ lifecycleState }));
      await expect(
        runAgentPane(MAPPING_ID, {
          env: tuiEnv,
          state,
          config: DEFAULT_CONFIG,
          client: fakeClient({ "box-1": fakeBox().box }),
          attach: fakeAttach,
          ensureRunning: live,
        }),
      ).rejects.toMatchObject({ code: "mapping_not_connectable" });
      expect(readState(state).mappings[MAPPING_ID]?.connectionId).toBeNull();
      expect(readState(state).mappings[MAPPING_ID]?.lifecycleState).toBe(lifecycleState);
    }
  });

  it("entering deletion clears the token so an attached pane cannot resurrect the mapping", async () => {
    const state = await stateWith(sampleMapping({ remotePaneId: "pane-9" }));
    const { box, calls } = fakeBox();
    const client = fakeClient({ "box-1": box });
    const code = await runAgentPane(MAPPING_ID, {
      env: tuiEnv,
      state,
      config: DEFAULT_CONFIG,
      client,
      attach: fakeAttach,
      ensureRunning: live,
      bridge: async () => {
        await runConfirmationPane("delete", MAPPING_ID, {
          state,
          env: tuiEnv,
          client,
          confirm: async () => "DELETE",
          closePane: quiet,
          write: quiet,
        });
        return 0;
      },
      write: quiet,
    });
    expect(code).toBe(0);
    expect(calls.deleted).toBe(1);
    expect(readState(state).mappings).toEqual({});
  });

  it("refuses to stop a mapping that is being deleted", async () => {
    const state = await stateWith(sampleMapping({ lifecycleState: "deleting" }));
    await expect(
      stopMapping(MAPPING_ID, {
        state,
        env: tuiEnv,
        client: fakeClient({ "box-1": fakeBox().box }),
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "mapping_deleting" });
  });
});

describe("apply safety", () => {
  const env = { UPSTASH_BOX_API_KEY: "k" };

  it("refuses a patch that would create a symlink or an env file", async () => {
    const source = makeGitRepository();
    directories.push(source);
    fs.symlinkSync("README.md", `${source}/link`);
    write(source, ".env", "SECRET=1\n");
    runSync("git", ["add", "-A", "-f"], { cwd: source });
    const patch = Buffer.from(
      runSync("git", ["diff", "--cached", "--binary"], { cwd: source }).stdout,
    );
    const root = makeGitRepository();
    directories.push(root);
    const state = await stateWith(sampleMapping({ localRoot: root, localCwd: root }));
    await expect(
      applyChanges(MAPPING_ID, {
        state,
        env,
        config: DEFAULT_CONFIG,
        client: fakeClient({ "box-1": fakeBox().box }),
        ensureRunning: live,
        write: quiet,
        patch: {
          exportPatch: async (_box, _mapping, options) => {
            const localPatch = `${options.directory}/changes.patch`;
            fs.writeFileSync(localPatch, patch);
            return { nextCommit: NEXT, bytes: patch.length, localPatch, sha256: sha256(patch) };
          },
        },
      }),
    ).rejects.toMatchObject({ code: "patch_unsafe" });
    expect(fs.existsSync(`${root}/.env`)).toBe(false);
    expect(fs.existsSync(`${root}/link`)).toBe(false);
  });

  it("runs one apply at a time per mapping", async () => {
    const root = makeGitRepository();
    directories.push(root);
    const state = await stateWith(sampleMapping({ localRoot: root, localCwd: root }));
    let release: (value: string) => void = () => undefined;
    const deps = {
      state,
      env,
      config: DEFAULT_CONFIG,
      client: fakeClient({ "box-1": fakeBox().box }),
      ensureRunning: live,
      write: quiet,
      patch: {
        exportPatch: async (_box: unknown, _mapping: unknown, options: { directory: string }) => {
          await new Promise<string>((resolve) => (release = resolve));
          const localPatch = `${options.directory}/changes.patch`;
          fs.writeFileSync(localPatch, "");
          return { nextCommit: NEXT, bytes: 0, localPatch, sha256: sha256(Buffer.alloc(0)) };
        },
      },
    };
    const first = applyChanges(MAPPING_ID, deps);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(applyChanges(MAPPING_ID, deps)).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    release("go");
    expect(await first).toBe("no_change");
  });
});

describe("pause, resume, snapshot", () => {
  const env = { UPSTASH_BOX_API_KEY: "k" };

  it("pauses a live TUI box after stopping its session, and releases the pane", async () => {
    const state = await stateWith(sampleMapping({ remotePaneId: "pane-9", connectionId: "tok" }));
    const { box, calls } = fakeBox({ commandOutput: () => ({ stdout: "STOPPED\n" }) });
    const closed: string[] = [];
    const outcome = await pauseMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": box }),
      closePane: (paneId) => closed.push(paneId),
      write: quiet,
    });
    expect(outcome).toBe("paused");
    expect(calls.commands[0]).toContain("kill-session");
    expect(calls.paused).toBe(1);
    expect(closed).toEqual(["pane-9"]);
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "paused",
      remotePaneId: null,
      connectionId: null,
    });
  });

  it("warns when an active schedule can wake the paused box", async () => {
    const state = await stateWith(sampleMapping({ mode: "native" }));
    const output = collector();
    const { box } = fakeBox({
      schedules: [
        {
          id: "schedule-1",
          box_id: "box-1",
          type: "prompt",
          cron: "* * * * *",
          prompt: "check",
          status: "active",
          total_runs: 0,
          total_failures: 0,
          created_at: 1_757_412_000,
          updated_at: 1_757_412_000,
        },
      ],
    });
    await pauseMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": box }),
      write: output.write,
    });
    expect(output.lines.join("")).toContain("active schedule can wake it");
  });

  it("reports an already paused box, a missing one, and a keep-alive refusal", async () => {
    const paused = await stateWith(sampleMapping({ mode: "native" }));
    expect(
      await pauseMapping(MAPPING_ID, {
        state: paused,
        env,
        client: fakeClient({ "box-1": fakeBox({ statuses: ["paused"] }).box }),
        write: quiet,
      }),
    ).toBe("already_paused");
    const gone = await stateWith(sampleMapping());
    expect(
      await pauseMapping(MAPPING_ID, {
        state: gone,
        env,
        client: fakeClient({ "box-1": fakeBox({ statuses: ["deleted"] }).box }),
        write: quiet,
      }),
    ).toBe("missing");
    expect(readState(gone).mappings[MAPPING_ID]?.lifecycleState).toBe("missing");
    const keep = await stateWith(sampleMapping({ mode: "native" }));
    await expect(
      pauseMapping(MAPPING_ID, {
        state: keep,
        env,
        client: fakeClient({ "box-1": fakeBox({ keepAlive: true }).box }),
        write: quiet,
      }),
    ).rejects.toThrow(/Keep-alive/);
  });

  it("resumes a paused box and marks the mapping ready", async () => {
    const state = await stateWith(sampleMapping({ lifecycleState: "paused" }));
    const outcome = await resumeMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": fakeBox().box }),
      ensureRunning: async (_box, options) => {
        options?.onResume?.();
        return { status: "running", resumed: true };
      },
      write: quiet,
    });
    expect(outcome).toBe("resumed");
    expect(readState(state).mappings[MAPPING_ID]?.lifecycleState).toBe("ready");
  });

  it("snapshots a running box and records it on the mapping", async () => {
    const state = await stateWith(sampleMapping());
    const { box, calls } = fakeBox();
    const snapshot = await snapshotMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": box }),
      ensureRunning: live,
      write: quiet,
    });
    expect(calls.snapshots[0]).toMatch(/^herdr-claude-code-repo-abcdef12-\d{8}-\d{6}$/);
    expect(snapshot.id).toBe("snap-1");
    expect(readState(state).mappings[MAPPING_ID]?.lastSnapshot).toMatchObject({
      id: "snap-1",
      name: calls.snapshots[0],
    });
  });
});

describe("fork and orphan deletion", () => {
  const env = { UPSTASH_BOX_API_KEY: "k" };

  it("forks after FORK: snapshot, a new box from it, and a second mapping beside the original", async () => {
    const state = await stateWith(sampleMapping({ everAttached: true }));
    const { box: original, calls } = fakeBox();
    const { box: forked } = fakeBox({ id: "box-9" });
    const client = fakeClient({ "box-1": original, forked });
    const output: string[] = [];
    const done = await runConfirmationPane("fork", MAPPING_ID, {
      state,
      env,
      config: DEFAULT_CONFIG,
      client,
      ensureRunning: live,
      confirm: async (word) => word,
      write: (chunk) => void output.push(chunk),
    });
    expect(done).toBe(true);
    expect(calls.snapshots).toHaveLength(1);
    expect(client.forks[0]?.snapshotId).toBe("snap-1");
    expect(client.forks[0]?.config.labels?.[0]).toBe("herdr");
    expect(client.forks[0]?.config.agent).toBeUndefined();
    const mappings = Object.values(readState(state).mappings);
    expect(mappings).toHaveLength(2);
    const child = mappings.find((mapping) => mapping.id !== MAPPING_ID);
    expect(child).toMatchObject({
      boxId: "box-9",
      localRoot: "/repo",
      prepared: true,
      everAttached: true,
      lifecycleState: "ready",
      lastAppliedExportCommit: COMMIT_A,
      lastSnapshot: { id: "snap-1" },
    });
    expect(child?.boxName).not.toBe(sampleMapping().boxName);
    expect(child?.labels[1]).toMatch(/^hm:/);
    expect(readState(state).mappings[MAPPING_ID]?.lastSnapshot?.id).toBe("snap-1");
    expect(output.join("")).toContain("Forked:");
  });

  it("gives a native fork the same credential mode and refuses an unprepared box", async () => {
    const state = await stateWith(
      sampleMapping({ mode: "native", model: "openai/gpt-5", harness: "opencode" }),
    );
    const client = fakeClient({ "box-1": fakeBox().box, forked: fakeBox({ id: "box-9" }).box });
    await runConfirmationPane("fork", MAPPING_ID, {
      state,
      env,
      config: { ...DEFAULT_CONFIG, mode: "native" },
      client,
      ensureRunning: live,
      confirm: async () => "FORK",
      write: quiet,
    });
    expect(client.forks[0]?.config.agent).toEqual({ harness: "opencode", model: "openai/gpt-5" });
    const unprepared = await stateWith(sampleMapping({ prepared: false }));
    await expect(
      runConfirmationPane("fork", MAPPING_ID, {
        state: unprepared,
        env,
        config: DEFAULT_CONFIG,
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "mapping_not_forkable" });
  });

  it("does nothing without the exact word and deletes an orphan after DELETE", async () => {
    const state = await stateWith(sampleMapping());
    const client = fakeClient({ "box-1": fakeBox().box, forked: fakeBox().box });
    expect(
      await runConfirmationPane("fork", MAPPING_ID, {
        state,
        env,
        config: DEFAULT_CONFIG,
        client,
        confirm: async () => "fork",
        write: quiet,
      }),
    ).toBe(false);
    expect(client.forks).toEqual([]);
    const { box, calls } = fakeBox({ id: "box-orphan" });
    expect(
      await runConfirmationPane("delete-orphan", "box-orphan", {
        state,
        env,
        client: fakeClient(
          { "box-orphan": box },
          listing([{ id: "box-orphan", name: "stray", labels: ["herdr", "hm:ffffffffffffffff"] }]),
        ),
        confirm: async () => "DELETE",
        write: quiet,
      }),
    ).toBe(true);
    expect(calls.deleted).toBe(1);
  });
});

describe("third review", () => {
  const env = { UPSTASH_BOX_API_KEY: "k" };

  it("resume leaves a connected box and its pane alone", async () => {
    const state = await stateWith(
      sampleMapping({ lifecycleState: "connected", connectionId: "tok", remotePaneId: "pane-9" }),
    );
    const closed: string[] = [];
    const outcome = await resumeMapping(MAPPING_ID, {
      state,
      env,
      client: fakeClient({ "box-1": fakeBox().box }),
      ensureRunning: live,
      closePane: (paneId) => closed.push(paneId),
      write: quiet,
    });
    expect(outcome).toBe("already_running");
    expect(closed).toEqual([]);
    expect(readState(state).mappings[MAPPING_ID]).toMatchObject({
      lifecycleState: "connected",
      connectionId: "tok",
      remotePaneId: "pane-9",
    });
  });

  it("reserves the fork before anything billable and records a failure on it", async () => {
    const state = await stateWith(sampleMapping());
    const { box } = fakeBox();
    const client = {
      ...fakeClient({ "box-1": box }),
      async fromSnapshot() {
        throw new Error("quota exceeded");
      },
    };
    await expect(
      runConfirmationPane("fork", MAPPING_ID, {
        state,
        env,
        config: DEFAULT_CONFIG,
        client,
        ensureRunning: live,
        confirm: async () => "FORK",
        write: quiet,
      }),
    ).rejects.toThrow(/quota exceeded/);
    const child = Object.values(readState(state).mappings).find((m) => m.id !== MAPPING_ID);
    expect(child).toMatchObject({
      lifecycleState: "failed",
      boxId: null,
      sourcePaneId: null,
      lastError: "quota exceeded",
      lastSnapshot: { id: "snap-1" },
    });
    expect(child?.labels[1]).toMatch(/^hm:/);
  });

  it("derives a fork's credential from the mapping, not today's config", async () => {
    const managed = await stateWith(sampleMapping({ mode: "native", credential: "managed" }));
    const client = fakeClient({ "box-1": fakeBox().box, forked: fakeBox({ id: "box-9" }).box });
    await runConfirmationPane("fork", MAPPING_ID, {
      state: managed,
      env: { ...env, ANTHROPIC_API_KEY: "local-key" },
      config: { ...DEFAULT_CONFIG, mode: "native", nativeKey: "local" },
      client,
      ensureRunning: live,
      confirm: async () => "FORK",
      write: quiet,
    });
    expect(client.forks[0]?.config.agent).toEqual({
      harness: "claude-code",
      model: "anthropic/claude-sonnet-5",
    });
    const child = Object.values(readState(managed).mappings).find((m) => m.id !== MAPPING_ID);
    expect(child?.credential).toBe("managed");
    expect(child?.sourcePaneId).toBeNull();
    const local = await stateWith(sampleMapping({ mode: "native", credential: "local" }));
    await expect(
      runConfirmationPane("fork", MAPPING_ID, {
        state: local,
        env,
        config: { ...DEFAULT_CONFIG, mode: "native" },
        client: fakeClient({ "box-1": fakeBox().box, forked: fakeBox().box }),
        ensureRunning: live,
        confirm: async () => "FORK",
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "provider_api_key_missing" });
  });

  it("refuses to delete an orphan that a mapping claims or another tool owns", async () => {
    const state = await stateWith(sampleMapping({ boxId: null, lifecycleState: "creating" }));
    const claimed = fakeClient(
      { "box-x": fakeBox({ id: "box-x" }).box },
      listing([
        { id: "box-x", name: sampleMapping().boxName, labels: ["herdr", "hm:1234567812344123"] },
      ]),
    );
    await expect(
      runConfirmationPane("delete-orphan", "box-x", {
        state,
        env,
        client: claimed,
        confirm: async () => "DELETE",
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "orphan_claimed" });
    const foreign = fakeClient(
      { "box-y": fakeBox({ id: "box-y" }).box },
      listing([{ id: "box-y", name: "theirs", labels: ["herdr"] }]),
    );
    await expect(
      runConfirmationPane("delete-orphan", "box-y", {
        state,
        env,
        client: foreign,
        confirm: async () => "DELETE",
        write: quiet,
      }),
    ).rejects.toMatchObject({ code: "orphan_not_ours" });
    const { box, calls } = fakeBox({ id: "box-z" });
    const real = fakeClient(
      { "box-z": box },
      listing([{ id: "box-z", name: "stray", labels: ["herdr", "hm:ffffffffffffffff"] }]),
    );
    expect(
      await runConfirmationPane("delete-orphan", "box-z", {
        state,
        env,
        client: real,
        confirm: async () => "DELETE",
        write: quiet,
      }),
    ).toBe(true);
    expect(calls.deleted).toBe(1);
  });

  it("serialises stop against a running apply", async () => {
    const root = makeGitRepository();
    directories.push(root);
    const state = await stateWith(sampleMapping({ localRoot: root, localCwd: root }));
    let release: (value: string) => void = () => undefined;
    const client = fakeClient({ "box-1": fakeBox().box });
    const applying = applyChanges(MAPPING_ID, {
      state,
      env,
      config: DEFAULT_CONFIG,
      client,
      ensureRunning: live,
      write: quiet,
      patch: {
        exportPatch: async (_box: unknown, _mapping: unknown, options: { directory: string }) => {
          await new Promise<string>((resolve) => (release = resolve));
          const localPatch = `${options.directory}/changes.patch`;
          fs.writeFileSync(localPatch, "");
          return { nextCommit: NEXT, bytes: 0, localPatch, sha256: sha256(Buffer.alloc(0)) };
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(
      stopMapping(MAPPING_ID, { state, env, client, write: quiet }),
    ).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    release("go");
    expect(await applying).toBe("no_change");
    expect(await stopMapping(MAPPING_ID, { state, env, client, write: quiet })).toBe("not_running");
  });
});
