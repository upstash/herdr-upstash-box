import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIONS,
  applyChanges,
  dashboard,
  fork,
  info,
  pause,
  previews,
  reconnect,
  requestDelete,
  resume,
  runResults,
  runTask,
  runAction,
  schedules,
  snapshot,
  startAgent,
  stop,
} from "../src/actions.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { PaneOptions } from "../src/herdr.js";
import { updateState } from "../src/state.js";
import { makeGitRepository, remove, sampleMapping, temporaryDirectory } from "./helpers.js";

interface Opened {
  entrypoint: string;
  options: PaneOptions;
}

function recorder() {
  const opened: Opened[] = [];
  const openPane = (entrypoint: string, _context: unknown, options: PaneOptions = {}) => {
    opened.push({ entrypoint, options });
    return { status: 0, stdout: "", stderr: "" };
  };
  return { opened, openPane };
}

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

function repo(): string {
  const root = makeGitRepository();
  directories.push(root);
  return root;
}

const quiet = () => undefined;

describe("start-agent", () => {
  it("opens the start pane beside the focused pane with the source context", async () => {
    const root = repo();
    const state = await stateWith();
    const { opened, openPane } = recorder();
    const context = { focused_pane_id: "pane-1", focused_pane_cwd: root };
    const result = await startAgent(context, {
      openPane,
      config: DEFAULT_CONFIG,
      state,
      env: {},
      write: quiet,
    });
    expect(result.status).toBe("opened");
    expect(result.worktree).toBe(root);
    expect(opened[0]?.entrypoint).toBe("start");
    expect(opened[0]?.options.placement).toBe("split");
    expect(opened[0]?.options.targetPaneId).toBe("pane-1");
    expect(opened[0]?.options.env?.HERDR_AGENT).toBe("claude");
    expect(JSON.parse(opened[0]?.options.env?.HERDR_BOX_SOURCE_CONTEXT_JSON ?? "")).toEqual(
      context,
    );
  });

  it("does not claim an agent screen in native mode", async () => {
    const root = repo();
    const { opened, openPane } = recorder();
    await startAgent(
      { focused_pane_cwd: root },
      {
        openPane,
        config: { ...DEFAULT_CONFIG, mode: "native" },
        state: await stateWith(),
        env: {},
        write: quiet,
      },
    );
    expect(opened[0]?.options.env?.HERDR_AGENT).toBeUndefined();
  });

  it("refuses to open a second box for a worktree unless allowed", async () => {
    const root = repo();
    const state = await stateWith(sampleMapping({ localRoot: root, localCwd: root }));
    const { opened, openPane } = recorder();
    await expect(
      startAgent(
        { focused_pane_cwd: root },
        { openPane, config: DEFAULT_CONFIG, state, env: {}, write: quiet },
      ),
    ).rejects.toMatchObject({ code: "mapping_exists" });
    expect(opened).toEqual([]);
    await startAgent(
      { focused_pane_cwd: root },
      {
        openPane,
        config: { ...DEFAULT_CONFIG, allowMultipleBoxes: true },
        state,
        env: {},
        write: quiet,
      },
    );
    expect(opened).toHaveLength(1);
  });

  it("fails before opening a pane when the directory is not a worktree", async () => {
    const plain = temporaryDirectory();
    directories.push(plain);
    const { opened, openPane } = recorder();
    await expect(
      startAgent(
        { focused_pane_cwd: plain },
        { openPane, config: DEFAULT_CONFIG, state: await stateWith(), env: {}, write: quiet },
      ),
    ).rejects.toThrow(/No Git worktree/);
    expect(opened).toEqual([]);
  });
});

describe("reconnect", () => {
  it("opens the agent pane for a TUI mapping, anchored to its source pane", async () => {
    const state = await stateWith(sampleMapping({ sourcePaneId: "pane-1" }));
    const { opened, openPane } = recorder();
    const result = await reconnect(
      { focused_pane_id: "pane-1" },
      { openPane, state, env: {}, write: quiet },
    );
    expect(result.status).toBe("opened");
    expect(opened[0]?.entrypoint).toBe("agent");
    expect(opened[0]?.options.targetPaneId).toBe("pane-1");
    expect(opened[0]?.options.env).toEqual({
      HERDR_BOX_MAPPING_ID: sampleMapping().id,
      HERDR_AGENT: "claude",
    });
  });

  it("opens the native pane for a native mapping", async () => {
    const state = await stateWith(
      sampleMapping({ mode: "native", harness: "codex", model: "openai/gpt-5" }),
    );
    const { opened, openPane } = recorder();
    await reconnect({ focused_pane_id: "pane-1" }, { openPane, state, env: {}, write: quiet });
    expect(opened[0]?.entrypoint).toBe("native");
    expect(opened[0]?.options.env?.HERDR_AGENT).toBeUndefined();
  });

  it("lets a crashed or failed mapping recover, but not one being deleted", async () => {
    const { opened, openPane } = recorder();
    for (const lifecycleState of ["creating", "failed", "stopped"] as const) {
      const state = await stateWith(sampleMapping({ lifecycleState, boxId: null }));
      await reconnect({ focused_pane_id: "pane-1" }, { openPane, state, env: {}, write: quiet });
    }
    expect(opened).toHaveLength(3);
    for (const lifecycleState of ["deleting", "provisional", "missing"] as const) {
      const state = await stateWith(sampleMapping({ lifecycleState }));
      await expect(
        reconnect({ focused_pane_id: "pane-1" }, { openPane, state, env: {}, write: quiet }),
      ).rejects.toThrow(new RegExp(`is ${lifecycleState}`));
    }
  });
});

