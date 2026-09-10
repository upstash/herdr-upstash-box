import crypto from "node:crypto";
import type { Box, BoxConfig, Snapshot } from "@upstash/box";
import {
  boxApiKey,
  boxNameFor,
  labelsFor,
  sdkClient,
  type BoxClient,
  type KeyOptions,
} from "./box.js";
import type { PluginConfig } from "./config.js";
import { errorMessage } from "./result.js";
import { nowIso, patchMapping, updateState, type Mapping, type StateOptions } from "./state.js";

export function snapshotName(mapping: Pick<Mapping, "boxName">, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  return `${mapping.boxName}-${stamp}`.slice(0, 80);
}

export function snapshotRecord(snapshot: Pick<Snapshot, "id" | "name">, at = nowIso()) {
  return { id: snapshot.id, name: snapshot.name, at };
}

// A fork carries no credential either; the agent pane passes one per session, as for Start.
export function forkCreateConfig(apiKey: string, mappingId: string, boxName: string): BoxConfig {
  return { apiKey, name: boxName, labels: labelsFor(mappingId) };
}

// A fork is reachable only from the dashboard or its own pane, so it carries no source pane.
export function reservedFork(original: Mapping, mappingId: string, boxName: string): Mapping {
  const createdAt = nowIso();
  return {
    ...original,
    id: mappingId,
    sourcePaneId: null,
    remotePaneId: null,
    connectionId: null,
    boxId: null,
    boxName,
    labels: labelsFor(mappingId),
    lifecycleState: "provisional",
    lastSnapshot: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
}

export interface ForkOptions {
  config: PluginConfig;
  client?: BoxClient;
  apiKey?: string;
  keys?: KeyOptions;
  state?: StateOptions;
  mappingId?: string;
  onProgress?: (step: "snapshot" | "create" | "record") => void;
}

// The child mapping exists before anything billable, so a crash leaves a record that label recovery can finish.
export async function forkMapping(
  original: Mapping,
  box: Box,
  options: ForkOptions,
): Promise<{ mapping: Mapping; snapshot: Snapshot }> {
  const client = options.client ?? sdkClient;
  const keys = options.keys ?? {};
  const apiKey = options.apiKey ?? boxApiKey(keys);
  const mappingId = options.mappingId ?? crypto.randomUUID();
  const boxName = boxNameFor({
    prefix: options.config.boxNamePrefix,
    harness: original.harness,
    localRoot: original.localRoot,
    mappingId,
  });
  const createConfig = forkCreateConfig(apiKey, mappingId, boxName);
  await updateState((state) => {
    state.mappings[mappingId] = reservedFork(original, mappingId, boxName);
    return state;
  }, options.state);
  try {
    options.onProgress?.("snapshot");
    const snapshot = await box.snapshot({ name: snapshotName(original) });
    const record = snapshotRecord(snapshot);
    await patchMapping(original.id, { lastSnapshot: record }, options.state);
    await patchMapping(
      mappingId,
      { lastSnapshot: record, lifecycleState: "creating" },
      options.state,
    );
    options.onProgress?.("create");
    const forked = await client.fromSnapshot(snapshot.id, createConfig);
    options.onProgress?.("record");
    const mapping = await patchMapping(
      mappingId,
      { boxId: forked.id, lifecycleState: "ready", lastError: null },
      options.state,
    );
    return { mapping, snapshot };
  } catch (error) {
    await patchMapping(
      mappingId,
      { lifecycleState: "failed", lastError: errorMessage(error) },
      options.state,
    ).catch(() => undefined);
    throw error;
  }
}
