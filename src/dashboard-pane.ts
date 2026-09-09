#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { waitForDismiss } from "./pane-runtime.js";
import { runDashboardPane } from "./panes/dashboard.js";
import { errorMessage } from "./result.js";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(`The ${PLUGIN_NAME} dashboard needs an interactive terminal.\n`);
  process.exitCode = 1;
} else {
  try {
    await runDashboardPane();
  } catch (error) {
    process.stdout.write(`\nThe ${PLUGIN_NAME} dashboard failed: ${errorMessage(error)}\n`);
    await waitForDismiss();
    process.exitCode = 1;
  }
}
