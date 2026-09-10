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
    out += filter.feed(TOKEN.slice(40) + "\ndone");
    out += filter.feed("", true);
    expect(out).toBe(`token: ${CAPTURED_MARKER}\ndone`);
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

describe("captureCommand", () => {
  it("runs claude setup-token under script with a wide terminal", () => {
    expect(captureCommand("darwin")).toEqual({
      command: "script",
      args: ["-q", "/dev/null", "sh", "-c", "stty cols 1024 2>/dev/null; exec claude setup-token"],
    });
    expect(captureCommand("linux").args).toEqual([
      "-q",
      "-f",
      "-c",
      "stty cols 1024 2>/dev/null; exec claude setup-token",
      "/dev/null",
    ]);
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    kill: (signal?: string) => boolean;
    killed: string[];
  };
  child.stdout = new PassThrough();
  child.killed = [];
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? "SIGTERM");
    return true;
  };
  return child;
}

describe("captureSetupToken", () => {
  it("shows the command's output with the token masked and resolves with the token", async () => {
    const child = fakeChild();
    const shown: string[] = [];
    const pending = captureSetupToken({
      write: (chunk) => void shown.push(chunk),
      spawnImpl: () => child as unknown as ChildProcess,
    });
    child.stdout.write("Opening browser...\r\n");
    child.stdout.write(`Your OAuth token:\r\n${TOKEN}\r\n`);
    child.stdout.end();
    child.emit("close", 0);
    await expect(pending).resolves.toBe(TOKEN);
    const text = shown.join("");
    expect(text).toContain("Opening browser");
    expect(text).toContain(CAPTURED_MARKER);
    expect(text).not.toContain(TOKEN);
  });

  it("resolves null when the command exits without printing a token", async () => {
    const child = fakeChild();
    const pending = captureSetupToken({
      write: () => undefined,
      spawnImpl: () => child as unknown as ChildProcess,
    });
    child.stdout.write("Login cancelled\r\n");
    child.emit("close", 1);
    await expect(pending).resolves.toBeNull();
  });

  it("kills the command and resolves null when nothing arrives in time", async () => {
    const child = fakeChild();
    const shown: string[] = [];
    const pending = captureSetupToken({
      write: (chunk) => void shown.push(chunk),
      spawnImpl: () => child as unknown as ChildProcess,
      timeoutMs: 20,
    });
    await expect(pending).resolves.toBeNull();
    expect(child.killed).toEqual(["SIGTERM"]);
    expect(shown.join("")).toContain("No token came back in time");
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
