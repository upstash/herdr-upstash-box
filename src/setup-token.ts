import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Writer } from "./result.js";

// A subscription token printed by `claude setup-token`: sk-ant-oat01-... today.
const TOKEN = /^sk-ant-oat\d{2}-[A-Za-z0-9_-]{40,}$/;
const PREFIX = "sk-ant-oat";
const TOKEN_CHAR = /^[A-Za-z0-9_-]$/;
export const CAPTURE_TIMEOUT_MS = 10 * 60_000;
export const CAPTURED_MARKER = "[token captured]";

export function isClaudeOAuthToken(value: string): boolean {
  return TOKEN.test(value.trim());
}

// Streams the command's output through, replacing any token with a marker so it never reaches the
// screen. A prefix split across chunks is held back until the next chunk says what it is.
export class TokenFilter {
  private pending = "";
  private secret: string | null = null;
  readonly tokens: string[] = [];

  feed(text: string, final = false): string {
    this.pending += text;
    let output = "";
    while (this.pending.length > 0) {
      if (this.secret !== null) {
        const char = this.pending[0] as string;
        if (TOKEN_CHAR.test(char)) {
          this.secret += char;
          this.pending = this.pending.slice(1);
          continue;
        }
        output += this.finish();
      } else if (this.pending.startsWith(PREFIX)) {
        this.secret = PREFIX;
        this.pending = this.pending.slice(PREFIX.length);
      } else if (PREFIX.startsWith(this.pending)) {
        break;
      } else {
        output += this.pending[0];
        this.pending = this.pending.slice(1);
      }
    }
    if (final) {
      if (this.secret !== null) output += this.finish();
      this.pending = "";
    }
    return output;
  }

  get token(): string | null {
    return this.tokens.at(-1) ?? null;
  }

  private finish(): string {
    const secret = this.secret as string;
    this.secret = null;
    if (isClaudeOAuthToken(secret)) this.tokens.push(secret);
    return CAPTURED_MARKER;
  }
}

export function claudeAvailable(): boolean {
  return spawnSync("sh", ["-c", "command -v claude >/dev/null 2>&1"]).status === 0;
}

// `script` gives the command a real terminal, which it needs for the browser flow and for its
// paste-a-code fallback. The terminal is widened because Ink hard-wraps the token at the width.
export function captureCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} {
  const inner = "stty cols 1024 2>/dev/null; exec claude setup-token";
  return platform === "darwin"
    ? { command: "script", args: ["-q", "/dev/null", "sh", "-c", inner] }
    : { command: "script", args: ["-q", "-f", "-c", inner, "/dev/null"] };
}

export interface CaptureOptions {
  write: Writer;
  timeoutMs?: number;
  spawnImpl?: (command: string, args: string[]) => ChildProcess;
  platform?: NodeJS.Platform;
}

// Resolves with the token, or null when the command fails, times out, or prints none.
export function captureSetupToken(options: CaptureOptions): Promise<string | null> {
  const { command, args } = captureCommand(options.platform);
  const child = (options.spawnImpl ?? defaultSpawn)(command, args);
  const filter = new TokenFilter();
  const decoder = new TextDecoder();
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Herdr has one popup slot, so an abandoned browser approval must not hold it forever.
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      options.write(`${filter.feed("", true)}\nNo token came back in time.\n`);
      settle(null);
    }, options.timeoutMs ?? CAPTURE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      options.write(filter.feed(decoder.decode(chunk, { stream: true })));
    });
    child.on("error", () => settle(null));
    child.on("close", () => {
      options.write(filter.feed(decoder.decode(), true));
      settle(filter.token);
    });
  });
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: ["inherit", "pipe", "inherit"] });
}

export type TokenCheck = "valid" | "invalid" | "unknown";

// A read-only model listing: no quota spent. Only an outright rejection counts as a bad token.
export async function verifyClaudeToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenCheck> {
  try {
    const response = await fetchImpl("https://api.anthropic.com/v1/models", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 401 || response.status === 403) return "invalid";
    return response.ok ? "valid" : "unknown";
  } catch {
    return "unknown";
  }
}
