#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { waitForDismiss } from "./pane-runtime.js";
import { runStartPane } from "./panes/start.js";
import { errorMessage } from "./result.js";

try {
  const code = await runStartPane();
  if (code !== 0) {
    process.stdout.write(`\nThe session ended with code ${code}.\n`);
    await waitForDismiss();
  }
  process.exitCode = code;
} catch (error) {
  process.stdout.write(`\nCould not start in ${PLUGIN_NAME}: ${errorMessage(error)}\n`);
  await waitForDismiss();
  process.exitCode = 1;
}
