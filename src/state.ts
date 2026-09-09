import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  CREDENTIALS,
  HARNESS_IDS,
  LIFECYCLE_STATES,
  MAPPING_ID_ENV,
  MODES,
  STATE_SCHEMA_VERSION,
  type Credential,
  type HarnessId,
  type LifecycleState,
  type Mode,
} from "./constants.js";
import type { PluginContext } from "./context.js";
import { PluginError } from "./result.js";

export interface Mapping {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  id: string;
  mode: Mode;
  harness: HarnessId;
  model: string;
  credential: Credential;
  sourcePaneId: string | null;
  remotePaneId: string | null;
  connectionId: string | null;
  boxId: string | null;
  boxName: string;
  labels: string[];
  localRoot: string;
  localCwd: string;
  relativeCwd: string;
  remoteRoot: string;
  branch: string | null;
  lifecycleState: LifecycleState;
  prepared: boolean;
  everAttached: boolean;
  uploadDigest: string | null;
  lastAppliedExportCommit: string | null;
  lastSnapshot: { id: string; name: string; at: string } | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginState {
  schemaVersion: typeof STATE_SCHEMA_VERSION;
  mappings: Record<string, Mapping>;
}

const BOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || nonEmptyString(value);
}

function nullableMatch(value: unknown, pattern: RegExp): boolean {
  return value === null || (typeof value === "string" && pattern.test(value));
}

function validSnapshot(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return (
    nonEmptyString(snapshot.id) && nonEmptyString(snapshot.name) && nonEmptyString(snapshot.at)
  );
}

function safeRelativePath(value: unknown): value is string {
  return (
    value === "." ||
    (nonEmptyString(value) &&
      !path.posix.isAbsolute(value) &&
      path.posix.normalize(value) === value &&
      value !== ".." &&
      !value.startsWith("../"))
  );
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (list as readonly string[]).includes(value);
}

function invalidState(message: string): never {
  throw new PluginError("invalid_state", message);
}

export function validateMapping(id: string, candidate: unknown): Mapping {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    invalidState(`Mapping ${id} is invalid.`);
  }
  const m = candidate as Record<string, unknown>;
  if (
    m.schemaVersion !== STATE_SCHEMA_VERSION ||
    m.id !== id ||
    !includes(MODES, m.mode) ||
    !includes(HARNESS_IDS, m.harness) ||
    !nonEmptyString(m.model) ||
    !includes(CREDENTIALS, m.credential) ||
    !nullableString(m.sourcePaneId) ||
    !nullableString(m.remotePaneId) ||
    !nullableString(m.connectionId) ||
    !nullableString(m.boxId) ||
    !BOX_NAME.test(typeof m.boxName === "string" ? m.boxName : "") ||
    !Array.isArray(m.labels) ||
    !m.labels.every((label) => nonEmptyString(label)) ||
    !path.isAbsolute(typeof m.localRoot === "string" ? m.localRoot : "") ||
    !path.isAbsolute(typeof m.localCwd === "string" ? m.localCwd : "") ||
    !safeRelativePath(m.relativeCwd) ||
    !path.posix.isAbsolute(typeof m.remoteRoot === "string" ? m.remoteRoot : "") ||
    !nullableString(m.branch) ||
    !includes(LIFECYCLE_STATES, m.lifecycleState) ||
    typeof m.prepared !== "boolean" ||
    typeof m.everAttached !== "boolean" ||
    !nullableMatch(m.uploadDigest, SHA256) ||
    !nullableMatch(m.lastAppliedExportCommit, GIT_COMMIT) ||
    !validSnapshot(m.lastSnapshot) ||
    !nullableString(m.lastError) ||
    !nonEmptyString(m.createdAt) ||
    !nonEmptyString(m.updatedAt)
  ) {
    invalidState(`Mapping ${id} is invalid.`);
  }
  const relative = path.relative(m.localRoot as string, m.localCwd as string);
  if (relative === ".." || relative.startsWith(`..${path.sep}`)) {
    invalidState(`Mapping ${id} has a local path outside its worktree.`);
  }
  return m as unknown as Mapping;
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const directory = env.HERDR_PLUGIN_STATE_DIR;
  if (!directory) {
    throw new PluginError("missing_plugin_state_dir", "HERDR_PLUGIN_STATE_DIR is not set.");
  }
  return path.resolve(directory);
}

