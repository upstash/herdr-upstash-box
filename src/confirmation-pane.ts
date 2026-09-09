#!/usr/bin/env node
import { DESTRUCTIVE_ACTION_ENV, ORPHAN_BOX_ID_ENV } from "./constants.js";
import { requireMappingId, waitForDismiss } from "./pane-runtime.js";
import { runConfirmationPane } from "./panes/confirmation.js";
import { errorMessage, PluginError } from "./result.js";

try {
  const action = process.env[DESTRUCTIVE_ACTION_ENV];
  const subject = action === "delete-orphan" ? process.env[ORPHAN_BOX_ID_ENV] : requireMappingId();
  if (!subject) throw new PluginError("orphan_box_id_missing", `${ORPHAN_BOX_ID_ENV} is not set.`);
  await runConfirmationPane(action, subject);
} catch (error) {
  process.stdout.write(`\n${errorMessage(error)}\n`);
  process.exitCode = 1;
}
await waitForDismiss();
