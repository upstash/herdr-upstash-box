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

// Reads a secret without echoing it, so a key never lands in the pane scrollback.
export async function askHidden(
  question: string,
  timeoutMs = DISMISS_TIMEOUT_MS,
): Promise<string | null> {
  if (!isInteractive()) {
    throw new PluginError(
      "interactive_terminal_required",
      "This operation needs an interactive Herdr terminal.",
    );
  }
  const stdin = process.stdin;
  process.stdout.write(question);
  const wasRaw = stdin.isRaw ?? false;
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (value: string | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk: string) => {
      // An escape sequence (arrow keys, function keys) arrives as one chunk and is not input.
      if (chunk.startsWith("\u001b")) return;
      for (const character of chunk) {
        if (character === "\u0003") return finish(null);
        if (character === "\r" || character === "\n") return finish(buffer);
        if (character === "\u007f" || character === "\b") {
          buffer = buffer.slice(0, -1);
        } else if (character >= " ") {
          buffer += character;
        }
      }
    };
    stdin.on("data", onData);
  });
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
