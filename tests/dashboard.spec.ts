import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildRows,
  claimedBy,
  epochToIso,
  formatAge,
  isPluginBox,
  KEY_ACTIONS,
  renderDashboard,
  scheduleIndicator,
  splitKeys,
} from "../src/dashboard-model.js";
import { removeMapping } from "../src/state.js";
import type { PaneOptions } from "../src/herdr.js";
import { runDashboardPane } from "../src/panes/dashboard.js";
import { parsePreviewCommand, runPreviewsPane } from "../src/panes/previews.js";
import { updateState } from "../src/state.js";
import {
  fakeBox,
  fakeClient,
  listing,
  MAPPING_ID,
  remove,
  sampleMapping,
  temporaryDirectory,
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

const SECOND_ID = "22222222-2222-4222-8222-222222222222";

describe("dashboard model", () => {
  it("keeps age labels compact", () => {
    const now = Date.parse("2026-09-09T12:00:00Z");
    expect(formatAge("2026-09-09T11:59:50Z", now)).toBe("now");
    expect(formatAge("2026-09-09T11:30:00Z", now)).toBe("30m");
    expect(formatAge("2026-09-09T09:00:00Z", now)).toBe("3h");
    expect(formatAge("2026-09-06T12:00:00Z", now)).toBe("3d");
    expect(epochToIso(1_757_412_000)).toBe("2025-09-09T10:00:00.000Z");
    expect(epochToIso(1_757_412_000_000)).toBe("2025-09-09T10:00:00.000Z");
  });

  it("lists mappings newest first with their remote status, then labelled orphans", () => {
    const older = sampleMapping({ createdAt: "2026-09-08T10:00:00.000Z" });
    const newer = sampleMapping({
      id: SECOND_ID,
      boxId: "box-2",
      boxName: "herdr-codex-other-00000000",
      createdAt: "2026-09-09T10:00:00.000Z",
    });
    const noBox = sampleMapping({
      id: "33333333-3333-4333-8333-333333333333",
      boxId: null,
      createdAt: "2026-09-07T10:00:00.000Z",
    });
    const state = {
      schemaVersion: 1 as const,
      mappings: { [older.id]: older, [newer.id]: newer, [noBox.id]: noBox },
    };
    const rows = buildRows(
      state,
      listing([
        { id: "box-1", status: "paused" },
        {
          id: "box-orphan",
          name: "herdr-orphan",
          labels: ["herdr", "hm:deadbeefdeadbeef"],
          created_at: 1_757_412_000,
        },
        { id: "box-plain", name: "someone-elses", labels: ["herdr"] },
        { id: "box-gone", status: "deleted" },
        { id: "box-foreign", labels: ["other"] },
      ]),
    );
    expect(rows.map((row) => row.id)).toEqual([
      SECOND_ID,
      MAPPING_ID,
      noBox.id,
      "orphan:box-orphan",
    ]);
    expect(rows.map((row) => row.remote)).toEqual(["missing", "paused", "no box", "running"]);
    expect(buildRows(state, null).map((row) => row.remote)).toEqual([
      "checking",
      "checking",
      "checking",
    ]);
  });

  it("renders rows, the selected mapping, and the key help", () => {
    const rows = buildRows(
      { schemaVersion: 1, mappings: { [MAPPING_ID]: sampleMapping({ branch: "feature/x" }) } },
      listing([
        { id: "box-1" },
        { id: "box-orphan", name: "stray", labels: ["herdr", "hm:ffffffffffffffff"] },
      ]),
    );
    const text = renderDashboard(rows, 0, {
      width: 120,
      syncing: false,
      message: "Ready.",
      now: Date.parse("2026-09-09T10:05:00Z"),
    });
    expect(text).toContain("repo / feature/x");
    expect(text).toContain("herdr-claude-code-repo-abcdef12");
    expect(text).toContain("Claude Code");
    expect(text).toContain("Selected");
    expect(text).toContain("local ready / remote running");
    expect(text).toContain("(no mapping)");
    expect(text).toContain("[f] Fork");
    expect(text).toContain("Ready.");
    const orphanSelected = renderDashboard(rows, 1, { width: 100, syncing: true, message: "" });
    expect(orphanSelected).toContain("syncing");
    expect(orphanSelected).toContain("no mapping knows it");
  });

  it("maps keys to actions, including arrows and Ctrl-C", () => {
    expect(KEY_ACTIONS["\u001b[A"]).toBe("up");
    expect(KEY_ACTIONS["\u001b[B"]).toBe("down");
    expect(KEY_ACTIONS["\u0003"]).toBe("quit");
    expect(KEY_ACTIONS.f).toBe("fork");
    expect(KEY_ACTIONS.R).toBe("refresh");
    expect(KEY_ACTIONS.t).toBe("run-task");
    expect(KEY_ACTIONS.h).toBe("run-results");
    expect(KEY_ACTIONS.c).toBe("schedules");
  });

  it("summarizes locally persisted active and paused schedules", () => {
    const base = {
      mappingId: MAPPING_ID,
      boxId: "box-1",
      type: "prompt" as const,
      cron: "* * * * *",
      prompt: "work",
      folder: "/workspace/home",
      model: "anthropic/claude-sonnet-5",
      timeout: 600_000,
      lastRunAt: null,
      lastRunStatus: null,
      totalRuns: 0,
      totalFailures: 0,
      createdAt: "2026-09-09T10:00:00.000Z",
      updatedAt: "2026-09-09T10:00:00.000Z",
    };
    expect(
      scheduleIndicator(
        {
          schemaVersion: 1,
          runs: [],
          schedules: [
            { ...base, id: "one", status: "active" },
            { ...base, id: "two", status: "paused" },
          ],
        },
        MAPPING_ID,
      ),
    ).toBe("1a/1p");
  });
});

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

async function* keys(sequence: string[]): AsyncIterable<string> {
  for (const key of sequence) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    yield key;
  }
}

