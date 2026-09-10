import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CAPTURED_MARKER,
  captureCommand,
  captureSetupToken,
  isClaudeOAuthToken,
  TokenFilter,
  verifyClaudeToken,
} from "../src/setup-token.js";

const TOKEN = `sk-ant-oat01-${"a".repeat(60)}${"b".repeat(48)}`;

describe("TokenFilter", () => {
  it("replaces a token with the marker and keeps the rest of the output", () => {
    const filter = new TokenFilter();
    const out = filter.feed(`Your token:\n${TOKEN}\nStore it.\n`, true);
    expect(out).toBe(`Your token:\n${CAPTURED_MARKER}\nStore it.\n`);
    expect(filter.token).toBe(TOKEN);
  });

  it("reassembles a token split across chunks, including inside the prefix", () => {
    const filter = new TokenFilter();
    let out = filter.feed("token: sk-an");
    out += filter.feed("t-oat01-" + TOKEN.slice(13, 40));
    out += filter.feed(TOKEN.slice(40) + "\nall done");
    out += filter.feed("", true);
    expect(out).toBe(`token: ${CAPTURED_MARKER}\nall done`);
    expect(filter.token).toBe(TOKEN);
  });

  it("does not treat a short sk-ant-oat fragment as a token", () => {
    const filter = new TokenFilter();
    filter.feed("sk-ant-oat01-tooshort\n", true);
    expect(filter.token).toBeNull();
  });

  it("holds back a partial prefix at the end of a chunk and releases it if it was not a token", () => {
    const filter = new TokenFilter();
    expect(filter.feed("see sk-")).toBe("see ");
    expect(filter.feed("ant-oa")).toBe("");
    expect(filter.feed("k\n")).toBe("sk-ant-oak\n");
  });
});

describe("TokenFilter, when the terminal wrapped the token", () => {
  it("joins a bare continuation line back onto the token and masks it", () => {
    const filter = new TokenFilter();
    const wrapped = `token:\r\n${TOKEN.slice(0, 79)}\r\n${TOKEN.slice(79)}\r\nStore it.\r\n`;
    let out = "";
    for (const chunk of wrapped.match(/.{1,17}/gs) ?? []) out += filter.feed(chunk);
    out += filter.feed("", true);
    expect(out).toBe(`token:\r\n${CAPTURED_MARKER}\r\nStore it.\r\n`);
    expect(filter.token).toBe(TOKEN);
    expect(out).not.toContain(TOKEN.slice(79, 90));
  });

  it("joins across more than one wrap", () => {
    const filter = new TokenFilter();
    const out = filter.feed(
      `${TOKEN.slice(0, 50)}\n${TOKEN.slice(50, 100)}\n${TOKEN.slice(100)}\nall done.\n`,
      true,
    );
    expect(filter.token).toBe(TOKEN);
    expect(out).toBe(`${CAPTURED_MARKER}\nall done.\n`);
  });

  it("does not swallow a real line that follows a token", () => {
    const filter = new TokenFilter();
    const out = filter.feed(`${TOKEN}\nStore this token securely.\n`, true);
    expect(out).toBe(`${CAPTURED_MARKER}\nStore this token securely.\n`);
    expect(filter.token).toBe(TOKEN);
  });

  it("treats a bare word after a token as a continuation, so the check rejects it rather than the screen showing it", () => {
    const filter = new TokenFilter();
    filter.feed(`${TOKEN}\nDone\n`, true);
    expect(filter.token).toBe(`${TOKEN}Done`);
  });

  it("holds a token that ends at a line break until told to flush, then counts it", () => {
    const filter = new TokenFilter();
    expect(filter.feed(`${TOKEN}\n`)).toBe("");
    expect(filter.holding).toBe(true);
    expect(filter.token).toBeNull();
    expect(filter.flush()).toBe(`${CAPTURED_MARKER}\n`);
    expect(filter.holding).toBe(false);
    expect(filter.token).toBe(TOKEN);
  });

  it("stops accumulating at 4096 characters", () => {
    const filter = new TokenFilter();
    const huge = `sk-ant-oat01-${"x".repeat(5000)}`;
    const out = filter.feed(`${huge}\n`, true);
    expect(filter.token?.length).toBe(4096);
    expect(out.startsWith(CAPTURED_MARKER)).toBe(true);
    expect(out).toContain("x".repeat(5000 - (4096 - 13)));
  });
});

