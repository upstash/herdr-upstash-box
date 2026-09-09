#!/usr/bin/env node
import { AUTOMATION_MODE_ENV, PLUGIN_NAME } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runAgentRunsPane } from "./panes/agent-runs.js";
import { errorMessage } from "./result.js";

try {
  await runAgentRunsPane(process.env[AUTOMATION_MODE_ENV] ?? "", requireMappingId());
} catch (error) {
  process.stdout.write(`\n${PLUGIN_NAME} agent run failed: ${errorMessage(error)}\n`);
  await waitForDismiss();
  process.exitCode = 1;
}
