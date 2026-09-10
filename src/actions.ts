import { loadConfig, overrideHarness, type PluginConfig } from "./config.js";
import {
  AUTOMATION_MODE_ENV,
  DESTRUCTIVE_ACTION_ENV,
  HARNESS_OVERRIDE_ENV,
  MAPPING_ID_ENV,
  OPERATION_ENV,
  SOURCE_CONTEXT_ENV,
  type HarnessId,
} from "./constants.js";
import { assertNativeAutomationMapping } from "./automation.js";
import { parsePluginContext, resolveGitContext, type PluginContext } from "./context.js";
import { getHarness } from "./harness.js";
import { openPluginPane, type OpenPane } from "./herdr.js";
import { emitResult, PluginError, type ActionResult, type Writer } from "./result.js";
import { assertNoActiveMapping } from "./start.js";
import { readState, requireMapping, type Mapping, type StateOptions } from "./state.js";

export interface ActionDeps {
  openPane?: OpenPane;
  config?: PluginConfig;
  state?: StateOptions;
  env?: NodeJS.ProcessEnv;
  write?: Writer;
}

function contextEnvironment(context: PluginContext): Record<string, string> {
  return { [SOURCE_CONTEXT_ENV]: JSON.stringify(context) };
}

function agentEnvironment(mapping: Pick<Mapping, "mode" | "harness">): Record<string, string> {
  return mapping.mode === "tui" ? { HERDR_AGENT: getHarness(mapping.harness).detectionKind } : {};
}

function mappingFromContext(context: PluginContext, deps: ActionDeps): Mapping {
  return requireMapping(readState(deps.state), context, { env: deps.env });
}

function summary(mapping: Mapping): Record<string, unknown> {
  return { mappingId: mapping.id, boxName: mapping.boxName, boxId: mapping.boxId };
}

function openMappedOperation(
  actionId: string,
  context: PluginContext,
  deps: ActionDeps,
): ActionResult {
  const mapping = mappingFromContext(context, deps);
  (deps.openPane ?? openPluginPane)("operation", context, {
    placement: "popup",
    env: { [MAPPING_ID_ENV]: mapping.id, [OPERATION_ENV]: actionId },
  });
  return emitResult(actionId, "opened", { ...summary(mapping), pane: "operation" }, deps.write);
}

function openAutomation(
  actionId: "run-task" | "run-results" | "schedules",
  context: PluginContext,
  deps: ActionDeps,
): ActionResult {
  const mapping = mappingFromContext(context, deps);
  assertNativeAutomationMapping(mapping);
  const pane = actionId === "schedules" ? "schedules" : "agent-runs";
  (deps.openPane ?? openPluginPane)(pane, context, {
    placement: "popup",
    env: {
      [MAPPING_ID_ENV]: mapping.id,
      ...(pane === "agent-runs"
        ? { [AUTOMATION_MODE_ENV]: actionId === "run-task" ? "task" : "results" }
        : {}),
    },
  });
  return emitResult(actionId, "opened", { ...summary(mapping), pane }, deps.write);
}

function openConfirmation(
  actionId: string,
  destructiveAction: string,
  context: PluginContext,
  deps: ActionDeps,
): ActionResult {
  const mapping = mappingFromContext(context, deps);
  (deps.openPane ?? openPluginPane)("confirmation", context, {
    placement: "popup",
    env: { [MAPPING_ID_ENV]: mapping.id, [DESTRUCTIVE_ACTION_ENV]: destructiveAction },
  });
  return emitResult(actionId, "confirmation_opened", summary(mapping), deps.write);
}

// Everything that can fail cheaply fails here, before a pane opens or a box is billed.
export async function startAgent(
  context: PluginContext,
  deps: ActionDeps = {},
  launch: { actionId?: string; harness?: HarnessId } = {},
): Promise<ActionResult> {
  const configured = deps.config ?? loadConfig({ env: deps.env });
  const config = launch.harness ? overrideHarness(configured, launch.harness) : configured;
  const gitContext = resolveGitContext(context, { env: deps.env });
  assertNoActiveMapping(readState(deps.state), gitContext.root, config);
  (deps.openPane ?? openPluginPane)("start", context, {
    placement: "split",
    targetPaneId: context.focused_pane_id,
    env: {
      ...contextEnvironment(context),
      ...agentEnvironment(config),
      ...(launch.harness ? { [HARNESS_OVERRIDE_ENV]: launch.harness } : {}),
    },
  });
  return emitResult(
    launch.actionId ?? "start-agent",
    "opened",
    {
      pane: "start",
      mode: config.mode,
      harness: config.harness,
      model: config.model,
      worktree: gitContext.root,
    },
    deps.write,
  );
}

