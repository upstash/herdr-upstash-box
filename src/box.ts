import crypto from "node:crypto";
import path from "node:path";
import { Box, BoxError, type BoxConfig, type BoxData } from "@upstash/box";
import { loadSecrets, resolveSecret, type PluginConfig, type Secrets } from "./config.js";
import { BOX_API_KEY_ENV, BOX_LABEL, MAX_BOX_NAME_LENGTH } from "./constants.js";
import { providerKeyEnv } from "./harness.js";
import { PluginError } from "./result.js";
import type { Mapping } from "./state.js";

export type BoxStatus = BoxData["status"];

export interface BoxClient {
  get(id: string, apiKey: string): Promise<Box>;
  list(apiKey: string, label: string): Promise<BoxData[]>;
  create(config: BoxConfig): Promise<Box>;
  fromSnapshot(snapshotId: string, config: BoxConfig): Promise<Box>;
}

export const sdkClient: BoxClient = {
  get: (id, apiKey) => Box.get(id, { apiKey }),
  list: (apiKey, label) => Box.list({ apiKey, label }),
  create: (config) => Box.create(config),
  fromSnapshot: (snapshotId, config) => Box.fromSnapshot(snapshotId, config),
};

export interface KeyOptions {
  env?: NodeJS.ProcessEnv;
  secrets?: Secrets;
}

function secretsFor(options: KeyOptions): Secrets {
  return options.secrets ?? loadSecrets({ env: options.env });
}

export function boxApiKey(options: KeyOptions = {}): string {
  const key = resolveSecret(BOX_API_KEY_ENV, { env: options.env, secrets: secretsFor(options) });
  if (!key) {
    throw new PluginError(
      "box_api_key_missing",
      `Set ${BOX_API_KEY_ENV} in the environment or in secrets.json in the plugin config directory.`,
    );
  }
  return key;
}

export interface ProviderKey {
  name: string;
  value: string;
}

export function providerKeyName(config: Pick<PluginConfig, "providerApiKeyEnv" | "model">): string {
  return config.providerApiKeyEnv ?? providerKeyEnv(config.model);
}

export function providerApiKey(
  config: Pick<PluginConfig, "providerApiKeyEnv" | "model">,
  options: KeyOptions = {},
): ProviderKey | null {
  const name = providerKeyName(config);
  const value = resolveSecret(name, { env: options.env, secrets: secretsFor(options) });
  return value ? { name, value } : null;
}

export function requireProviderApiKey(
  config: Pick<PluginConfig, "providerApiKeyEnv" | "model" | "mode">,
  options: KeyOptions = {},
): ProviderKey {
  const key = providerApiKey(config, options);
  if (!key) {
    const name = providerKeyName(config);
    throw new PluginError(
      "provider_api_key_missing",
      config.mode === "tui"
        ? `TUI mode needs ${name} for model ${config.model}. Set it in the environment or secrets.json, or switch mode to native.`
        : `nativeKey is "local", which needs ${name} for model ${config.model}. Set it, or switch nativeKey to "managed".`,
    );
  }
  return key;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function boxNameFor(options: {
  prefix: string;
  harness: string;
  localRoot: string;
  mappingId: string;
}): string {
  const prefix = slug(options.prefix).slice(0, 12) || "herdr";
  const harness = slug(options.harness).slice(0, 12);
  const digest = crypto
    .createHash("sha256")
    .update(`${options.localRoot} ${options.mappingId}`)
    .digest("hex")
    .slice(0, 8);
  const fixed = prefix.length + harness.length + digest.length + 3;
  const room = Math.max(1, MAX_BOX_NAME_LENGTH - fixed);
  const base = slug(path.basename(options.localRoot)).slice(0, room) || "worktree";
  return slug(`${prefix}-${harness}-${base}-${digest}`);
}

// Labels are capped at 20 characters, so 16 hex characters of the mapping id are kept.
export function mappingLabel(mappingId: string): string {
  return `hm:${mappingId.replace(/-/g, "").slice(0, 16)}`;
}

export function labelsFor(mappingId: string): string[] {
  return [BOX_LABEL, mappingLabel(mappingId)];
}

export async function findBoxForMapping(
  mapping: Pick<Mapping, "id" | "boxName">,
  client: BoxClient,
  apiKey: string,
): Promise<BoxData | null> {
  const boxes = await client.list(apiKey, mappingLabel(mapping.id));
  const live = boxes.filter((box) => box.status !== "deleted" && box.name === mapping.boxName);
  if (live.length > 1) {
    throw new PluginError(
      "ambiguous_box",
      `${live.length} boxes carry label ${mappingLabel(mapping.id)} and name ${mapping.boxName}: ${live
        .map((box) => box.id)
        .join(", ")}. Resolve this in the Box console before continuing.`,
    );
  }
  return live[0] ?? null;
}

export async function openBox(
  mapping: Mapping,
  options: { client?: BoxClient; apiKey?: string } & KeyOptions = {},
): Promise<Box> {
  const client = options.client ?? sdkClient;
  const apiKey = options.apiKey ?? boxApiKey(options);
  let boxId = mapping.boxId;
  if (!boxId) {
    const found = await findBoxForMapping(mapping, client, apiKey);
    if (!found) {
      throw new PluginError("box_not_provisioned", `Mapping ${mapping.id} has no box yet.`);
    }
    boxId = found.id;
  }
  return client.get(boxId, apiKey);
}

export async function currentStatus(box: Box): Promise<BoxStatus> {
  const { status } = await box.getStatus();
  return status as BoxStatus;
}

export function isLive(status: string): boolean {
  return status === "running" || status === "idle";
}

export interface EnsureRunningOptions {
  onResume?: () => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  now?: () => number;
}

export async function ensureRunning(
  box: Box,
  options: EnsureRunningOptions = {},
): Promise<{ status: BoxStatus; resumed: boolean }> {
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 120_000);
  let status = await currentStatus(box);
  if (isLive(status)) return { status, resumed: false };
  if (status === "deleted") {
    throw new PluginError("box_deleted", `Box ${box.id} has been deleted.`);
  }
  if (status === "error") {
    throw new PluginError("box_error", `Box ${box.id} is in an error state.`);
  }
  if (status === "paused") {
    options.onResume?.();
    await box.resume();
  }
  while (now() < deadline) {
    await sleep(1000);
    status = await currentStatus(box);
    if (isLive(status)) return { status, resumed: true };
    if (status === "deleted" || status === "error") {
      throw new PluginError("box_unavailable", `Box ${box.id} became ${status} while resuming.`);
    }
  }
  throw new PluginError(
    "box_resume_timeout",
    `Box ${box.id} did not come back within the timeout.`,
  );
}

export async function deleteBoxForMapping(
  mapping: Mapping,
  options: { client?: BoxClient; apiKey?: string } & KeyOptions = {},
): Promise<"deleted" | "already_gone"> {
  let box: Box;
  try {
    box = await openBox(mapping, options);
  } catch (error) {
    if (error instanceof PluginError && error.code === "box_not_provisioned") return "already_gone";
    if (error instanceof BoxError && error.statusCode === 404) return "already_gone";
    throw error;
  }
  try {
    await box.delete();
  } catch (error) {
    if (error instanceof BoxError && error.statusCode === 404) return "already_gone";
    throw error;
  }
  return "deleted";
}
