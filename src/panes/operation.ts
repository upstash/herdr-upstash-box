import { BoxError, type Snapshot } from "@upstash/box";
import { currentStatus, ensureRunning, isLive, openBox, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { PLUGIN_NAME, type LifecycleState } from "../constants.js";
import { snapshotName, snapshotRecord } from "../fork.js";
import { getHarness } from "../harness.js";
import { closePluginPane } from "../herdr.js";
import { formatBytes } from "../manifest.js";
import { ask, clearScreen, requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { applyPreparedPatch, preparePatch, type PatchDeps, type PatchStatus } from "../patch.js";
import { errorCode, errorMessage, PluginError, type Writer } from "../result.js";
import { agentSessionRunning, stopAgent } from "../session.js";
import { remoteWorkingDirectory } from "../start.js";
import {
  guardedPatch,
  patchMapping,
  withMappingLock,
  type Mapping,
  type StateOptions,
} from "../state.js";

export interface OperationPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  config?: PluginConfig;
  client?: BoxClient;
  write?: Writer;
  closePane?: (paneId: string) => unknown;
  confirm?: (question: string) => Promise<string>;
  patch?: PatchDeps;
  ensureRunning?: typeof ensureRunning;
}

function header(title: string, mapping: Mapping, write: Writer): void {
  clearScreen(write);
  write(`${title}\n\nBox: ${mapping.boxName}${mapping.boxId ? ` (${mapping.boxId})` : ""}\n\n`);
}

function isGone(error: unknown): boolean {
  if (error instanceof BoxError) return error.statusCode === 404;
  const code = errorCode(error);
  return code === "box_not_provisioned" || code === "box_deleted";
}

function notDeleting(mappingId: string, deps: OperationPaneDeps): Mapping {
  const mapping = requireMappingById(mappingId, deps.state);
  if (mapping.lifecycleState === "deleting") {
    throw new PluginError("mapping_deleting", "This box is being deleted.");
  }
  return mapping;
}

// Records the outcome unless deletion started meanwhile, and closes the agent pane.
async function settle(
  mapping: Mapping,
  lifecycleState: LifecycleState,
  deps: OperationPaneDeps,
): Promise<void> {
  const recorded = await guardedPatch(
    mapping.id,
    (current) => current.lifecycleState !== "deleting",
    { lifecycleState, remotePaneId: null, connectionId: null },
    deps.state,
  );
  if (!recorded) throw new PluginError("mapping_deleting", "This box is being deleted.");
  if (mapping.remotePaneId) {
    (deps.closePane ?? ((paneId) => closePluginPane(paneId, { check: false })))(
      mapping.remotePaneId,
    );
  }
}

export async function showInfo(mappingId: string, deps: OperationPaneDeps = {}): Promise<string[]> {
  const write = deps.write ?? stdoutWriter;
  const mapping = requireMappingById(mappingId, deps.state);
  header(`${PLUGIN_NAME} info`, mapping, write);
  let status = "unknown";
  let agentSession: string | null = null;
  try {
    const box = await openBox(mapping, { client: deps.client, env: deps.env });
    status = await currentStatus(box);
    if (mapping.mode === "tui") {
      agentSession = isLive(status)
        ? (await agentSessionRunning(box, mappingId))
          ? "running"
          : "not running"
        : `unknown while the box is ${status}`;
    }
  } catch (error) {
    status = isGone(error) ? "deleted" : `unavailable (${errorMessage(error)})`;
  }
  const lines = [
    `Mode: ${mapping.mode}`,
    `Agent: ${getHarness(mapping.harness).title}`,
    `Model: ${mapping.model}`,
    `Box status: ${status}`,
    `Lifecycle: ${mapping.lifecycleState}${mapping.prepared ? "" : " (not prepared)"}`,
    ...(agentSession ? [`Agent session: ${agentSession}`] : []),
    `Local worktree: ${mapping.localRoot}${mapping.branch ? ` (${mapping.branch})` : ""}`,
    `Local cwd: ${mapping.localCwd}`,
    `Remote cwd: ${remoteWorkingDirectory(mapping)}`,
    `Upload digest: ${mapping.uploadDigest ? mapping.uploadDigest.slice(0, 12) : "none"}`,
    `Last applied export: ${mapping.lastAppliedExportCommit ? mapping.lastAppliedExportCommit.slice(0, 12) : "none"}`,
    `Last snapshot: ${mapping.lastSnapshot ? `${mapping.lastSnapshot.name} (${mapping.lastSnapshot.id})` : "none"}`,
    `Labels: ${mapping.labels.join(", ")}`,
    `Source pane: ${mapping.sourcePaneId ?? "none"}`,
    `Agent pane: ${mapping.remotePaneId ?? "none"}`,
    `Created: ${mapping.createdAt}`,
    ...(mapping.lastError ? [`Last error: ${mapping.lastError}`] : []),
  ];
  write(`${lines.join("\n")}\n`);
  return lines;
}

export type StopOutcome = "stopped" | "not_running" | "missing";

export async function stopMapping(
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<StopOutcome> {
  return withMappingLock(mappingId, deps.state ?? {}, () => stopLocked(mappingId, deps));
}

async function stopLocked(mappingId: string, deps: OperationPaneDeps): Promise<StopOutcome> {
  const write = deps.write ?? stdoutWriter;
  const mapping = notDeleting(mappingId, deps);
  header(`Stop ${PLUGIN_NAME} agent`, mapping, write);
  write("Stopping the agent session...\n");
  let outcome: StopOutcome = "not_running";
  try {
    const box = await openBox(mapping, { client: deps.client, env: deps.env });
    const status = await currentStatus(box);
    if (status === "deleted") outcome = "missing";
    else if (mapping.mode === "tui" && isLive(status)) outcome = await stopAgent(box, mappingId);
  } catch (error) {
    if (!isGone(error)) throw error;
    outcome = "missing";
  }
  await settle(mapping, outcome === "missing" ? "missing" : "stopped", deps);
  write(
    `\n${
      outcome === "missing"
        ? "The box no longer exists. The mapping is marked missing."
        : "Agent stopped. The box and its files are preserved."
    }\n`,
  );
  return outcome;
}

export type PauseOutcome = "paused" | "already_paused" | "missing";

// tmux does not survive a pause, so the agent session is ended first and reconnect resumes from disk.
export async function pauseMapping(
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<PauseOutcome> {
  return withMappingLock(mappingId, deps.state ?? {}, () => pauseLocked(mappingId, deps));
}

async function pauseLocked(mappingId: string, deps: OperationPaneDeps): Promise<PauseOutcome> {
  const write = deps.write ?? stdoutWriter;
  const mapping = notDeleting(mappingId, deps);
  header(`Pause ${PLUGIN_NAME}`, mapping, write);
  let outcome: PauseOutcome = "paused";
  let activeSchedules = 0;
  try {
    const box = await openBox(mapping, { client: deps.client, env: deps.env });
    activeSchedules = (await box.schedule.list().catch(() => [])).filter(
      (schedule) => schedule.status === "active",
    ).length;
    const status = await currentStatus(box);
    if (status === "deleted") outcome = "missing";
    else if (status === "paused") outcome = "already_paused";
    else {
      if (mapping.mode === "tui" && isLive(status)) {
        write("Stopping the agent session...\n");
        await stopAgent(box, mappingId);
      }
      write("Pausing the box...\n");
      await box.pause();
    }
  } catch (error) {
    if (!isGone(error)) throw error;
    outcome = "missing";
  }
  await settle(mapping, outcome === "missing" ? "missing" : "paused", deps);
  write(
    `\n${
      outcome === "missing"
        ? "The box no longer exists. The mapping is marked missing."
        : outcome === "already_paused"
          ? "The box was already paused."
          : activeSchedules > 0
            ? `Box paused for now. ${activeSchedules} active ${activeSchedules === 1 ? "schedule can" : "schedules can"} wake it at the next cron and incur compute and model costs.`
            : "Box paused. Files are kept and compute has stopped. Reconnect or resume to bring it back."
    }\n`,
  );
  return outcome;
}

export type ResumeOutcome = "resumed" | "already_running" | "missing";

export async function resumeMapping(
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<ResumeOutcome> {
  return withMappingLock(mappingId, deps.state ?? {}, () => resumeLocked(mappingId, deps));
}

// A box that is already running keeps whatever connection it has; only a real resume settles state.
async function resumeLocked(mappingId: string, deps: OperationPaneDeps): Promise<ResumeOutcome> {
  const write = deps.write ?? stdoutWriter;
  const mapping = notDeleting(mappingId, deps);
  header(`Resume ${PLUGIN_NAME}`, mapping, write);
  let outcome: ResumeOutcome = "already_running";
  try {
    const box = await openBox(mapping, { client: deps.client, env: deps.env });
    const result = await (deps.ensureRunning ?? ensureRunning)(box, {
      onResume: () => write("Resuming the paused box...\n"),
    });
    outcome = result.resumed ? "resumed" : "already_running";
  } catch (error) {
    if (!isGone(error)) throw error;
    outcome = "missing";
  }
  if (outcome !== "already_running") {
    await settle(mapping, outcome === "missing" ? "missing" : "ready", deps);
  }
  write(
    `\n${
      outcome === "missing"
        ? "The box no longer exists. The mapping is marked missing."
        : outcome === "resumed"
          ? "Box resumed. Reconnect to open the agent again."
          : "The box is already running."
    }\n`,
  );
  return outcome;
}

export async function snapshotMapping(
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<Snapshot> {
  return withMappingLock(mappingId, deps.state ?? {}, () => snapshotLocked(mappingId, deps));
}

async function snapshotLocked(mappingId: string, deps: OperationPaneDeps): Promise<Snapshot> {
  const write = deps.write ?? stdoutWriter;
  const mapping = notDeleting(mappingId, deps);
  header(`Snapshot ${PLUGIN_NAME}`, mapping, write);
  const box = await openBox(mapping, { client: deps.client, env: deps.env });
  await (deps.ensureRunning ?? ensureRunning)(box, {
    onResume: () => write("Resuming the paused box...\n"),
  });
  const name = snapshotName(mapping);
  write(`Creating snapshot ${name}...\n`);
  const snapshot = await box.snapshot({ name });
  await patchMapping(mappingId, { lastSnapshot: snapshotRecord(snapshot) }, deps.state);
  write(
    `\nSnapshot ${snapshot.name} is ready (${snapshot.id}, ${formatBytes(snapshot.size_bytes)}).\nFork the box any time to start a second box from its current state.\n`,
  );
  return snapshot;
}

// One Apply per mapping at a time, so two panes cannot pair one patch with another's commit marker.
export async function applyChanges(
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<PatchStatus | "canceled"> {
  return withMappingLock(mappingId, deps.state ?? {}, async () => {
    const write = deps.write ?? stdoutWriter;
    const mapping = requireMappingById(mappingId, deps.state);
    header(`Apply ${PLUGIN_NAME} changes locally`, mapping, write);
    if (!mapping.prepared || !mapping.lastAppliedExportCommit) {
      throw new PluginError(
        "mapping_not_prepared",
        "The box has no upload baseline yet. Reconnect first so preparation can finish.",
      );
    }
    const config = deps.config ?? loadConfig({ env: deps.env });
    const box = await openBox(mapping, { client: deps.client, env: deps.env });
    await (deps.ensureRunning ?? ensureRunning)(box, {
      onResume: () => write("Resuming the paused box...\n"),
    });
    write("Exporting and checking the Git patch from the box...\n\n");
    const prepared = await preparePatch(box, mapping, {
      config,
      maxPatchBytes: config.maxPatchBytes,
      ...deps.patch,
    });
    try {
      write(`${prepared.summary}\n`);
      if (prepared.status === "ready") {
        write(`\nPatch size: ${prepared.bytes} bytes\n`);
        const answer = await (deps.confirm ?? ask)(
          "Apply these changes to the local worktree? [y/N] ",
        );
        if (!["y", "yes"].includes((answer ?? "").trim().toLowerCase())) {
          write("\nCanceled. The local worktree was not changed.\n");
          return "canceled";
        }
      }
      const result = applyPreparedPatch(prepared, mapping, deps.patch);
      await patchMapping(mappingId, { lastAppliedExportCommit: result.nextCommit }, deps.state);
      write(
        `\n${
          result.status === "applied"
            ? "Changes applied to the local worktree."
            : result.status === "no_change"
              ? "Nothing to apply."
              : "Already present locally. Marker advanced."
        }\n`,
      );
      return result.status;
    } finally {
      prepared.cleanup();
    }
  });
}

export async function runOperationPane(
  operation: string | undefined,
  mappingId: string,
  deps: OperationPaneDeps = {},
): Promise<void> {
  switch (operation) {
    case "info":
      await showInfo(mappingId, deps);
      return;
    case "stop":
      await stopMapping(mappingId, deps);
      return;
    case "pause":
      await pauseMapping(mappingId, deps);
      return;
    case "resume":
      await resumeMapping(mappingId, deps);
      return;
    case "snapshot":
      await snapshotMapping(mappingId, deps);
      return;
    case "apply-changes":
      await applyChanges(mappingId, deps);
      return;
    default:
      throw new PluginError(
        "unknown_operation",
        `Unsupported operation: ${operation ?? "<missing>"}.`,
      );
  }
}
