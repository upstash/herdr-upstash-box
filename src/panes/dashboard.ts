import type { BoxData } from "@upstash/box";
import { boxApiKey, sdkClient, type BoxClient } from "../box.js";
import {
  BOX_LABEL,
  DESTRUCTIVE_ACTION_ENV,
  MAPPING_ID_ENV,
  OPERATION_ENV,
  ORPHAN_BOX_ID_ENV,
} from "../constants.js";
import { parsePluginContext, type PluginContext } from "../context.js";
import {
  buildRows,
  KEY_ACTIONS,
  renderDashboard,
  splitKeys,
  type DashboardAction,
  type DashboardRow,
} from "../dashboard-model.js";
import { getHarness } from "../harness.js";
import { openPluginPane, type OpenPane } from "../herdr.js";
import { errorMessage, type Writer } from "../result.js";
import { readState, type StateOptions } from "../state.js";

export interface DashboardDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  client?: BoxClient;
  apiKey?: string;
  context?: PluginContext;
  openPane?: OpenPane;
  write?: Writer;
  keys?: AsyncIterable<string>;
  listBoxes?: () => Promise<BoxData[]>;
  refreshMs?: number;
  width?: number;
  now?: () => number;
}

const OPERATIONS = new Set<DashboardAction>([
  "apply-changes",
  "info",
  "stop",
  "pause",
  "resume",
  "snapshot",
]);

// Selection follows a row id, so a refresh that reorders or removes rows cannot redirect a key.
export async function runDashboardPane(deps: DashboardDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const write =
    deps.write ??
    ((chunk: string) => {
      process.stdout.write(chunk);
    });
  const context = deps.context ?? parsePluginContext(env.HERDR_PLUGIN_CONTEXT_JSON);
  const open = deps.openPane ?? openPluginPane;
  const width = deps.width ?? process.stdout.columns ?? 120;
  const now = deps.now ?? Date.now;
  const listBoxes =
    deps.listBoxes ??
    (async () => (deps.client ?? sdkClient).list(deps.apiKey ?? boxApiKey({ env }), BOX_LABEL));
  let listing: BoxData[] | null = null;
  let syncing = false;
  let message = "Loading boxes...";
  let selectedId: string | null = null;
  let running = true;

  const rows = (): DashboardRow[] => buildRows(readState(deps.state), listing);
  const selectedIndex = (current: DashboardRow[]): number => {
    const index = current.findIndex((row) => row.id === selectedId);
    return index < 0 ? 0 : index;
  };
  const render = (): void => {
    const current = rows();
    const index = selectedIndex(current);
    selectedId = current[index]?.id ?? null;
    write(
      `\u001b[2J\u001b[H${renderDashboard(current, index, {
        width,
        syncing,
        message,
        now: now(),
      })}`,
    );
  };
  const refresh = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    render();
    try {
      listing = await listBoxes();
      if (message === "Loading boxes..." || message.startsWith("Refresh")) message = "Ready.";
    } catch (error) {
      message = `Refresh failed: ${errorMessage(error)}`;
    } finally {
      syncing = false;
      if (running) render();
    }
  };

  const act = (action: DashboardAction, row: DashboardRow): void => {
    if (row.kind === "orphan") {
      if (action === "delete") {
        open("confirmation", context, {
          placement: "popup",
          env: { [ORPHAN_BOX_ID_ENV]: row.boxId, [DESTRUCTIVE_ACTION_ENV]: "delete-orphan" },
        });
        message = `Delete ${row.name} in the popup.`;
      } else {
        message = "Orphan boxes can only be deleted from here.";
      }
      return;
    }
    const { mapping } = row;
    if (action === "reconnect") {
      if (["deleting", "missing", "provisional"].includes(mapping.lifecycleState)) {
        message = `${mapping.boxName} is ${mapping.lifecycleState}; nothing to reconnect to.`;
        return;
      }
      open("agent", context, {
        placement: "tab",
        workspaceId: context.workspace_id,
        env: {
          [MAPPING_ID_ENV]: mapping.id,
          HERDR_AGENT: getHarness(mapping.harness).detectionKind,
        },
      });
      message = `Opened ${mapping.boxName} in a new tab.`;
      return;
    }
    if (OPERATIONS.has(action)) {
      open("operation", context, {
        placement: "popup",
        env: { [MAPPING_ID_ENV]: mapping.id, [OPERATION_ENV]: action },
      });
      message = `${action} for ${mapping.boxName} opened in a popup.`;
      return;
    }
    if (action === "previews") {
      open("previews", context, { placement: "popup", env: { [MAPPING_ID_ENV]: mapping.id } });
      message = `Previews for ${mapping.boxName} opened in a popup.`;
      return;
    }
    if (action === "delete" || action === "fork") {
      open("confirmation", context, {
        placement: "popup",
        env: { [MAPPING_ID_ENV]: mapping.id, [DESTRUCTIVE_ACTION_ENV]: action },
      });
      message = `${action === "fork" ? "Fork" : "Delete"} ${mapping.boxName} in the popup.`;
    }
  };

  const handle = (action: DashboardAction): void => {
    if (action === "refresh") {
      message = "Refreshing...";
      void refresh();
      return;
    }
    const current = rows();
    if (current.length === 0) {
      message = "Nothing selected.";
      return;
    }
    const index = selectedIndex(current);
    if (action === "up" || action === "down") {
      const step = action === "up" ? -1 : 1;
      selectedId = current[(index + step + current.length) % current.length]?.id ?? null;
      return;
    }
    const row = current.find((candidate) => candidate.id === selectedId);
    if (!row) {
      message = "That box left the list before the key landed. Nothing was done.";
      return;
    }
    act(action, row);
  };

  render();
  void refresh();
  const timer =
    deps.refreshMs === 0 ? null : setInterval(() => void refresh(), deps.refreshMs ?? 3000);
  let pending = "";
  try {
    for await (const chunk of deps.keys ?? terminalKeys()) {
      const parsed = splitKeys(chunk, pending);
      pending = parsed.pending;
      for (const key of parsed.keys) {
        const action = KEY_ACTIONS[key];
        if (!action) continue;
        if (action === "quit") {
          running = false;
          break;
        }
        handle(action);
        render();
      }
      if (!running) break;
    }
  } finally {
    running = false;
    if (timer) clearInterval(timer);
  }
}

// Raw-mode key stream from the real terminal; the alternate screen is restored on exit.
export async function* terminalKeys(): AsyncIterable<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  process.stdout.write("\u001b[?1049h\u001b[?25l");
  try {
    for await (const chunk of stdin) yield String(chunk);
  } finally {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write("\u001b[?25h\u001b[?1049l");
  }
}
