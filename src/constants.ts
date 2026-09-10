export const PLUGIN_ID = "upstash.box";
export const PLUGIN_NAME = "Upstash Box";
export const STATE_SCHEMA_VERSION = 1;
export const DEFAULT_REMOTE_ROOT = "/workspace/home/worktree";
export const UPLOAD_DIR = "/tmp/herdr-box";
export const BOX_LABEL = "herdr";
export const MAX_BOX_NAME_LENGTH = 60;

export const MAPPING_ID_ENV = "HERDR_BOX_MAPPING_ID";
export const SOURCE_CONTEXT_ENV = "HERDR_BOX_SOURCE_CONTEXT_JSON";
export const OPERATION_ENV = "HERDR_BOX_OPERATION";
export const DESTRUCTIVE_ACTION_ENV = "HERDR_BOX_DESTRUCTIVE_ACTION";
export const BOX_API_KEY_ENV = "UPSTASH_BOX_API_KEY";
export const ORPHAN_BOX_ID_ENV = "HERDR_BOX_ORPHAN_BOX_ID";
export const AUTOMATION_MODE_ENV = "HERDR_BOX_AUTOMATION_MODE";
export const HARNESS_OVERRIDE_ENV = "HERDR_BOX_HARNESS";
export const AUTOMATION_SCHEMA_VERSION = 1;

export const LIFECYCLE_STATES = [
  "provisional",
  "creating",
  "uploading",
  "preparing",
  "ready",
  "connecting",
  "connected",
  "stopped",
  "paused",
  "missing",
  "deleting",
  "failed",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const MODES = ["tui", "native"] as const;
export type Mode = (typeof MODES)[number];

export const NATIVE_KEYS = ["managed", "local"] as const;
export type NativeKey = (typeof NATIVE_KEYS)[number];

export const HARNESS_IDS = ["claude-code", "codex", "opencode"] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const PREVIEW_AUTH = ["basic", "none"] as const;
export type PreviewAuth = (typeof PREVIEW_AUTH)[number];

export const CREDENTIALS = ["session", "managed", "local"] as const;
export type Credential = (typeof CREDENTIALS)[number];
