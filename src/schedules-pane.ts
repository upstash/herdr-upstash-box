#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runSchedulesPane } from "./panes/schedules.js";
import { errorMessage } from "./result.js";

try {
  await runSchedulesPane(requireMappingId());
} catch (error) {
  process.stdout.write(`\nCould not open ${PLUGIN_NAME} schedules: ${errorMessage(error)}\n`);
  await waitForDismiss();
  process.exitCode = 1;
}
