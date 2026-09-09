import type { ExecSessionHandle } from "@upstash/box";

export interface InputStream {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
  off: (event: "data", listener: (chunk: Buffer | string) => void) => unknown;
}

export interface OutputStream {
  columns?: number;
  rows?: number;
  on: (event: "resize", listener: () => void) => unknown;
  off: (event: "resize", listener: () => void) => unknown;
}

export interface SignalSource {
  once: (event: "SIGTERM" | "SIGHUP", listener: () => void) => unknown;
  off: (event: "SIGTERM" | "SIGHUP", listener: () => void) => unknown;
}

export interface TerminalLike {
  stdin: InputStream;
  stdout: OutputStream;
  signals?: SignalSource;
}

export interface TerminalSize {
  rows: number;
  cols: number;
}

export function terminalSize(stdout: OutputStream = process.stdout): TerminalSize {
  return { rows: stdout.rows || 24, cols: stdout.columns || 80 };
}

export type SessionBridge = Pick<ExecSessionHandle, "write" | "resize" | "terminate" | "wait">;

export async function bridgeTerminal(
  handle: SessionBridge,
  terminal: TerminalLike = { stdin: process.stdin, stdout: process.stdout, signals: process },
): Promise<number> {
  const { stdin, stdout } = terminal;
  const signals = terminal.signals ?? process;
  const wasRaw = stdin.isRaw ?? false;
  if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(true);
  const onData = (chunk: Buffer | string): void => {
    handle.write(chunk);
  };
  const onResize = (): void => {
    const size = terminalSize(stdout);
    handle.resize(size.rows, size.cols);
  };
  const onSignal = (): void => {
    handle.terminate();
  };
  stdin.on("data", onData);
  stdin.resume();
  stdout.on("resize", onResize);
  signals.once("SIGTERM", onSignal);
  signals.once("SIGHUP", onSignal);
  try {
    return await handle.wait();
  } finally {
    stdin.off("data", onData);
    stdout.off("resize", onResize);
    signals.off("SIGTERM", onSignal);
    signals.off("SIGHUP", onSignal);
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(wasRaw);
    stdin.pause();
  }
}