export function emptyState(): PluginState {
  return { schemaVersion: STATE_SCHEMA_VERSION, mappings: {} };
}

export function validateState(candidate: unknown): PluginState {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    invalidState("Plugin state must contain one object.");
  }
  const state = candidate as Record<string, unknown>;
  if (state.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new PluginError(
      "unsupported_state_version",
      `Unsupported state schema: ${String(state.schemaVersion)}.`,
    );
  }
  if (!state.mappings || typeof state.mappings !== "object" || Array.isArray(state.mappings)) {
    invalidState("Plugin mappings are invalid.");
  }
  for (const [id, mapping] of Object.entries(state.mappings as Record<string, unknown>)) {
    validateMapping(id, mapping);
  }
  return state as unknown as PluginState;
}

export interface StateOptions {
  directory?: string;
  file?: string;
  env?: NodeJS.ProcessEnv;
}

export function statePath(directory?: string, env?: NodeJS.ProcessEnv): string {
  return path.join(directory ?? stateDirectory(env), "state.json");
}

export function readState(options: StateOptions = {}): PluginState {
  const file = options.file ?? statePath(options.directory, options.env);
  if (!fs.existsSync(file)) return emptyState();
  try {
    return validateState(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError("invalid_state", `Could not read ${file}: ${(error as Error).message}`);
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleLock(lockPath: string, staleMs: number): boolean {
  let before: fs.Stats;
  let owner: number;
  try {
    before = fs.statSync(lockPath);
    owner = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const ownerIsValid = Number.isSafeInteger(owner) && owner > 0;
  const oldEnough = Date.now() - before.mtimeMs >= staleMs;
  if ((ownerIsValid && processExists(owner)) || (!ownerIsValid && !oldEnough)) return false;
  try {
    const current = fs.statSync(lockPath);
    if (current.dev !== before.dev || current.ino !== before.ino) return false;
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export interface LockOptions {
  attempts?: number;
  interval?: number;
  staleMs?: number;
}

export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<number> {
  const attempts = options.attempts ?? 100;
  const interval = options.interval ?? 20;
  const staleMs = options.staleMs ?? 60_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`, "utf8");
      return handle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeStaleLock(lockPath, staleMs)) continue;
      await delay(interval);
    }
  }
  throw new PluginError("state_lock_timeout", "Timed out while waiting for the plugin state lock.");
}

export type StateChange = (state: PluginState) => PluginState | void | Promise<PluginState | void>;

export async function updateState(
  change: StateChange,
  options: StateOptions & { lock?: LockOptions } = {},
): Promise<PluginState> {
  const directory = options.directory ?? stateDirectory(options.env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = options.file ?? path.join(directory, "state.json");
  const lockPath = `${file}.lock`;
  const lock = await acquireLock(lockPath, options.lock);
  try {
    const current = readState({ file });
    const draft = structuredClone(current);
    const next = (await change(draft)) ?? draft;
    validateState(next);
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporary, file);
    return next;
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function patchMapping(
  mappingId: string,
  patch: Partial<Mapping>,
  options: StateOptions = {},
): Promise<Mapping> {
  let updated: Mapping | undefined;
  await updateState((state) => {
    const mapping = state.mappings[mappingId];
    if (!mapping) {
      throw new PluginError("mapping_not_found", `Mapping ${mappingId} no longer exists.`);
    }
    updated = { ...mapping, ...patch, updatedAt: nowIso() };
    state.mappings[mappingId] = updated;
    return state;
  }, options);
  return updated as Mapping;
}

// Applies the patch only while the guard holds; a vanished mapping or a failed guard is a no-op.
export async function guardedPatch(
  mappingId: string,
  guard: (mapping: Mapping) => boolean,
  patch: Partial<Mapping>,
  options: StateOptions = {},
): Promise<Mapping | null> {
  let updated: Mapping | null = null;
  await updateState((state) => {
    const mapping = state.mappings[mappingId];
    if (!mapping || !guard(mapping)) return state;
    updated = { ...mapping, ...patch, updatedAt: nowIso() };
    state.mappings[mappingId] = updated;
    return state;
  }, options);
  return updated;
}

export function finalizeConnection(
  mappingId: string,
  connectionId: string,
  patch: Partial<Mapping>,
  options: StateOptions = {},
): Promise<Mapping | null> {
  return guardedPatch(
    mappingId,
    (mapping) => mapping.connectionId === connectionId,
    { ...patch, connectionId: null },
    options,
  );
}

export async function removeMapping(mappingId: string, options: StateOptions = {}): Promise<void> {
  await updateState((state) => {
    delete state.mappings[mappingId];
    return state;
  }, options);
}

export function isActive(mapping: Mapping): boolean {
  if (mapping.lifecycleState === "missing" || mapping.lifecycleState === "deleting") return false;
  return true;
}

export function activeMappingsForRoot(state: PluginState, root: string): Mapping[] {
  return Object.values(state.mappings).filter(
    (mapping) => isActive(mapping) && mapping.localRoot === root,
  );
}

// Several matches never resolve silently: the caller is told to pick one.
function unique(mappings: Mapping[], where: string): Mapping | null {
  if (mappings.length <= 1) return mappings[0] ?? null;
  throw new PluginError(
    "ambiguous_mapping",
    `${mappings.length} boxes match ${where}: ${mappings.map((mapping) => mapping.boxName).join(", ")}. Pick one from the dashboard, or set ${MAPPING_ID_ENV}.`,
  );
}

export function mappingForPane(
  state: PluginState,
  paneId: string | undefined | null,
): Mapping | null {
  if (!paneId) return null;
  const mappings = Object.values(state.mappings);
  const remote = mappings.find((mapping) => mapping.remotePaneId === paneId);
  if (remote) return remote;
  return unique(
    mappings.filter((mapping) => mapping.sourcePaneId === paneId),
    `pane ${paneId}`,
  );
}

export function mappingForContext(
  state: PluginState,
  context: PluginContext,
  options: { mappingId?: string; env?: NodeJS.ProcessEnv } = {},
): Mapping | null {
  const env = options.env ?? process.env;
  const explicitId = options.mappingId ?? env[MAPPING_ID_ENV];
  if (explicitId && state.mappings[explicitId]) return state.mappings[explicitId] ?? null;
  const byPane = mappingForPane(state, context.focused_pane_id ?? env.HERDR_PANE_ID);
  if (byPane) return byPane;
  const cwd = context.focused_pane_cwd ?? context.worktree?.checkout_path ?? context.workspace_cwd;
  if (!cwd) return null;
  return unique(
    Object.values(state.mappings).filter(
      (mapping) => mapping.localRoot === cwd || mapping.localCwd === cwd,
    ),
    cwd,
  );
}

export function requireMapping(
  state: PluginState,
  context: PluginContext,
  options: { mappingId?: string; env?: NodeJS.ProcessEnv } = {},
): Mapping {
  const mapping = mappingForContext(state, context, options);
  if (!mapping) {
    throw new PluginError("mapping_not_found", "No Upstash Box mapping matches the focused pane.");
  }
  return mapping;
}

// Fails fast: a second operation on the same mapping is refused rather than queued.
export async function withMappingLock<T>(
  mappingId: string,
  options: StateOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const directory = options.directory ?? stateDirectory(options.env);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, `${mappingId}.op.lock`);
  let lock: number;
  try {
    lock = await acquireLock(lockPath, { attempts: 1, interval: 1, staleMs: 30 * 60_000 });
  } catch (error) {
    if (error instanceof PluginError && error.code === "state_lock_timeout") {
      throw new PluginError(
        "operation_in_progress",
        "Another operation is already running for this box. Wait for it to finish.",
      );
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    fs.closeSync(lock);
    fs.rmSync(lockPath, { force: true });
  }
}
