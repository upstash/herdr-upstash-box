import type { BoxConfig } from "@upstash/box";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { GitContext } from "../src/context.js";
import { buildUploadManifest, type UploadManifest } from "../src/manifest.js";
import {
  boxCreateConfig,
  describeStart,
  prepareStart,
  provisionStart,
  remoteWorkingDirectory,
} from "../src/start.js";
import { readState, updateState } from "../src/state.js";
import {
  fakeBox,
  fakeClient,
  makeGitRepository,
  MAPPING_ID,
  remove,
  sampleMapping,
  temporaryDirectory,
} from "./helpers.js";

const withKey = { env: { ANTHROPIC_API_KEY: "provider-secret" }, secrets: {} };
const noKey = { env: {}, secrets: {} };
const BASELINE = "c".repeat(40);

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

function stubManifest(root = "/repo"): UploadManifest {
  return { schemaVersion: 1, root, files: [], excluded: [], totalBytes: 0, digest: "e".repeat(64) };
}

function gitContextFor(root = "/repo"): GitContext {
  return {
    root,
    cwd: `${root}/packages/app`,
    relativeCwd: "packages/app",
    branch: "feature/x",
    sourcePaneId: "pane-1",
  };
}

function prepare(config = DEFAULT_CONFIG, keys = withKey, root = "/repo") {
  return prepareStart(
    {},
    {
      config,
      gitContext: gitContextFor(root),
      keys,
      mappingId: MAPPING_ID,
      manifest: stubManifest(root),
    },
  );
}

