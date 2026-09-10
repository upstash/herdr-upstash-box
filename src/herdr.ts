import { PLUGIN_ID } from "./constants.js";
import type { PluginContext } from "./context.js";
import { runSync, type RunResult } from "./process.js";
import { PluginError } from "./result.js";

export type Placement = "split" | "zoomed" | "popup" | "tab";

export interface PaneOptions {
  placement?: Placement;
  workspaceId?: string;
  targetPaneId?: string | null;
  cwd?: string;
  env?: Record<string, string>;
  focus?: boolean;
  processEnv?: NodeJS.ProcessEnv;
}

export function herdrBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_BIN_PATH || "herdr";
}

export function pluginPaneArgs(
  entrypoint: string,
  context: PluginContext,
  options: PaneOptions = {},
): string[] {
  const args = ["plugin", "pane", "open", "--plugin", PLUGIN_ID, "--entrypoint", entrypoint];
  const placement = options.placement;
  if (placement) args.push("--placement", placement);
  const workspace = options.workspaceId ?? context.workspace_id;
  if (placement === "tab" && workspace) args.push("--workspace", workspace);
  const target = options.targetPaneId ?? context.focused_pane_id;
  if ((placement === "split" || placement === "zoomed") && target) {
    args.push("--target-pane", target);
  }
  if (options.cwd) args.push("--cwd", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new PluginError("invalid_pane_env", `Invalid pane environment key: ${key}.`);
    }
    args.push("--env", `${key}=${value}`);
  }
  args.push(options.focus === false ? "--no-focus" : "--focus");
  return args;
}

export type OpenPane = (
  entrypoint: string,
  context: PluginContext,
  options?: PaneOptions,
) => RunResult;

// Herdr allows one popup at a time, so a lingering one must name itself rather than surface raw JSON.
export const openPluginPane: OpenPane = (entrypoint, context, options = {}) => {
  const result = runSync(
    herdrBinary(options.processEnv),
    pluginPaneArgs(entrypoint, context, options),
    { env: options.processEnv, check: false },
  );
  if (result.status === 0) return result;
  const detail = `${result.stdout}${result.stderr}`.trim();
  if (detail.includes("ui_busy")) {
    throw new PluginError(
      "herdr_popup_open",
      "Another popup is already open. Close it, then run this again.",
    );
  }
  // A remembered pane id outlives the Herdr session it came from; callers can retry elsewhere.
  if (detail.includes("pane_not_found")) {
    throw new PluginError(
      "herdr_pane_not_found",
      `Herdr no longer has pane ${options.targetPaneId ?? context.focused_pane_id ?? "?"}.`,
    );
  }
  throw new PluginError(
    "herdr_pane_failed",
    `Herdr could not open the ${entrypoint} pane: ${detail || `exit ${result.status}`}`.slice(
      0,
      300,
    ),
  );
};

export function closePluginPane(
  paneId: string,
  options: { processEnv?: NodeJS.ProcessEnv; check?: boolean } = {},
): RunResult {
  return runSync(herdrBinary(options.processEnv), ["plugin", "pane", "close", paneId], {
    env: options.processEnv,
    check: options.check,
  });
}

export function renamePane(
  paneId: string,
  title: string,
  options: { processEnv?: NodeJS.ProcessEnv } = {},
): RunResult {
  return runSync(herdrBinary(options.processEnv), ["pane", "rename", paneId, title], {
    env: options.processEnv,
    check: false,
  });
}
