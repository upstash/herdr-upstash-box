import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_REMOTE_ROOT,
  HARNESS_IDS,
  MODES,
  NATIVE_KEYS,
  PREVIEW_AUTH,
  type HarnessId,
  type Mode,
  type NativeKey,
  type PreviewAuth,
} from "./constants.js";
import {
  assertHarnessSupportsModel,
  DEFAULT_MODELS,
  getHarness,
  providerFor,
  SUPPORTED_PROVIDERS,
} from "./harness.js";
import { PluginError } from "./result.js";

export const RUNTIMES = [
  "node",
  "python",
  "golang",
  "ruby",
  "rust",
  "node-alpine",
  "python-alpine",
  "golang-alpine",
  "ruby-alpine",
  "rust-alpine",
] as const;
export const SIZES = ["small", "medium", "large"] as const;

export interface PluginConfig {
  mode: Mode;
  harness: HarnessId;
  model: string;
  agentArgs: string[];
  nativeKey: NativeKey;
  runtime: (typeof RUNTIMES)[number];
  size: (typeof SIZES)[number];
  keepAlive: boolean;
  boxNamePrefix: string;
  remoteRoot: string;
  boxBin: string | null;
  providerApiKeyEnv: string | null;
  allowMultipleBoxes: boolean;
  excludedPaths: string[];
  allowSensitivePaths: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxUploadBytes: number;
  maxPatchBytes: number;
  agentRunTimeoutMs: number;
  scheduleTimeoutMs: number;
  maxRunResultBytes: number;
  runHistoryLimit: number;
  previewPorts: number[];
  previewAuth: PreviewAuth;
}

export const DEFAULT_CONFIG: Readonly<PluginConfig> = Object.freeze({
  mode: "tui",
  harness: "claude-code",
  model: "anthropic/claude-sonnet-5",
  agentArgs: [],
  nativeKey: "managed",
  runtime: "node",
  size: "small",
  keepAlive: false,
  boxNamePrefix: "herdr",
  remoteRoot: DEFAULT_REMOTE_ROOT,
  boxBin: null,
  providerApiKeyEnv: null,
  allowMultipleBoxes: false,
  excludedPaths: [],
  allowSensitivePaths: [],
  maxFiles: 10_000,
  maxFileBytes: 10 * 1024 * 1024,
  maxUploadBytes: 100 * 1024 * 1024,
  maxPatchBytes: 50 * 1024 * 1024,
  agentRunTimeoutMs: 600_000,
  scheduleTimeoutMs: 600_000,
  maxRunResultBytes: 262_144,
  runHistoryLimit: 50,
  previewPorts: [3000, 5173, 8000],
  previewAuth: "basic",
});

const ALLOWED_KEYS = new Set(Object.keys(DEFAULT_CONFIG));