// One launch on a named harness, for key bindings; config.json is not touched.
function startWith(actionId: string, harness: HarnessId): Action {
  return (context, deps = {}) => startAgent(context, deps, { actionId, harness });
}

export async function setup(context: PluginContext, deps: ActionDeps = {}): Promise<ActionResult> {
  (deps.openPane ?? openPluginPane)("setup", context, { placement: "popup" });
  return emitResult("setup", "opened", { pane: "setup" }, deps.write);
}

export async function reconnect(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  const mapping = mappingFromContext(context, deps);
  if (["deleting", "provisional", "missing"].includes(mapping.lifecycleState)) {
    throw new PluginError(
      "mapping_not_connectable",
      `Mapping ${mapping.id} is ${mapping.lifecycleState}. Delete it and start again.`,
    );
  }
  const pane = mapping.mode === "tui" ? "agent" : "native";
  (deps.openPane ?? openPluginPane)(pane, context, {
    placement: "split",
    targetPaneId: mapping.sourcePaneId ?? context.focused_pane_id,
    env: { [MAPPING_ID_ENV]: mapping.id, ...agentEnvironment(mapping) },
  });
  return emitResult("reconnect", "opened", { ...summary(mapping), pane }, deps.write);
}

export async function dashboard(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  (deps.openPane ?? openPluginPane)("dashboard", context, {
    placement: "zoomed",
    targetPaneId: context.focused_pane_id,
  });
  return emitResult("dashboard", "opened", { pane: "dashboard" }, deps.write);
}

export async function previews(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  const mapping = mappingFromContext(context, deps);
  (deps.openPane ?? openPluginPane)("previews", context, {
    placement: "popup",
    env: { [MAPPING_ID_ENV]: mapping.id },
  });
  return emitResult("previews", "opened", { ...summary(mapping), pane: "previews" }, deps.write);
}

export const stop = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("stop", context, deps));
export const info = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("info", context, deps));
export const applyChanges = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("apply-changes", context, deps));
export const pause = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("pause", context, deps));
export const resume = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("resume", context, deps));
export const snapshot = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openMappedOperation("snapshot", context, deps));
export const requestDelete = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openConfirmation("delete-box", "delete", context, deps));
export const fork = (context: PluginContext, deps: ActionDeps = {}) =>
  Promise.resolve(openConfirmation("fork", "fork", context, deps));
export async function runTask(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  return openAutomation("run-task", context, deps);
}
export async function runResults(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  return openAutomation("run-results", context, deps);
}
export async function schedules(
  context: PluginContext,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  return openAutomation("schedules", context, deps);
}

export type Action = (context: PluginContext, deps?: ActionDeps) => Promise<ActionResult>;

export const ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  setup,
  "start-agent": startAgent,
  "start-claude": startWith("start-claude", "claude-code"),
  "start-codex": startWith("start-codex", "codex"),
  "start-opencode": startWith("start-opencode", "opencode"),
  reconnect,
  stop,
  info,
  "apply-changes": applyChanges,
  pause,
  resume,
  snapshot,
  fork,
  previews,
  dashboard,
  "run-task": runTask,
  "run-results": runResults,
  schedules,
  "delete-box": requestDelete,
});

export async function runAction(
  actionId: string | undefined = process.env.HERDR_PLUGIN_ACTION_ID,
  deps: ActionDeps = {},
): Promise<ActionResult> {
  const action = actionId ? ACTIONS[actionId] : undefined;
  if (!action) {
    throw new PluginError("unknown_action", `Unknown action: ${actionId || "<missing>"}.`);
  }
  return action(parsePluginContext((deps.env ?? process.env).HERDR_PLUGIN_CONTEXT_JSON), deps);
}
