import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { boxApiKey, ensureRunning, openBox, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { BOX_API_KEY_ENV } from "../constants.js";
import { requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, PluginError, type Writer } from "../result.js";
import { ensurePrepared, type PrepareBoxDeps } from "../start.js";
import type { StateOptions } from "../state.js";
import { claimConnection, lifecycleAfterFailure, PREPARE_LABELS } from "./agent.js";

export interface ChildLike {
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv; cwd?: string },
) => ChildLike;

export interface NativePaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  config?: PluginConfig;
  client?: BoxClient;
  ensureRunning?: typeof ensureRunning;
  prepare?: PrepareBoxDeps;
  write?: Writer;
  spawn?: SpawnFn;
  connectionId?: string;
}

// The CLI ships as a dependency so native mode needs nothing on PATH; both overrides still win.
// Its exports map has no "require" condition, so this resolves the ESM entry and walks up to the
// package root rather than requiring "@upstash/box-cli/package.json".
export function bundledBoxCli(
  resolve: (specifier: string) => string = defaultResolve,
): string | null {
  try {
    let directory = path.dirname(fileURLToPath(resolve("@upstash/box-cli")));
    for (let depth = 0; depth < 5; depth += 1) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest)) {
        const bin = (
          JSON.parse(fs.readFileSync(manifest, "utf8")) as { bin?: Record<string, string> }
        ).bin?.box;
        return bin ? path.resolve(directory, bin) : null;
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultResolve(specifier: string): string {
  return import.meta.resolve(specifier);
}

export function boxCli(
  config: Pick<PluginConfig, "boxBin">,
  env: NodeJS.ProcessEnv = process.env,
  resolveBundled: () => string | null = bundledBoxCli,
): string {
  return config.boxBin ?? env.HERDR_BOX_BIN ?? resolveBundled() ?? "box";
}

// The CLI reads a .env from its working directory, which could otherwise point it at a
// different API than the plugin itself is using.
export function childEnvironment(env: NodeJS.ProcessEnv, apiKey: string): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...env, [BOX_API_KEY_ENV]: apiKey };
  if (env.UPSTASH_BOX_BASE_URL) child.UPSTASH_BOX_BASE_URL = env.UPSTASH_BOX_BASE_URL;
  return child;
}

export function nativeArgs(boxId: string): string[] {
  return ["connect", boxId];
}

export async function runNativePane(mappingId: string, deps: NativePaneDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? stdoutWriter;
  const initial = requireMappingById(mappingId, deps.state);
  if (initial.mode !== "native") {
    throw new PluginError("mapping_mode_mismatch", `Mapping ${mappingId} runs in TUI mode.`);
  }
  const config = deps.config ?? loadConfig({ env });
  const apiKey = boxApiKey({ env });
  const connection = await claimConnection(mappingId, {
    env,
    state: deps.state,
    connectionId: deps.connectionId,
  });
  let mapping = connection.mapping;
  let boxId: string;
  try {
    const box = await openBox(mapping, { client: deps.client, apiKey });
    boxId = box.id;
    if (!mapping.boxId) mapping = await connection.keep({ boxId });
    await (deps.ensureRunning ?? ensureRunning)(box, {
      onResume: () => write("Resuming the paused box...\n"),
    });
    mapping = await ensurePrepared(box, mapping, config, {
      ...deps.prepare,
      save: connection.keep,
      onLifecycle: async (state) => {
        const label = PREPARE_LABELS[state];
        if (label) write(`${label}...\n`);
        await deps.prepare?.onLifecycle?.(state);
      },
    });
    mapping = await connection.keep({ lifecycleState: "connected" });
  } catch (error) {
    await connection.release({
      lifecycleState: lifecycleAfterFailure(error),
      remotePaneId: null,
      lastError: errorMessage(error),
    });
    throw error;
  }
  const command = boxCli(config, env);
  let code = 1;
  let failure: unknown;
  try {
    const child = (deps.spawn ?? (spawn as unknown as SpawnFn))(command, nativeArgs(boxId), {
      stdio: "inherit",
      cwd: mapping.localCwd,
      env: childEnvironment(env, apiKey),
    });
    code = await new Promise<number>((resolve, reject) => {
      child.on("error", (error) => {
        reject(
          error.code === "ENOENT"
            ? new PluginError(
                "box_cli_missing",
                `${command} was not found. It ships with this plugin, so reinstall the plugin, or set boxBin in config.json to your own box binary.`,
              )
            : error,
        );
      });
      child.on("exit", (exitCode) => resolve(exitCode ?? 1));
    });
  } catch (error) {
    failure = error;
  } finally {
    await connection.release({
      lifecycleState: failure ? "failed" : "ready",
      remotePaneId: null,
      everAttached: !failure,
      lastError: failure
        ? errorMessage(failure)
        : code === 0
          ? null
          : `${command} connect exited with code ${code}.`,
    });
  }
  if (failure) throw failure;
  return code;
}