function invalid(message: string): never {
  throw new PluginError("invalid_config", message);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], key: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    invalid(`${key} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function nullableString(value: unknown, key: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.trim() === "") {
    invalid(`${key} must be a non-empty string or null.`);
  }
  return value;
}

function requiredString(value: unknown, key: string): string {
  if (typeof value !== "string" || value.trim() === "")
    invalid(`${key} must be a non-empty string.`);
  return value;
}

function stringArray(value: unknown, key: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item !== "")) {
    invalid(`${key} must contain only non-empty strings.`);
  }
  return value as string[];
}

function bool(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") invalid(`${key} must be true or false.`);
  return value;
}

function positiveInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    invalid(`${key} must be a positive integer.`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    invalid(`${key} must be a non-negative integer.`);
  }
  return value;
}

function ports(value: unknown, key: string): number[] {
  if (
    !Array.isArray(value) ||
    !value.every((port) => Number.isInteger(port) && port > 0 && port < 65_536)
  ) {
    invalid(`${key} must contain valid TCP port numbers.`);
  }
  if (new Set(value).size !== value.length) invalid(`${key} must not contain duplicates.`);
  return value as number[];
}

function repositoryPaths(value: unknown, key: string, allowDirectory: boolean): string[] {
  const paths = stringArray(value, key);
  const bad = paths.find((item) => {
    const normalized = item.endsWith("/") ? item.slice(0, -1) : item;
    const components = normalized.split("/");
    return (
      item !== item.trim() ||
      item.includes("\\") ||
      item.includes("*") ||
      item.includes("?") ||
      item.startsWith("./") ||
      item.startsWith("/") ||
      (!allowDirectory && item.endsWith("/")) ||
      components.some((component) => component === "" || component === "." || component === "..")
    );
  });
  if (bad !== undefined) invalid(`${key} must contain safe paths relative to the repository root.`);
  if (new Set(paths).size !== paths.length) invalid(`${key} must not contain duplicates.`);
  return paths;
}

export function validateConfig(candidate: unknown): PluginConfig {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    invalid("config.json must contain one object.");
  }
  const record = candidate as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length > 0) invalid(`Unknown config keys: ${unknown.sort().join(", ")}.`);
  const merged: Record<string, unknown> = { ...DEFAULT_CONFIG, ...record };
  const config: PluginConfig = {
    mode: oneOf(merged.mode, MODES, "mode"),
    harness: oneOf(merged.harness, HARNESS_IDS, "harness"),
    model: requiredString(merged.model, "model"),
    agentArgs: stringArray(merged.agentArgs, "agentArgs"),
    nativeKey: oneOf(merged.nativeKey, NATIVE_KEYS, "nativeKey"),
    runtime: oneOf(merged.runtime, RUNTIMES, "runtime"),
    size: oneOf(merged.size, SIZES, "size"),
    keepAlive: bool(merged.keepAlive, "keepAlive"),
    boxNamePrefix: requiredString(merged.boxNamePrefix, "boxNamePrefix"),
    remoteRoot: requiredString(merged.remoteRoot, "remoteRoot"),
    boxBin: nullableString(merged.boxBin, "boxBin"),
    providerApiKeyEnv: nullableString(merged.providerApiKeyEnv, "providerApiKeyEnv"),
    allowMultipleBoxes: bool(merged.allowMultipleBoxes, "allowMultipleBoxes"),
    excludedPaths: repositoryPaths(merged.excludedPaths, "excludedPaths", true),
    allowSensitivePaths: repositoryPaths(merged.allowSensitivePaths, "allowSensitivePaths", false),
    maxFiles: positiveInteger(merged.maxFiles, "maxFiles"),
    maxFileBytes: positiveInteger(merged.maxFileBytes, "maxFileBytes"),
    maxUploadBytes: positiveInteger(merged.maxUploadBytes, "maxUploadBytes"),
    maxPatchBytes: positiveInteger(merged.maxPatchBytes, "maxPatchBytes"),
    agentRunTimeoutMs: positiveInteger(merged.agentRunTimeoutMs, "agentRunTimeoutMs"),
    scheduleTimeoutMs: positiveInteger(merged.scheduleTimeoutMs, "scheduleTimeoutMs"),
    maxRunResultBytes: positiveInteger(merged.maxRunResultBytes, "maxRunResultBytes"),
    runHistoryLimit: positiveInteger(merged.runHistoryLimit, "runHistoryLimit"),
    previewPorts: ports(merged.previewPorts, "previewPorts"),
    previewAuth: oneOf(merged.previewAuth, PREVIEW_AUTH, "previewAuth"),
  };
  assertHarnessSupportsModel(getHarness(config.harness), config.model);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(config.boxNamePrefix)) {
    invalid("boxNamePrefix must be lowercase letters, digits, and dashes.");
  }
  if (
    !path.posix.isAbsolute(config.remoteRoot) ||
    path.posix.normalize(config.remoteRoot) !== config.remoteRoot ||
    (config.remoteRoot !== "/workspace" && !config.remoteRoot.startsWith("/workspace/"))
  ) {
    invalid("remoteRoot must be /workspace or a normalized path below /workspace.");
  }
  if (config.providerApiKeyEnv !== null && !/^[A-Z][A-Z0-9_]*$/.test(config.providerApiKeyEnv)) {
    invalid("providerApiKeyEnv must be an environment variable name.");
  }
  return config;
}

// A one-off harness keeps the configured model only if that harness can use it, and drops
// agentArgs, which were written for the configured harness.
export function overrideHarness(config: PluginConfig, harnessId: HarnessId): PluginConfig {
  if (harnessId === config.harness) return config;
  getHarness(harnessId);
  const keepsModel = SUPPORTED_PROVIDERS[harnessId].includes(providerFor(config.model));
  return {
    ...config,
    harness: harnessId,
    model: keepsModel ? config.model : DEFAULT_MODELS[harnessId],
    agentArgs: [],
    providerApiKeyEnv: null,
  };
}

export function configDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!directory) {
    throw new PluginError("missing_plugin_config_dir", "HERDR_PLUGIN_CONFIG_DIR is not set.");
  }
  return path.resolve(directory);
}

export interface LoadOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
}

function readJson(file: string, label: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new PluginError("invalid_config", `Could not read ${label}: ${(error as Error).message}`);
  }
}

export function loadConfig(options: LoadOptions = {}): PluginConfig {
  const directory = options.directory ?? configDirectory(options.env);
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  return validateConfig(readJson(file, file));
}

export type Secrets = Readonly<Record<string, string>>;

export function checkSecretsFile(file: string, uid: number | undefined = process.getuid?.()): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) {
    throw new PluginError(
      "insecure_secrets_file",
      `${file} must be a regular file, not a symlink or directory.`,
    );
  }
  if (uid !== undefined && stat.uid !== uid) {
    throw new PluginError("insecure_secrets_file", `${file} must be owned by the current user.`);
  }
  // Ours and a regular file, so tighten it rather than making the caller run chmod. An editor
  // writing this file lands on 644 under the usual umask, which would otherwise fail every start.
  if ((stat.mode & 0o077) !== 0) {
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      throw new PluginError(
        "insecure_secrets_file",
        `${file} is readable by other users and could not be tightened: ${(error as Error).message}. Run: chmod 600 ${file}`,
      );
    }
  }
}

export function loadSecrets(options: LoadOptions = {}): Secrets {
  let directory: string;
  try {
    directory = options.directory ?? configDirectory(options.env);
  } catch {
    return {};
  }
  const file = path.join(directory, "secrets.json");
  if (!fs.existsSync(file)) return {};
  checkSecretsFile(file);
  const parsed = readJson(file, file);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PluginError("invalid_config", "secrets.json must contain one object.");
  }
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new PluginError(
        "invalid_config",
        `secrets.json entry ${key} must map a variable name to a string.`,
      );
    }
    if (value !== "") secrets[key] = value;
  }
  return secrets;
}

export function resolveSecret(
  name: string,
  options: { env?: NodeJS.ProcessEnv; secrets?: Secrets } = {},
): string | undefined {
  const env = options.env ?? process.env;
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = options.secrets?.[name]?.trim();
  return fromFile || undefined;
}