describe("runDashboardPane", () => {
  it("opens the Phase 4 panes for native mappings and blocks TUI mappings", async () => {
    const native = await stateWith(sampleMapping({ mode: "native" }));
    const opened = recorder();
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state: native,
      context: {},
      openPane: opened.openPane,
      write: () => undefined,
      keys: keys(["t", "h", "c", "q"]),
      listBoxes: async () => listing([{ id: "box-1" }]),
      refreshMs: 0,
    });
    expect(opened.opened.map((entry) => entry.entrypoint)).toEqual([
      "agent-runs",
      "agent-runs",
      "schedules",
    ]);
    expect(opened.opened.map((entry) => entry.options.env?.HERDR_BOX_AUTOMATION_MODE)).toEqual([
      "task",
      "results",
      undefined,
    ]);

    const tui = await stateWith(sampleMapping());
    const blocked = recorder();
    const frames: string[] = [];
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state: tui,
      context: {},
      openPane: blocked.openPane,
      write: (chunk) => void frames.push(chunk),
      keys: keys(["t", "q"]),
      listBoxes: async () => listing([{ id: "box-1" }]),
      refreshMs: 0,
    });
    expect(blocked.opened).toEqual([]);
    expect(frames.some((frame) => frame.includes("require a native-mode box"))).toBe(true);
  });

  it("drives every verb through the panes the actions use", async () => {
    const state = await stateWith(
      sampleMapping({ createdAt: "2026-09-09T10:00:00.000Z" }),
      sampleMapping({
        id: SECOND_ID,
        mode: "native",
        boxId: "box-2",
        boxName: "herdr-claude-code-other-00000000",
        createdAt: "2026-09-08T10:00:00.000Z",
      }),
    );
    const { opened, openPane } = recorder();
    const frames: string[] = [];
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      context: { workspace_id: "ws-1", focused_pane_id: "pane-dash" },
      openPane,
      write: (chunk) => void frames.push(chunk),
      keys: keys([
        "\r",
        "a",
        "p",
        "u",
        "n",
        "v",
        "f",
        "d",
        "j",
        "\r",
        "j",
        "d",
        "k",
        "k",
        "i",
        "q",
      ]),
      listBoxes: async () =>
        listing([
          { id: "box-1" },
          { id: "box-2", status: "paused" },
          { id: "box-orphan", name: "stray", labels: ["herdr", "hm:ffffffffffffffff"] },
        ]),
      refreshMs: 0,
      width: 120,
    });
    expect(opened.map((o) => o.entrypoint)).toEqual([
      "agent",
      "operation",
      "operation",
      "operation",
      "operation",
      "previews",
      "confirmation",
      "confirmation",
      "native",
      "confirmation",
      "operation",
    ]);
    expect(opened[0]?.options).toMatchObject({
      placement: "tab",
      workspaceId: "ws-1",
      env: { HERDR_BOX_MAPPING_ID: MAPPING_ID, HERDR_AGENT: "claude" },
    });
    expect(opened.slice(1, 5).map((o) => o.options.env?.HERDR_BOX_OPERATION)).toEqual([
      "apply-changes",
      "pause",
      "resume",
      "snapshot",
    ]);
    expect(opened[6]?.options.env?.HERDR_BOX_DESTRUCTIVE_ACTION).toBe("fork");
    expect(opened[7]?.options.env?.HERDR_BOX_DESTRUCTIVE_ACTION).toBe("delete");
    expect(opened[8]?.options.env).toEqual({ HERDR_BOX_MAPPING_ID: SECOND_ID });
    expect(opened[9]?.options.env).toEqual({
      HERDR_BOX_ORPHAN_BOX_ID: "box-orphan",
      HERDR_BOX_DESTRUCTIVE_ACTION: "delete-orphan",
    });
    expect(opened[10]?.options.env?.HERDR_BOX_MAPPING_ID).toBe(MAPPING_ID);
    const last = frames.at(-1) ?? "";
    expect(last).toContain("3 boxes");
    expect(last).toContain("paused");
  });

  it("refuses to reconnect a dead mapping and explains orphans", async () => {
    const state = await stateWith(sampleMapping({ lifecycleState: "missing" }));
    const { opened, openPane } = recorder();
    const frames: string[] = [];
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      context: {},
      openPane,
      write: (chunk) => void frames.push(chunk),
      keys: keys(["\r", "j", "\r", "q"]),
      listBoxes: async () =>
        listing([{ id: "box-orphan", name: "stray", labels: ["herdr", "hm:ffffffffffffffff"] }]),
      refreshMs: 0,
    });
    expect(opened).toEqual([]);
    expect(frames.some((frame) => frame.includes("nothing to reconnect to"))).toBe(true);
    expect(frames.at(-1)).toContain("Orphan boxes can only be deleted");
  });

  it("reports a failed refresh without dying", async () => {
    const state = await stateWith(sampleMapping());
    const frames: string[] = [];
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      context: {},
      openPane: recorder().openPane,
      write: (chunk) => void frames.push(chunk),
      keys: keys(["R", "q"]),
      listBoxes: async () => {
        throw new Error("network down");
      },
      refreshMs: 0,
    });
    expect(frames.some((frame) => frame.includes("Refresh failed: network down"))).toBe(true);
    expect(frames.at(-1)).toContain("checking");
  });
});