describe("mapped operations", () => {
  it("open the operation popup with the operation name", async () => {
    const state = await stateWith(sampleMapping());
    const { opened, openPane } = recorder();
    const deps = { openPane, state, env: {}, write: quiet };
    await stop({ focused_pane_id: "pane-1" }, deps);
    await info({ focused_pane_id: "pane-1" }, deps);
    await applyChanges({ focused_pane_id: "pane-1" }, deps);
    expect(opened.map((o) => o.entrypoint)).toEqual(["operation", "operation", "operation"]);
    expect(opened.map((o) => o.options.env?.HERDR_BOX_OPERATION)).toEqual([
      "stop",
      "info",
      "apply-changes",
    ]);
    expect(opened[0]?.options.placement).toBe("popup");
  });

  it("route deletion through the typed confirmation popup", async () => {
    const state = await stateWith(sampleMapping());
    const { opened, openPane } = recorder();
    const result = await requestDelete(
      { focused_pane_id: "pane-1" },
      { openPane, state, env: {}, write: quiet },
    );
    expect(result.status).toBe("confirmation_opened");
    expect(opened[0]?.entrypoint).toBe("confirmation");
    expect(opened[0]?.options.env?.HERDR_BOX_DESTRUCTIVE_ACTION).toBe("delete");
  });
});

describe("runAction", () => {
  it("registers exactly the manifest verbs", () => {
    expect(Object.keys(ACTIONS).sort()).toEqual(
      [
        "apply-changes",
        "dashboard",
        "delete-box",
        "fork",
        "info",
        "pause",
        "previews",
        "reconnect",
        "resume",
        "run-results",
        "run-task",
        "schedules",
        "snapshot",
        "start-agent",
        "stop",
      ].sort(),
    );
  });

  it("names an unknown action", async () => {
    await expect(runAction("dance", { env: {} })).rejects.toThrow(/Unknown action: dance/);
    await expect(runAction(undefined, { env: {} })).rejects.toThrow(/<missing>/);
  });

  it("parses the herdr context from the environment", async () => {
    const root = repo();
    const { opened, openPane } = recorder();
    const env = {
      HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "p3", focused_pane_cwd: root }),
    };
    await runAction("start-agent", {
      openPane,
      config: DEFAULT_CONFIG,
      state: await stateWith(),
      env,
      write: quiet,
    });
    expect(opened[0]?.options.targetPaneId).toBe("p3");
  });
});

describe("phase 3 verbs", () => {
  it("open the dashboard zoomed and the previews popup", async () => {
    const state = await stateWith(sampleMapping());
    const { opened, openPane } = recorder();
    const deps = { openPane, state, env: {}, write: quiet };
    await dashboard({ focused_pane_id: "pane-1" }, deps);
    await previews({ focused_pane_id: "pane-1" }, deps);
    expect(opened[0]).toMatchObject({ entrypoint: "dashboard", options: { placement: "zoomed" } });
    expect(opened[1]).toMatchObject({
      entrypoint: "previews",
      options: { placement: "popup", env: { HERDR_BOX_MAPPING_ID: sampleMapping().id } },
    });
  });

  it("route pause, resume, and snapshot through the operation popup and fork through confirmation", async () => {
    const state = await stateWith(sampleMapping());
    const { opened, openPane } = recorder();
    const deps = { openPane, state, env: {}, write: quiet };
    await pause({ focused_pane_id: "pane-1" }, deps);
    await resume({ focused_pane_id: "pane-1" }, deps);
    await snapshot({ focused_pane_id: "pane-1" }, deps);
    const forked = await fork({ focused_pane_id: "pane-1" }, deps);
    expect(opened.slice(0, 3).map((o) => o.options.env?.HERDR_BOX_OPERATION)).toEqual([
      "pause",
      "resume",
      "snapshot",
    ]);
    expect(opened[3]?.entrypoint).toBe("confirmation");
    expect(opened[3]?.options.env?.HERDR_BOX_DESTRUCTIVE_ACTION).toBe("fork");
    expect(forked.status).toBe("confirmation_opened");
  });
});

describe("phase 4 verbs", () => {
  it("routes native automation actions and rejects TUI mappings before opening a pane", async () => {
    const native = await stateWith(sampleMapping({ mode: "native" }));
    const { opened, openPane } = recorder();
    const deps = { openPane, state: native, env: {}, write: quiet };
    await runTask({ focused_pane_id: "pane-1" }, deps);
    await runResults({ focused_pane_id: "pane-1" }, deps);
    await schedules({ focused_pane_id: "pane-1" }, deps);
    expect(opened.map((entry) => entry.entrypoint)).toEqual([
      "agent-runs",
      "agent-runs",
      "schedules",
    ]);
    expect(opened.map((entry) => entry.options.env?.HERDR_BOX_AUTOMATION_MODE)).toEqual([
      "task",
      "results",
      undefined,
    ]);

    const tui = await stateWith(sampleMapping());
    const blocked = recorder();
    await expect(
      runTask({ focused_pane_id: "pane-1" }, { ...deps, state: tui, openPane: blocked.openPane }),
    ).rejects.toMatchObject({ code: "automation_requires_native_mode" });
    expect(blocked.opened).toEqual([]);
  });
});
