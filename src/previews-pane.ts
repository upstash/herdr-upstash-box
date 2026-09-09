#!/usr/bin/env node
import { PLUGIN_NAME } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runPreviewsPane } from "./panes/previews.js";
import { errorMessage } from "./result.js";

try {
  await runPreviewsPane(requireMappingId());
} catch (error) {
  process.stdout.write(`\nCould not open ${PLUGIN_NAME} previews: ${errorMessage(error)}\n`);
  await waitForDismiss();
  process.exitCode = 1;
}
