#!/usr/bin/env node
import { OPERATION_ENV } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runOperationPane } from "./panes/operation.js";
import { errorMessage } from "./result.js";

try {
  await runOperationPane(process.env[OPERATION_ENV], requireMappingId());
} catch (error) {
  process.stdout.write(`\n${errorMessage(error)}\n`);
  process.exitCode = 1;
}
await waitForDismiss();
