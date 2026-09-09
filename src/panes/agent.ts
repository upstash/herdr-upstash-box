import crypto from "node:crypto";
import type { Box } from "@upstash/box";
import { ensureRunning, openBox, requireProviderApiKey, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import type { LifecycleState } from "../constants.js";
import { requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorCode, errorMessage, PluginError, type Writer } from "../result.js";
import { attach as attachSession, type AttachOptions, type Attached } from "../session.js";
import { ensurePrepared, remoteWorkingDirectory, type PrepareBoxDeps } from "../start.js";
import { finalizeConnection, guardedPatch, type Mapping, type StateOptions } from "../state.js";
import {
  bridgeTerminal,
  terminalSize,
  type SessionBridge,
  type TerminalLike,
} from "../terminal.js";

export interface AgentPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  config?: PluginConfig;
  client?: BoxClient;
  attach?: (box: Box, options: AttachOptions) => Promise<Attached>;
  bridge?: (handle: SessionBridge, terminal?: TerminalLike) => Promise<number>;
  ensureRunning?: typeof ensureRunning;
  prepare?: PrepareBoxDeps;
  write?: Writer;
  onStdout?: (data: Uint8Array) => void;
  size?: { rows: number; cols: number };
  connectionId?: string;
}

export function lifecycleAfterFailure(error: unknown): LifecycleState {
  const code = errorCode(error);
  return code === "box_deleted" || code === "box_unavailable" || code === "box_not_provisioned"
    ? "missing"
    : "failed";
}

export const PREPARE_LABELS: Partial<Record<LifecycleState, string>> = {
  uploading: "Uploading the worktree",
  preparing: "Preparing the workspace",
};

const UNCLAIMABLE = new Set<LifecycleState>(["deleting", "missing", "provisional"]);

export interface Connection {
  mapping: Mapping;
  connectionId: string;
  keep: (patch: Partial<Mapping>) => Promise<Mapping>;
  release: (patch: Partial<Mapping>) => Promise<void>;
}

// Claim the mapping with a fresh token; every later write is a no-op once another actor took over.
export async function claimConnection(
  mappingId: string,
  options: { env?: NodeJS.ProcessEnv; state?: StateOptions; connectionId?: string },
): Promise<Connection> {
  const env = options.env ?? process.env;
  const connectionId = options.connectionId ?? crypto.randomUUID();
  const claimed = await guardedPatch(
    mappingId,
    (mapping) => !UNCLAIMABLE.has(mapping.lifecycleState),
    {
      lifecycleState: "connecting",
      connectionId,
      remotePaneId: env.HERDR_PANE_ID ?? null,
      lastError: null,
    },
    options.state,
  );
  if (!claimed) {
    throw new PluginError(
      "mapping_not_connectable",
      `Mapping ${mappingId} cannot be connected: it is being deleted, missing, or was never provisioned.`,
    );
  }
  const keep = async (patch: Partial<Mapping>): Promise<Mapping> => {
    const updated = await guardedPatch(
      mappingId,
      (mapping) => mapping.connectionId === connectionId,
      patch,
      options.state,
    );
    if (!updated) {
      throw new PluginError(
        "connection_superseded",
        "This connection was stopped, deleted, or replaced by another pane.",
      );
    }
    return updated;
  };
  const release = async (patch: Partial<Mapping>): Promise<void> => {
    await finalizeConnection(mappingId, connectionId, patch, options.state).catch(() => null);
  };
  return { mapping: claimed, connectionId, keep, release };
}

export async function runAgentPane(mappingId: string, deps: AgentPaneDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? stdoutWriter;
  const initial = requireMappingById(mappingId, deps.state);
  if (initial.mode !== "tui") {
    throw new PluginError("mapping_mode_mismatch", `Mapping ${mappingId} runs in native mode.`);
  }
  const config = deps.config ?? loadConfig({ env });
  const key = requireProviderApiKey(
    { providerApiKeyEnv: config.providerApiKeyEnv, mode: "tui", model: initial.model },
    { env },
  );
  const connection = await claimConnection(mappingId, {
    env,
    state: deps.state,
    connectionId: deps.connectionId,
  });
  let mapping = connection.mapping;
  let attached: Attached;
  try {
    const box = await openBox(mapping, { client: deps.client, env });
    if (!mapping.boxId) mapping = await connection.keep({ boxId: box.id });
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
    const size = deps.size ?? terminalSize();
    attached = await (deps.attach ?? attachSession)(box, {
      harnessId: mapping.harness,
      model: mapping.model,
      apiKey: key.value,
      cwd: remoteWorkingDirectory(mapping),
      mappingId,
      resume: mapping.everAttached,
      rows: size.rows,
      cols: size.cols,
      agentArgs: config.agentArgs,
      onStdout:
        deps.onStdout ??
        ((data) => {
          process.stdout.write(data);
        }),
    });
  } catch (error) {
    await connection.release({
      lifecycleState: lifecycleAfterFailure(error),
      remotePaneId: null,
      lastError: errorMessage(error),
    });
    throw error;
  }
  let code = 1;
  let failure: unknown;
  try {
    code = await (deps.bridge ?? bridgeTerminal)(attached.handle);
  } catch (error) {
    failure = error;
  } finally {
    await connection.release({
      lifecycleState: "ready",
      remotePaneId: null,
      everAttached: true,
      lastError: failure
        ? errorMessage(failure)
        : code === 0
          ? null
          : `Agent session exited with code ${code}.`,
    });
  }
  if (failure) throw failure;
  return code;
}
