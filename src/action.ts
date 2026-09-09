#!/usr/bin/env node
import { runAction } from "./actions.js";
import { emitFailure } from "./result.js";

const action = process.env.HERDR_PLUGIN_ACTION_ID || "unknown";
try {
  await runAction(action);
} catch (error) {
  emitFailure(action, error);
  process.exitCode = 1;
}