describe("previews", () => {
  it("parses port commands against the configured ports", () => {
    const ports = [3000, 5173];
    expect(parsePreviewCommand("", ports)).toEqual({ kind: "close" });
    expect(parsePreviewCommand("q", ports)).toEqual({ kind: "close" });
    expect(parsePreviewCommand("3000", ports)).toEqual({ kind: "expose", port: 3000 });
    expect(parsePreviewCommand("d 3000", ports)).toEqual({ kind: "remove", port: 3000 });
    expect(parsePreviewCommand("d8080", ports)).toEqual({ kind: "remove", port: 8080 });
    expect(parsePreviewCommand("8080", ports)).toEqual({ kind: "invalid" });
    expect(parsePreviewCommand("abc", ports)).toEqual({ kind: "invalid" });
  });

  it("exposes and removes ports only on request, with basic auth by default", async () => {
    const state = await stateWith(sampleMapping());
    const { box, calls } = fakeBox({
      publicURLs: [{ port: 8000, url: "https://old.example.test" }],
    });
    const answers = ["3000", "", "d8000", "", "9999", "", ""];
    const output: string[] = [];
    await runPreviewsPane(MAPPING_ID, {
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      config: DEFAULT_CONFIG,
      client: fakeClient({ "box-1": box }),
      ensureRunning: async () => ({ status: "running", resumed: false }),
      write: (chunk) => void output.push(chunk),
      prompt: async () => answers.shift() ?? "",
    });
    expect(calls.exposed).toEqual([{ port: 3000, basicAuth: true }]);
    expect(calls.unexposed).toEqual([8000]);
    const text = output.join("");
    expect(text).toContain("Port 8000: https://old.example.test");
    expect(text).toContain("Port 3000: https://p3000.example.test");
    expect(text).toContain("user: box");
    expect(text).toContain("Removed the public URL for port 8000");
    expect(text).toContain("Use one of the configured ports");
  });
});

