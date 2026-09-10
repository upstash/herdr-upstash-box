import { BoxError } from "@upstash/box";
import {
  boxApiKey,
  deleteBoxForMapping,
  ensureRunning,
  openBox,
  sdkClient,
  type BoxClient,
} from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { BOX_LABEL, PLUGIN_NAME } from "../constants.js";
import { claimedBy, isPluginBox } from "../dashboard-model.js";
import { forkMapping } from "../fork.js";
import { getHarness } from "../harness.js";
import { closePluginPane } from "../herdr.js";
import { askWithTimeout, clearScreen, requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, PluginError, type Writer } from "../result.js";
import {
  patchMapping,
  readState,
  removeMapping,
  withMappingLock,
  type Mapping,
  type StateOptions,
} from "../state.js";

export const CONFIRMATION_TIMEOUT_MS = 60_000;

export const CONFIRMATION_WORDS = Object.freeze({
  delete: "DELETE",
  "delete-orphan": "DELETE",
  fork: "FORK",
});

export type DestructiveAction = keyof typeof CONFIRMATION_WORDS;

export interface ConfirmationPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  config?: PluginConfig;
  client?: BoxClient;
  write?: Writer;
  confirm?: (word: string) => Promise<string | null>;
  closePane?: (paneId: string) => unknown;
  ensureRunning?: typeof ensureRunning;
}

async function confirmed(word: string, deps: ConfirmationPaneDeps): Promise<boolean> {
  const answer = await (deps.confirm
    ? deps.confirm(word)
    : askWithTimeout(`Type ${word} within 60 seconds to continue: `, CONFIRMATION_TIMEOUT_MS));
  return answer?.trim() === word;
}

function closeRemotePane(mapping: Mapping, deps: ConfirmationPaneDeps): void {
  if (!mapping.remotePaneId) return;
  (deps.closePane ?? ((paneId) => closePluginPane(paneId, { check: false })))(mapping.remotePaneId);
}

async function deleteMapping(mappingId: string, deps: ConfirmationPaneDeps): Promise<boolean> {
  const write = deps.write ?? stdoutWriter;
  const mapping = requireMappingById(mappingId, deps.state);
  clearScreen(write);
  write(
    [
      `Permanently delete ${PLUGIN_NAME} box`,
      "",
      `Box: ${mapping.boxName}`,
      `Box id: ${mapping.boxId ?? "not provisioned"}`,
      `Agent: ${getHarness(mapping.harness).title}`,
      `Local worktree: ${mapping.localRoot}`,
      "",
      "This permanently deletes the box, its files, and the local mapping.",
      "",
    ].join("\n"),
  );
  if (!(await confirmed(CONFIRMATION_WORDS.delete, deps))) {
    write("\nCanceled. Nothing was deleted.\n");
    return false;
  }
  return withMappingLock(mappingId, deps.state ?? {}, async () => {
    const current = requireMappingById(mappingId, deps.state);
    // Entering deletion also drops the connection token, so an attached pane cannot write afterwards.
    await patchMapping(
      mappingId,
      { lifecycleState: "deleting", connectionId: null, remotePaneId: null },
      deps.state,
    );
    await deleteBoxForMapping(current, { client: deps.client, env: deps.env });
    await removeMapping(mappingId, deps.state);
    closeRemotePane(current, deps);
    write(`\nDeleted ${current.boxName}.\n`);
    return true;
  });
}