describe("captureCommand", () => {
  it("runs claude setup-token under script, keeps the terminal wide across resizes, and skips Windows", () => {
    const darwin = captureCommand("darwin");
    expect(darwin?.command).toBe("script");
    expect(darwin?.args.slice(0, 4)).toEqual(["-q", "/dev/null", "sh", "-c"]);
    const inner = darwin?.args[4] ?? "";
    expect(inner).toContain("stty cols 1024");
    expect(inner).toContain("stty cols 1024 </dev/tty");
    expect(inner).toMatch(/exec claude setup-token$/);
    // The shell must accept it: a stray token between `&` and `exec` once made this a syntax error.
    expect(spawnSync("sh", ["-n", "-c", inner]).status).toBe(0);
    const linux = captureCommand("linux");
    expect(linux?.args).toEqual(["-q", "-f", "-c", inner, "/dev/null"]);
    expect(captureCommand("win32")).toBeNull();
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    pid: number;
    exitCode: number | null;
    kill: (signal?: string) => boolean;
    killed: string[];
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.exitCode = null;
  child.killed = [];
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
}

const noKill = () => undefined;

describe("captureSetupToken", () => {
  it("resolves as soon as the token is printed, stops the command, and never shows the token", async () => {
    const child = fakeChild();
    const shown: string[] = [];
    let killed = 0;
    const pending = captureSetupToken({
      write: (chunk) => void shown.push(chunk),
      spawnImpl: () => child as unknown as ChildProcess,
      killTree: () => {
        killed += 1;
      },
    });
    child.stdout.write("Opening browser...\r\n");
    child.stdout.write(`Your OAuth token:\r\n${TOKEN}\r\nPress any key to exit`);
    // The command never exits, so no close event: the promise must settle on the token alone.
    await expect(pending).resolves.toBe(TOKEN);
    expect(killed).toBe(1);
    const text = shown.join("");
    expect(text).toContain("Opening browser");
    expect(text).toContain(CAPTURED_MARKER);
    expect(text).not.toContain(TOKEN);
  });

  it("captures a token the terminal wrapped, and one printed on stderr", async () => {
    const wrappedChild = fakeChild();
    const wrapped = captureSetupToken({
      write: () => undefined,
      spawnImpl: () => wrappedChild as unknown as ChildProcess,
      killTree: noKill,
    });
    wrappedChild.stdout.write(`${TOKEN.slice(0, 79)}\r\n${TOKEN.slice(79)}\r\nStore it.\r\n`);
    await expect(wrapped).resolves.toBe(TOKEN);

    const errChild = fakeChild();
    const shown: string[] = [];
    const viaStderr = captureSetupToken({
      write: (chunk) => void shown.push(chunk),
      spawnImpl: () => errChild as unknown as ChildProcess,
      killTree: noKill,
    });
    errChild.stderr.write(`${TOKEN}\n`);
    await expect(viaStderr).resolves.toBe(TOKEN);
    expect(shown.join("")).not.toContain(TOKEN);
  });

  it("resolves null when the command exits without printing a token", async () => {
    const child = fakeChild();
    const pending = captureSetupToken({
      write: () => undefined,
      spawnImpl: () => child as unknown as ChildProcess,
      killTree: noKill,
    });
    child.stdout.write("Login cancelled\r\n");
    child.emit("close", 1);
    await expect(pending).resolves.toBeNull();
  });

  it("kills the command and resolves null when nothing arrives in time", async () => {
    const child = fakeChild();
    const shown: string[] = [];
    let killed = 0;
    const pending = captureSetupToken({
      write: (chunk) => void shown.push(chunk),
      spawnImpl: () => child as unknown as ChildProcess,
      killTree: () => {
        killed += 1;
      },
      timeoutMs: 20,
    });
    await expect(pending).resolves.toBeNull();
    expect(killed).toBe(1);
    expect(shown.join("")).toContain("No token came back in time");
  });

  it("keeps a token that was printed without a trailing line break when time runs out", async () => {
    const child = fakeChild();
    const pending = captureSetupToken({
      write: () => undefined,
      spawnImpl: () => child as unknown as ChildProcess,
      killTree: noKill,
      timeoutMs: 20,
    });
    // No line break after the token, so the filter is still holding it when the clock runs out.
    child.stdout.write(`token: ${TOKEN}`);
    await expect(pending).resolves.toBe(TOKEN);
  });

  it("returns null on Windows, where script is not available", async () => {
    await expect(
      captureSetupToken({ write: () => undefined, platform: "win32" }),
    ).resolves.toBeNull();
  });
});

describe("verifyClaudeToken", () => {
  const respond = (status: number) => async () => new Response(null, { status });

  it("lists models with the token and reads the status", async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: init?.headers as Record<string, string> };
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    expect(await verifyClaudeToken(TOKEN, fetchImpl)).toBe("valid");
    expect(seen).toMatchObject({
      url: "https://api.anthropic.com/v1/models",
      headers: { authorization: `Bearer ${TOKEN}`, "anthropic-beta": "oauth-2025-04-20" },
    });
    expect(await verifyClaudeToken(TOKEN, respond(401) as typeof fetch)).toBe("invalid");
    expect(await verifyClaudeToken(TOKEN, respond(403) as typeof fetch)).toBe("invalid");
    expect(await verifyClaudeToken(TOKEN, respond(500) as typeof fetch)).toBe("unknown");
    expect(await verifyClaudeToken(TOKEN, respond(429) as typeof fetch)).toBe("unknown");
    const down = (async () => {
      throw new Error("fetch failed");
    }) as typeof fetch;
    expect(await verifyClaudeToken(TOKEN, down)).toBe("unknown");
  });
});

describe("isClaudeOAuthToken", () => {
  it("accepts the shape setup-token prints and rejects a Console key", () => {
    expect(isClaudeOAuthToken(TOKEN)).toBe(true);
    expect(isClaudeOAuthToken("sk-ant-api03-console-key-0000000000000000000000000000")).toBe(false);
    expect(isClaudeOAuthToken(TOKEN.slice(0, 40))).toBe(false);
  });
});
