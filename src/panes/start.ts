import { loadConfig, overrideHarness } from "../config.js";
import {
  HARNESS_OVERRIDE_ENV,
  PLUGIN_NAME,
  type HarnessId,
  type LifecycleState,
} from "../constants.js";
import { renamePane } from "../herdr.js";
import { formatBytes } from "../manifest.js";
import { clearScreen, sourceContext, stdoutWriter } from "../pane-runtime.js";
import { describeStart, prepareStart, provisionStart } from "../start.js";
import { runAgentPane, type AgentPaneDeps } from "./agent.js";

export interface StartPaneDeps extends AgentPaneDeps {
  rename?: (paneId: string, title: string) => unknown;
}

export const PANE_TITLE = `${PLUGIN_NAME} agent`;

export async function runStartPane(deps: StartPaneDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? stdoutWriter;
  const context = sourceContext(env);
  const configured = deps.config ?? loadConfig({ env });
  const override = env[HARNESS_OVERRIDE_ENV];
  const config = override ? overrideHarness(configured, override as HarnessId) : configured;
  const prepared = prepareStart(context, { config, env });
  clearScreen(write);
  write(`Start in ${PLUGIN_NAME}\n\n${describeStart(prepared)}\n\nCreating the box...\n`);
  const { manifest } = prepared;
  const labels: Partial<Record<LifecycleState, string>> = {
    creating: "Box created",
    uploading: `Uploading ${manifest.files.length} files (${formatBytes(manifest.totalBytes)})`,
    preparing: "Preparing the workspace: Git baseline and tmux",
  };
  const { mapping } = await provisionStart(prepared, {
    client: deps.client,
    state: deps.state,
    keys: { env },
    ...deps.prepare,
    onLifecycle: async (state) => {
      const label = labels[state];
      if (label) write(`  ${label}...\n`);
      await deps.prepare?.onLifecycle?.(state);
    },
  });
  write(`\nReady: ${mapping.boxName} (${mapping.boxId ?? "no id"})\n`);
  if (env.HERDR_PANE_ID) (deps.rename ?? renamePane)(env.HERDR_PANE_ID, PANE_TITLE);
  write(`Connecting ${prepared.harness.title}...\n`);
  return runAgentPane(mapping.id, { ...deps, config, env });
}
