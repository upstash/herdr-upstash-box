import crypto from "node:crypto";
import path from "node:path";
import type { Box, BoxConfig } from "@upstash/box";
import {
  boxApiKey,
  boxNameFor,
  labelsFor,
  requireProviderApiKey,
  sdkClient,
  type BoxClient,
  type KeyOptions,
  type ProviderKey,
} from "./box.js";
import { loadConfig, type PluginConfig } from "./config.js";
import { STATE_SCHEMA_VERSION, type LifecycleState } from "./constants.js";
import { resolveGitContext, type GitContext, type PluginContext } from "./context.js";
import { assertHarnessSupportsModel, getHarness, type Harness } from "./harness.js";
import { buildUploadManifest, formatManifestSummary, type UploadManifest } from "./manifest.js";
import { errorMessage, PluginError } from "./result.js";
import { ensureTmux } from "./session.js";
import {
  activeMappingsForRoot,
  nowIso,
  patchMapping,
  updateState,
  type Mapping,
  type PluginState,
  type StateOptions,
} from "./state.js";
import { initializeRemoteBaseline, uploadWorktree } from "./transfer.js";

export interface PreparedStart {
  context: PluginContext;
  config: PluginConfig;
  harness: Harness;
  gitContext: GitContext;
  mappingId: string;
  boxName: string;
  labels: string[];
  providerKey: ProviderKey;
  manifest: UploadManifest;
}

export interface PrepareOptions {
  config?: PluginConfig;
  gitContext?: GitContext;
  mappingId?: string;
  keys?: KeyOptions;
  env?: NodeJS.ProcessEnv;
  manifest?: UploadManifest;
}

export function providerKeyForStart(config: PluginConfig, keys: KeyOptions): ProviderKey {
  return requireProviderApiKey(config, keys);
}

export function assertNoActiveMapping(
  state: PluginState,
  root: string,
  config: Pick<PluginConfig, "allowMultipleBoxes">,
): void {
  if (config.allowMultipleBoxes) return;
  const active = activeMappingsForRoot(state, root)[0];
  if (active) {
    throw new PluginError(
      "mapping_exists",
      `A box already exists for ${root}: ${active.boxName} (${active.lifecycleState}). Reconnect to it, stop and delete it, or set allowMultipleBoxes in config.json.`,
    );
  }
}

export function prepareStart(context: PluginContext, options: PrepareOptions = {}): PreparedStart {
  const config = options.config ?? loadConfig({ env: options.env });
  const harness = getHarness(config.harness);
  assertHarnessSupportsModel(harness, config.model);
  const gitContext = options.gitContext ?? resolveGitContext(context, { env: options.env });
  const providerKey = providerKeyForStart(config, options.keys ?? { env: options.env });
  const manifest = options.manifest ?? buildUploadManifest(gitContext.root, config);
  const mappingId = options.mappingId ?? crypto.randomUUID();
  return {
    context,
    config,
    harness,
    gitContext,
    mappingId,
    boxName: boxNameFor({
      prefix: config.boxNamePrefix,
      harness: config.harness,
      localRoot: gitContext.root,
      mappingId,
    }),
    labels: labelsFor(mappingId),
    providerKey,
    manifest,
  };
}

export function remoteWorkingDirectory(
  mapping: Pick<Mapping, "remoteRoot" | "relativeCwd">,
): string {
  return mapping.relativeCwd === "."
    ? mapping.remoteRoot
    : path.posix.join(mapping.remoteRoot, mapping.relativeCwd);
}

// The provider key is never handed to the box; it travels only inside each exec session.
export function boxCreateConfig(prepared: PreparedStart, apiKey: string): BoxConfig {
  const { config } = prepared;
  return {
    apiKey,
    name: prepared.boxName,
    labels: prepared.labels,
    runtime: config.runtime,
    size: config.size,
    keepAlive: config.keepAlive,
  };
}

export function describeStart(prepared: PreparedStart): string {
  const { config, gitContext } = prepared;
  return [
    `Worktree: ${gitContext.root}${gitContext.branch ? ` (${gitContext.branch})` : ""}`,
    `Box: ${prepared.boxName}`,
    `Agent: ${prepared.harness.title}`,
    `Model: ${config.model}`,
    `Runtime: ${config.runtime}, ${config.size}${config.keepAlive ? ", keep-alive" : ""}`,
    `Credential: ${prepared.providerKey.name} from this machine, passed per session`,
    `Remote root: ${config.remoteRoot}`,
    `Labels: ${prepared.labels.join(", ")}`,
    "",
    formatManifestSummary(prepared.manifest),
  ].join("\n");
}

