import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { bridgeTerminal, terminalSize } from "../src/terminal.js";

function fakeStdin() {
  const raw: boolean[] = [];
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    raw,
    setRawMode(mode: boolean) {
      raw.push(mode);
      this.isRaw = mode;
      return this;
    },
    resume() {},
    pause() {},
  });
}

function fakeStdout() {
  return Object.assign(new EventEmitter(), { columns: 100, rows: 30 });
}

function fakeHandle() {
  let resolveWait: (code: number) => void = () => undefined;
  const wait = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  return {
    written: [] as string[],
    resized: [] as Array<[number, number]>,
    terminated: 0,
    write(data: string | Uint8Array) {
      this.written.push(String(data));
    },
    resize(rows: number, cols: number) {
      this.resized.push([rows, cols]);
    },
    terminate() {
      this.terminated += 1;
      resolveWait(143);
    },
    wait: () => wait,
    finish: (code: number) => resolveWait(code),
  };
}

describe("bridgeTerminal", () => {
  it("forwards keystrokes and resizes, then restores the terminal", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const signals = new EventEmitter();
    const handle = fakeHandle();
    const done = bridgeTerminal(handle, { stdin, stdout, signals });
    stdin.emit("data", "ls\r");
    stdout.columns = 120;
    stdout.emit("resize");
    handle.finish(0);
    expect(await done).toBe(0);
    expect(handle.written).toEqual(["ls\r"]);
    expect(handle.resized).toEqual([[30, 120]]);
    expect(stdin.raw).toEqual([true, false]);
    expect(stdout.listenerCount("resize")).toBe(0);
    expect(stdin.listenerCount("data")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("terminates the remote process when the pane is torn down", async () => {
    const stdin = fakeStdin();
    const stdout = fakeStdout();
    const signals = new EventEmitter();
    const handle = fakeHandle();
    const done = bridgeTerminal(handle, { stdin, stdout, signals });
    signals.emit("SIGHUP");
    expect(await done).toBe(143);
    expect(handle.terminated).toBe(1);
  });
});

describe("terminalSize", () => {
  it("falls back to a classic terminal", () => {
    expect(terminalSize({ on() {}, off() {} })).toEqual({ rows: 24, cols: 80 });
    expect(terminalSize({ rows: 50, columns: 200, on() {}, off() {} })).toEqual({
      rows: 50,
      cols: 200,
    });
  });
});
