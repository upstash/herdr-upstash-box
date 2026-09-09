#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runNativePane } from "./panes/native.js";
import { errorMessage } from "./result.js";

try {
  const code = await runNativePane(requireMappingId());
  if (code !== 0) {
    process.stdout.write(`\nThe ${PLUGIN_NAME} REPL ended with code ${code}.\n`);
    await waitForDismiss();
  }
  process.exitCode = code;
} catch (error) {
  process.stdout.write(`\nCould not connect to ${PLUGIN_NAME}: ${errorMessage(error)}\n`);
  await waitForDismiss();
  process.exitCode = 1;
}
