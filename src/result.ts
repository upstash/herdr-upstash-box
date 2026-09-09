import { PLUGIN_ID } from "./constants.js";

export class PluginError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "PluginError";
    this.code = code;
    this.details = details;
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof PluginError) return error.code;
  if (error && typeof error === "object" && "code" in error && error.code !== undefined) {
    return String(error.code);
  }
  return "unexpected_error";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export interface ActionResult {
  schemaVersion: 1;
  plugin: string;
  action: string;
  status: string;
  at: string;
  [key: string]: unknown;
}

export type Writer = (chunk: string) => void;

const stdout: Writer = (chunk) => {
  process.stdout.write(chunk);
};

export function emitResult(
  action: string,
  status: string,
  data: Record<string, unknown> = {},
  write: Writer = stdout,
): ActionResult {
  const result: ActionResult = {
    schemaVersion: 1,
    plugin: PLUGIN_ID,
    action,
    status,
    at: new Date().toISOString(),
    ...data,
  };
  write(`HERDR_BOX_RESULT ${JSON.stringify(result)}\n`);
  return result;
}

export function emitFailure(action: string, error: unknown, write: Writer = stdout): ActionResult {
  const data: Record<string, unknown> = {
    code: errorCode(error),
    message: errorMessage(error),
  };
  if (error instanceof PluginError && error.details !== undefined) {
    data.details = error.details;
  }
  return emitResult(action, "failed", data, write);
}
