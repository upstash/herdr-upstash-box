import { spawnSync, type StdioOptions } from "node:child_process";
import { PluginError } from "./result.js";

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  check?: boolean;
  stdio?: StdioOptions;
  maxBuffer?: number;
}

export function runSync(command: string, args: string[] = [], options: RunOptions = {}): RunResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new PluginError(
      "command_start_failed",
      `${command} could not start: ${result.error.message}`,
      {
        command,
        args,
      },
    );
  }
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  if (options.check !== false && result.status !== 0) {
    const detail = stderr.trim() || stdout.trim();
    throw new PluginError(
      "command_failed",
      `${command} exited with ${result.status}${detail ? `: ${detail}` : ""}`,
      { command, args, exitCode: result.status },
    );
  }
  return { status: result.status ?? 1, stdout, stderr };
}
