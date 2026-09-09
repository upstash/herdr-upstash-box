import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAPPING_ID_ENV } from "../src/constants.js";
import { PluginError } from "../src/result.js";
import {
  activeMappingsForRoot,
  finalizeConnection,
  isActive,
  withMappingLock,
  guardedPatch,
  mappingForContext,
  patchMapping,
  readState,
  removeMapping,
  requireMapping,
  updateState,
  validateState,
} from "../src/state.js";
import { MAPPING_ID, remove, sampleMapping, temporaryDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

function stateDir(): string {
  const directory = temporaryDirectory();
  directories.push(directory);
  return directory;
}

async function seeded(...mappings: ReturnType<typeof sampleMapping>[]) {
  const directory = stateDir();
  await updateState(
    (state) => {
      for (const mapping of mappings) state.mappings[mapping.id] = mapping;
    },
    { directory },
  );
  return { directory };
}

describe("state file", () => {
  it("starts empty and round-trips a mapping", async () => {
    const directory = stateDir();
    expect(readState({ directory }).mappings).toEqual({});
    const mapping = sampleMapping();
    await updateState(
      (state) => {
        state.mappings[mapping.id] = mapping;
      },
      { directory },
    );
    expect(readState({ directory }).mappings[mapping.id]).toEqual(mapping);
    const raw = fs.readFileSync(path.join(directory, "state.json"), "utf8");
    expect(JSON.parse(raw).schemaVersion).toBe(1);
  });

  it("serialises concurrent updates through the lock", async () => {
    const state = await seeded(sampleMapping());
    await Promise.all(
      ["a", "b", "c", "d"].map((label) =>
        updateState((draft) => {
          const current = draft.mappings[MAPPING_ID];
          if (!current) throw new Error("missing");
          current.labels = [...current.labels, label];
        }, state),
      ),
    );
    expect(readState(state).mappings[MAPPING_ID]?.labels).toHaveLength(6);
  });

  it("patches a mapping and bumps updatedAt", async () => {
    const state = await seeded(sampleMapping());
    const patched = await patchMapping(MAPPING_ID, { lifecycleState: "connected" }, state);
    expect(patched.lifecycleState).toBe("connected");
    expect(patched.updatedAt).not.toBe(sampleMapping().updatedAt);
    await removeMapping(MAPPING_ID, state);
    expect(readState(state).mappings).toEqual({});
    await expect(patchMapping(MAPPING_ID, {}, state)).rejects.toThrow(/no longer exists/);
  });

  it("refuses to write an invalid mapping", async () => {
    const directory = stateDir();
    await expect(
      updateState(
        (state) => {
          state.mappings.x = sampleMapping({ id: "x", lifecycleState: "flying" as never });
        },
        { directory },
      ),
    ).rejects.toThrow(PluginError);
    await expect(
      updateState(
        (state) => {
          state.mappings.y = sampleMapping({ id: "y", lastAppliedExportCommit: "short" });
        },
        { directory },
      ),
    ).rejects.toThrow(PluginError);
    expect(fs.existsSync(path.join(directory, "state.json"))).toBe(false);
  });

  it("rejects a foreign schema version", () => {
    expect(() => validateState({ schemaVersion: 2, mappings: {} })).toThrow(
      /Unsupported state schema/,
    );
  });
});

describe("guarded transitions", () => {
  it("finalizes only the connection that still owns the mapping", async () => {
    const state = await seeded(
      sampleMapping({ connectionId: "token-1", lifecycleState: "connected" }),
    );
    expect(
      await finalizeConnection(MAPPING_ID, "token-2", { lifecycleState: "ready" }, state),
    ).toBeNull();
    expect(readState(state).mappings[MAPPING_ID]?.lifecycleState).toBe("connected");
    const done = await finalizeConnection(
      MAPPING_ID,
      "token-1",
      { lifecycleState: "ready" },
      state,
    );
    expect(done?.lifecycleState).toBe("ready");
    expect(done?.connectionId).toBeNull();
    expect(
      await finalizeConnection(MAPPING_ID, "token-1", { lifecycleState: "failed" }, state),
    ).toBeNull();
  });

  it("treats a vanished mapping as a no-op rather than an error", async () => {
    const state = await seeded();
    expect(await guardedPatch("nope", () => true, { lifecycleState: "ready" }, state)).toBeNull();
  });
});

describe("mapping lookup", () => {
  const first = sampleMapping({ id: MAPPING_ID, sourcePaneId: "pane-1", remotePaneId: "pane-9" });
  const second = sampleMapping({
    id: "22222222-2222-4222-8222-222222222222",
    sourcePaneId: "pane-2",
    localRoot: "/other",
    localCwd: "/other/sub",
    relativeCwd: "sub",
  });
  const newest = sampleMapping({
    id: "33333333-3333-4333-8333-333333333333",
    sourcePaneId: "pane-2",
    localRoot: "/other",
    localCwd: "/other",
    updatedAt: "2026-09-10T00:00:00.000Z",
  });
  const state = {
    schemaVersion: 1 as const,
    mappings: { [first.id]: first, [second.id]: second, [newest.id]: newest },
  };

  it("honours an explicit mapping id from the environment", () => {
    expect(mappingForContext(state, {}, { env: { [MAPPING_ID_ENV]: second.id } })).toBe(second);
  });

  it("matches the agent pane before the source pane", () => {
    expect(mappingForContext(state, { focused_pane_id: "pane-9" }, { env: {} })).toBe(first);
  });

  it("refuses to guess when several mappings match, and says how to pick", () => {
    expect(() => mappingForContext(state, { focused_pane_id: "pane-2" }, { env: {} })).toThrow(
      /2 boxes match pane pane-2.*HERDR_BOX_MAPPING_ID/,
    );
    expect(() => mappingForContext(state, { focused_pane_cwd: "/other" }, { env: {} })).toThrow(
      /ambiguous|2 boxes match/,
    );
    expect(mappingForContext(state, { focused_pane_cwd: "/nowhere" }, { env: {} })).toBeNull();
    expect(
      mappingForContext(
        state,
        { focused_pane_id: "pane-2" },
        { env: { HERDR_BOX_MAPPING_ID: newest.id } },
      ),
    ).toBe(newest);
  });

  it("lists active mappings for a worktree, skipping dead ones", () => {
    const dead = sampleMapping({
      id: "44444444-4444-4444-8444-444444444444",
      lifecycleState: "missing",
    });
    const withDead = { ...state, mappings: { ...state.mappings, [dead.id]: dead } };
    expect(activeMappingsForRoot(withDead, "/repo").map((m) => m.id)).toEqual([first.id]);
    expect(activeMappingsForRoot(withDead, "/other")).toHaveLength(2);
  });

  it("requireMapping names the failure", () => {
    expect(() => requireMapping(state, {}, { env: {} })).toThrow(/No Upstash Box mapping/);
  });
});

describe("reservations and operation locks", () => {
  it("counts a provisional mapping as active so two starts cannot race", () => {
    const reserved = sampleMapping({ lifecycleState: "provisional", boxId: null });
    expect(isActive(reserved)).toBe(true);
    expect(
      activeMappingsForRoot({ schemaVersion: 1, mappings: { [reserved.id]: reserved } }, "/repo"),
    ).toHaveLength(1);
  });

  it("runs one operation per mapping at a time and releases the lock afterwards", async () => {
    const state = await seeded(sampleMapping());
    let release: (value: string) => void = () => undefined;
    const first = withMappingLock(
      MAPPING_ID,
      state,
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(withMappingLock(MAPPING_ID, state, async () => "second")).rejects.toMatchObject({
      code: "operation_in_progress",
    });
    release("done");
    expect(await first).toBe("done");
    expect(await withMappingLock(MAPPING_ID, state, async () => "again")).toBe("again");
  });
});
