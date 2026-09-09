import readline from "node:readline/promises";
import { MAPPING_ID_ENV, SOURCE_CONTEXT_ENV } from "./constants.js";
import { parsePluginContext, type PluginContext } from "./context.js";
import { PluginError, type Writer } from "./result.js";
import { readState, type Mapping, type StateOptions } from "./state.js";

export const stdoutWriter: Writer = (chunk) => {
  process.stdout.write(chunk);
};

export function clearScreen(write: Writer = stdoutWriter): void {
  write("\u001b[2J\u001b[H");
}

export function sourceContext(env: NodeJS.ProcessEnv = process.env): PluginContext {
  return parsePluginContext(env[SOURCE_CONTEXT_ENV] ?? env.HERDR_PLUGIN_CONTEXT_JSON);
}

export function requireMappingId(env: NodeJS.ProcessEnv = process.env): string {
  const id = env[MAPPING_ID_ENV];
  if (!id) throw new PluginError("mapping_id_missing", `${MAPPING_ID_ENV} is not set.`);
  return id;
}

export function requireMappingById(mappingId: string, state?: StateOptions): Mapping {
  const mapping = readState(state).mappings[mappingId];
  if (!mapping) {
    throw new PluginError("mapping_not_found", `Mapping ${mappingId} no longer exists.`);
  }
  return mapping;
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Bounded like every other prompt: an unanswered one would hold Herdr's single popup slot forever.
export async function ask(question: string): Promise<string | null> {
  return askWithTimeout(question, DISMISS_TIMEOUT_MS);
}

export const DISMISS_TIMEOUT_MS = 120_000;

// A popup that waits forever blocks every other popup verb, so an unattended one closes itself.
export async function waitForDismiss(
  message = "\nPress Enter to close. ",
  timeoutMs = DISMISS_TIMEOUT_MS,
): Promise<void> {
  if (!isInteractive()) return;
  await askWithTimeout(message, timeoutMs).catch(() => null);
}

export async function askWithTimeout(question: string, timeoutMs: number): Promise<string | null> {
  if (!isInteractive()) {
    throw new PluginError(
      "interactive_terminal_required",
      "This operation needs an interactive Herdr terminal.",
    );
  }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      terminal.close();
      resolve(null);
    }, timeoutMs);
    terminal.question(question).then(
      (answer) => {
        clearTimeout(timer);
        terminal.close();
        resolve(answer);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}