describe("ownership", () => {
  it("treats a crashed start's box as recoverable, never as an orphan", () => {
    const crashed = sampleMapping({ boxId: null, lifecycleState: "creating" });
    const state = { schemaVersion: 1 as const, mappings: { [crashed.id]: crashed } };
    const box = { id: "box-x", name: crashed.boxName, labels: ["herdr", "hm:1234567812344123"] };
    expect(claimedBy(state, box)?.id).toBe(crashed.id);
    const rows = buildRows(state, listing([box]));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.remote).toBe("running, recoverable");
  });

  it("ignores boxes that carry only the generic label", () => {
    expect(isPluginBox({ id: "x", labels: ["herdr"], status: "running" })).toBe(false);
    expect(isPluginBox({ id: "x", labels: ["herdr", "hm:abc"], status: "running" })).toBe(true);
    const rows = buildRows(
      { schemaVersion: 1, mappings: {} },
      listing([{ id: "x", labels: ["herdr"] }]),
    );
    expect(rows).toEqual([]);
  });

  it("splits combined keys and buffers a partial escape sequence", () => {
    expect(splitKeys("jjq").keys).toEqual(["j", "j", "q"]);
    const first = splitKeys("\u001b[");
    expect(first).toEqual({ keys: [], pending: "\u001b[" });
    expect(splitKeys("A", first.pending).keys).toEqual(["\u001b[A"]);
    expect(splitKeys("\u001b[Bk").keys).toEqual(["\u001b[B", "k"]);
  });

  it("aborts a key whose row disappeared instead of hitting the neighbour", async () => {
    const state = await stateWith(
      sampleMapping({ createdAt: "2026-09-09T10:00:00.000Z" }),
      sampleMapping({ id: SECOND_ID, boxId: "box-2", createdAt: "2026-09-08T10:00:00.000Z" }),
    );
    const { opened, openPane } = recorder();
    const frames: string[] = [];
    async function* script(): AsyncIterable<string> {
      yield "j";
      await removeMapping(SECOND_ID, state);
      yield "d";
      yield "q";
    }
    await runDashboardPane({
      env: { UPSTASH_BOX_API_KEY: "k" },
      state,
      context: {},
      openPane,
      write: (chunk) => void frames.push(chunk),
      keys: script(),
      listBoxes: async () => listing([{ id: "box-1" }, { id: "box-2" }]),
      refreshMs: 0,
    });
    expect(opened).toEqual([]);
    expect(frames.some((frame) => frame.includes("left the list"))).toBe(true);
  });
});
