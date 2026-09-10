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

export interface HiddenInput {
  buffer: string;
  inPaste: boolean;
  pending: string;
}

const CSI = /^\u001b\[[0-9;?]*[ -/]*[@-~]/;
const SS3 = /^\u001bO[@-~]/;
const ESCAPE_PAIR = /^\u001b[@-Z\\-_]/;
const INCOMPLETE_ESCAPE = /^\u001b(\[[0-9;?]*[ -/]*|O)?$/;

// A terminal wraps a long token when it is copied, so a line break inside a bracketed paste is part
// of the paste, not Enter. Cursor keys and other escape sequences are never input.
export function feedHiddenInput(
  state: HiddenInput,
  chunk: string,
): "continue" | "submit" | "cancel" {
  let text = state.pending + chunk;
  state.pending = "";
  while (text.length > 0) {
    if (text.startsWith("\u001b")) {
      if (text.startsWith("\u001b[200~")) {
        state.inPaste = true;
        text = text.slice(6);
        continue;
      }
      if (text.startsWith("\u001b[201~")) {
        state.inPaste = false;
        text = text.slice(6);
        continue;
      }
      const sequence = CSI.exec(text) ?? SS3.exec(text) ?? ESCAPE_PAIR.exec(text);
      if (sequence) {
        text = text.slice(sequence[0].length);
        continue;
      }
      if (INCOMPLETE_ESCAPE.test(text)) {
        state.pending = text;
        return "continue";
      }
      text = text.slice(1);
      continue;
    }
    const character = text[0] as string;
    text = text.slice(1);
    if (character === "\u0003") return "cancel";
    if (character === "\r" || character === "\n") {
      if (state.inPaste) continue;
      return "submit";
    }
    if (character === "\u007f" || character === "\b") {
      state.buffer = state.buffer.slice(0, -1);
    } else if (character >= " ") {
      state.buffer += character;
    }
  }
  return "continue";
}

const BRACKETED_PASTE_ON = "\u001b[?2004h";
const BRACKETED_PASTE_OFF = "\u001b[?2004l";

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
  const wasRaw = stdin.isRaw ?? false;
  const restore = () => {
    process.stdout.write(BRACKETED_PASTE_OFF);
    stdin.setRawMode(wasRaw);
    stdin.pause();
  };
  process.stdout.write(`${BRACKETED_PASTE_ON}${question}`);
  try {
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
  } catch (error) {
    restore();
    throw error;
  }
  return new Promise((resolve) => {
    const state: HiddenInput = { buffer: "", inPaste: false, pending: "" };
    const finish = (value: string | null) => {
      clearTimeout(timer);
      stdin.off("data", onData);
      restore();
      process.stdout.write("\n");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const onData = (chunk: string) => {
      const result = feedHiddenInput(state, chunk);
      if (result === "cancel") finish(null);
      else if (result === "submit") finish(state.buffer);
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
