#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { waitForDismiss } from "./pane-runtime.js";
import { runSetupPane } from "./panes/setup.js";
import { errorMessage } from "./result.js";

try {
  const outcome = await runSetupPane();
  if (outcome === "aborted") process.exitCode = 1;
} catch (error) {
  process.stdout.write(`\nCould not set up ${PLUGIN_NAME}: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}
await waitForDismiss();