describe("prepareStart", () => {
  it("requires a provider key", () => {
    expect(() => prepare(DEFAULT_CONFIG, noKey)).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("names and labels the box from the mapping id", () => {
    const prepared = prepare();
    expect(prepared.providerKey.name).toBe("ANTHROPIC_API_KEY");
    expect(prepared.labels).toEqual(["herdr", "hm:1234567812344123"]);
    expect(prepared.boxName).toMatch(/^herdr-claude-code-repo-[0-9a-f]{8}$/);
  });

  it("refuses an incompatible harness and model before anything is created", () => {
    expect(() => prepare({ ...DEFAULT_CONFIG, harness: "codex" }, withKey)).toThrow(
      /Responses API/,
    );
  });

  it("builds the upload manifest from the worktree", () => {
    const root = makeGitRepository();
    directories.push(root);
    const prepared = prepareStart(
      {},
      {
        config: DEFAULT_CONFIG,
        gitContext: gitContextFor(root),
        keys: withKey,
        mappingId: MAPPING_ID,
      },
    );
    expect(prepared.manifest.files.map((file) => file.path)).toEqual(["README.md"]);
  });
});

describe("boxCreateConfig and describeStart", () => {
  it("never hands the provider key to the box", () => {
    const config = boxCreateConfig(prepare(), "box-key");
    expect(config).toEqual({
      apiKey: "box-key",
      name: prepare().boxName,
      labels: prepare().labels,
      runtime: "node",
      size: "small",
      keepAlive: false,
    });
    expect(JSON.stringify(config)).not.toContain("provider-secret");
  });

  it("describes the plan and upload without leaking the secret", () => {
    const text = describeStart(prepare());
    expect(text).toContain("Worktree: /repo (feature/x)");
    expect(text).toContain("ANTHROPIC_API_KEY from this machine, passed per session");
    expect(text).toContain("Upload: 0 files");
    expect(text).not.toContain("provider-secret");
  });

  it("maps the local cwd under the remote root", () => {
    expect(
      remoteWorkingDirectory({ remoteRoot: "/workspace/home", relativeCwd: "packages/app" }),
    ).toBe("/workspace/home/packages/app");
    expect(remoteWorkingDirectory({ remoteRoot: "/workspace/home", relativeCwd: "." })).toBe(
      "/workspace/home",
    );
  });
});

function boxForProvision(id = "box-9") {
  return fakeBox({
    id,
    commandOutput: (command) => ({
      stdout: command.includes("git rev-parse HEAD")
        ? `${BASELINE}\n`
        : command.includes("tmux")
          ? "TMUX_READY\n"
          : "",
    }),
  });
}

describe("provisionStart", () => {
  it("creates, uploads, baselines, prepares, and marks the mapping ready", async () => {
    const root = makeGitRepository();
    directories.push(root);
    const directory = temporaryDirectory();
    directories.push(directory);
    const { box, calls } = boxForProvision();
    const client = fakeClient({ created: box });
    const prepared = prepareStart(
      {},
      {
        config: DEFAULT_CONFIG,
        gitContext: gitContextFor(root),
        keys: withKey,
        mappingId: MAPPING_ID,
      },
    );
    const lifecycle: string[] = [];
    const { mapping } = await provisionStart(prepared, {
      client,
      apiKey: "box-key",
      state: { directory },
      onLifecycle: (state) => {
        lifecycle.push(state);
      },
    });
    expect(lifecycle).toEqual(["creating", "uploading", "preparing"]);
    expect(mapping).toMatchObject({
      boxId: "box-9",
      lifecycleState: "ready",
      prepared: true,
      relativeCwd: "packages/app",
      uploadDigest: prepared.manifest.digest,
      lastAppliedExportCommit: BASELINE,
      connectionId: null,
    });
    expect(client.created[0]?.name).toBe(prepared.boxName);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.commands.some((command) => command.includes("tar -xf"))).toBe(true);
    expect(calls.commands.some((command) => command.includes("git init"))).toBe(true);
    expect(calls.commands.some((command) => command.includes("tmux"))).toBe(true);
    expect(readState({ directory }).mappings[MAPPING_ID]).toEqual(mapping);
  });

  it("refuses a second box for a worktree that already has one", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    await updateState(
      (state) => {
        state.mappings.existing = sampleMapping({ id: "existing", localRoot: "/repo" });
      },
      { directory },
    );
    const { box } = boxForProvision();
    await expect(
      provisionStart(prepare(), {
        client: fakeClient({ created: box }),
        apiKey: "k",
        state: { directory },
      }),
    ).rejects.toMatchObject({ code: "mapping_exists" });
    const allowed = await provisionStart(prepare({ ...DEFAULT_CONFIG, allowMultipleBoxes: true }), {
      client: fakeClient({ created: box }),
      apiKey: "k",
      state: { directory },
    });
    expect(allowed.mapping.lifecycleState).toBe("ready");
  });

  it("marks the mapping failed with the reason when creation throws", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    await expect(
      provisionStart(prepare(), { client: fakeClient({}), apiKey: "k", state: { directory } }),
    ).rejects.toThrow(/no created box configured/);
    const failed = readState({ directory }).mappings[MAPPING_ID];
    expect(failed?.lifecycleState).toBe("failed");
    expect(failed?.lastError).toContain("no created box configured");
    expect(failed?.boxId).toBeNull();
    expect(failed?.prepared).toBe(false);
  });
});

describe("interleaved starts", () => {
  it("lets only one of two concurrent starts for the same worktree create a box", async () => {
    const directory = temporaryDirectory();
    directories.push(directory);
    const { box } = boxForProvision("box-race");
    const base = fakeClient({ created: box });
    const client = {
      ...base,
      create: async (config: BoxConfig) => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return base.create(config);
      },
    };
    const first = prepareStart(
      {},
      {
        config: DEFAULT_CONFIG,
        gitContext: gitContextFor(),
        keys: withKey,
        mappingId: MAPPING_ID,
        manifest: stubManifest(),
      },
    );
    const second = prepareStart(
      {},
      {
        config: DEFAULT_CONFIG,
        gitContext: gitContextFor(),
        keys: withKey,
        mappingId: "22222222-2222-4222-8222-222222222222",
        manifest: stubManifest(),
      },
    );
    const results = await Promise.allSettled([
      provisionStart(first, { client, apiKey: "k", state: { directory } }),
      provisionStart(second, { client, apiKey: "k", state: { directory } }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "mapping_exists" });
    expect(base.created).toHaveLength(1);
  });
});