// Ownership is re-checked against fresh state and the box's live labels right before deletion.
async function deleteOrphan(boxId: string, deps: ConfirmationPaneDeps): Promise<boolean> {
  const write = deps.write ?? stdoutWriter;
  const client = deps.client ?? sdkClient;
  const apiKey = boxApiKey({ env: deps.env });
  clearScreen(write);
  write(
    [
      `Permanently delete an unmapped ${PLUGIN_NAME} box`,
      "",
      `Box id: ${boxId}`,
      "",
      "This box carries the plugin labels but no mapping knows it. Deleting removes it and its files.",
      "",
    ].join("\n"),
  );
  if (!(await confirmed(CONFIRMATION_WORDS["delete-orphan"], deps))) {
    write("\nCanceled. Nothing was deleted.\n");
    return false;
  }
  const entry = (await client.list(apiKey, BOX_LABEL)).find((box) => box.id === boxId);
  if (!entry || entry.status === "deleted") {
    write(`\n${boxId} was already gone.\n`);
    return true;
  }
  if (!isPluginBox(entry)) {
    throw new PluginError(
      "orphan_not_ours",
      `${boxId} does not carry this plugin's labels; it may belong to another tool. Not deleted.`,
    );
  }
  const owner = claimedBy(readState(deps.state), entry);
  if (owner) {
    throw new PluginError(
      "orphan_claimed",
      `${boxId} belongs to mapping ${owner.boxName}; reconnect to it or delete that mapping instead.`,
    );
  }
  try {
    const box = await client.get(boxId, apiKey);
    await box.delete();
    write(`\nDeleted ${boxId}.\n`);
  } catch (error) {
    if (!(error instanceof BoxError && error.statusCode === 404)) throw error;
    write(`\n${boxId} was already gone.\n`);
  }
  return true;
}

// Fork snapshots the running box and starts a second one from it, beside the original.
async function fork(mappingId: string, deps: ConfirmationPaneDeps): Promise<boolean> {
  const write = deps.write ?? stdoutWriter;
  const mapping = requireMappingById(mappingId, deps.state);
  if (
    !mapping.prepared ||
    ["deleting", "missing", "provisional"].includes(mapping.lifecycleState)
  ) {
    throw new PluginError(
      "mapping_not_forkable",
      `${mapping.boxName} is ${mapping.lifecycleState}${mapping.prepared ? "" : " and not prepared"}; nothing to fork yet.`,
    );
  }
  clearScreen(write);
  write(
    [
      `Fork ${PLUGIN_NAME} box`,
      "",
      `Box: ${mapping.boxName}${mapping.boxId ? ` (${mapping.boxId})` : ""}`,
      `Agent: ${getHarness(mapping.harness).title}`,
      `Local worktree: ${mapping.localRoot}`,
      "",
      "This snapshots the box now and starts a second box from that snapshot for the same worktree.",
      "The new box gets its own mapping and its own bill. The original keeps running.",
      "Afterwards, pick boxes from the dashboard: actions from this pane would be ambiguous.",
      "",
    ].join("\n"),
  );
  if (!(await confirmed(CONFIRMATION_WORDS.fork, deps))) {
    write("\nCanceled. Nothing was created.\n");
    return false;
  }
  return withMappingLock(mappingId, deps.state ?? {}, async () => {
    const current = requireMappingById(mappingId, deps.state);
    const config = deps.config ?? loadConfig({ env: deps.env });
    const box = await openBox(current, { client: deps.client, env: deps.env });
    await (deps.ensureRunning ?? ensureRunning)(box, {
      onResume: () => write("Resuming the paused box...\n"),
    });
    const labels = {
      snapshot: "Creating the snapshot",
      create: "Starting the new box from it",
      record: "Recording the mapping",
    };
    const result = await forkMapping(current, box, {
      config,
      client: deps.client,
      keys: { env: deps.env },
      state: deps.state,
      onProgress: (step) => write(`  ${labels[step]}...\n`),
    });
    write(
      `\nForked: ${result.mapping.boxName} (${result.mapping.boxId}) from snapshot ${result.snapshot.name}.\nReconnect to it from the dashboard. The original box is untouched.\n`,
    );
    return true;
  });
}

export async function runConfirmationPane(
  action: string | undefined,
  subjectId: string,
  deps: ConfirmationPaneDeps = {},
): Promise<boolean> {
  switch (action) {
    case "delete":
      return deleteMapping(subjectId, deps);
    case "delete-orphan":
      return deleteOrphan(subjectId, deps);
    case "fork":
      return fork(subjectId, deps);
    default:
      throw new PluginError(
        "unknown_destructive_action",
        `Unsupported destructive action: ${action ?? "<missing>"}.`,
      );
  }
}