export function newMapping(prepared: PreparedStart): Mapping {
  const createdAt = nowIso();
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    id: prepared.mappingId,
    harness: prepared.config.harness,
    model: prepared.config.model,
    sourcePaneId: prepared.gitContext.sourcePaneId,
    remotePaneId: null,
    connectionId: null,
    boxId: null,
    boxName: prepared.boxName,
    labels: prepared.labels,
    localRoot: prepared.gitContext.root,
    localCwd: prepared.gitContext.cwd,
    relativeCwd: prepared.gitContext.relativeCwd,
    remoteRoot: prepared.config.remoteRoot,
    branch: prepared.gitContext.branch,
    lifecycleState: "provisional",
    prepared: false,
    everAttached: false,
    uploadDigest: null,
    lastAppliedExportCommit: null,
    lastSnapshot: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export interface PrepareBoxDeps {
  onLifecycle?: (state: LifecycleState) => void | Promise<void>;
  upload?: typeof uploadWorktree;
  baseline?: typeof initializeRemoteBaseline;
  tmux?: typeof ensureTmux;
}

export interface Preparation {
  baselineCommit: string;
  uploadDigest: string;
}

// Idempotent: a rerun re-uploads, re-baselines, and reinstalls nothing that is already there.
export async function prepareBoxForMapping(
  box: Box,
  mapping: Mapping,
  manifest: UploadManifest,
  deps: PrepareBoxDeps = {},
): Promise<Preparation> {
  await deps.onLifecycle?.("uploading");
  await (deps.upload ?? uploadWorktree)(box, mapping, manifest);
  await deps.onLifecycle?.("preparing");
  const baselineCommit = await (deps.baseline ?? initializeRemoteBaseline)(box, mapping);
  await (deps.tmux ?? ensureTmux)(box);
  return { baselineCommit, uploadDigest: manifest.digest };
}

export interface EnsurePreparedDeps extends PrepareBoxDeps {
  save: (patch: Partial<Mapping>) => Promise<Mapping>;
  manifest?: UploadManifest;
}

export async function ensurePrepared(
  box: Box,
  mapping: Mapping,
  config: PluginConfig,
  deps: EnsurePreparedDeps,
): Promise<Mapping> {
  if (mapping.prepared) return mapping;
  const manifest = deps.manifest ?? buildUploadManifest(mapping.localRoot, config);
  const preparation = await prepareBoxForMapping(box, mapping, manifest, deps);
  return deps.save({
    prepared: true,
    uploadDigest: preparation.uploadDigest,
    lastAppliedExportCommit: preparation.baselineCommit,
  });
}

export interface ProvisionOptions extends PrepareBoxDeps {
  client?: BoxClient;
  apiKey?: string;
  keys?: KeyOptions;
  state?: StateOptions;
}

export async function provisionStart(
  prepared: PreparedStart,
  options: ProvisionOptions = {},
): Promise<{ mapping: Mapping; box: Box }> {
  const client = options.client ?? sdkClient;
  const apiKey = options.apiKey ?? boxApiKey(options.keys);
  const mapping = newMapping(prepared);
  const id = mapping.id;
  await updateState((state) => {
    if (state.mappings[id]) {
      throw new PluginError(
        "mapping_id_collision",
        "Start generated a duplicate mapping id. Run Start again.",
      );
    }
    assertNoActiveMapping(state, mapping.localRoot, prepared.config);
    state.mappings[id] = mapping;
    return state;
  }, options.state);
  const lifecycle = async (lifecycleState: LifecycleState): Promise<void> => {
    await patchMapping(id, { lifecycleState }, options.state);
    await options.onLifecycle?.(lifecycleState);
  };
  try {
    await lifecycle("creating");
    const box = await client.create(boxCreateConfig(prepared, apiKey));
    const withBox = await patchMapping(id, { boxId: box.id }, options.state);
    const preparation = await prepareBoxForMapping(box, withBox, prepared.manifest, {
      ...options,
      onLifecycle: lifecycle,
    });
    const ready = await patchMapping(
      id,
      {
        lifecycleState: "ready",
        prepared: true,
        uploadDigest: preparation.uploadDigest,
        lastAppliedExportCommit: preparation.baselineCommit,
        lastError: null,
      },
      options.state,
    );
    return { mapping: ready, box };
  } catch (error) {
    await patchMapping(
      id,
      { lifecycleState: "failed", lastError: errorMessage(error) },
      options.state,
    ).catch(() => undefined);
    throw error;
  }
}
