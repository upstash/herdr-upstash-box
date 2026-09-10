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

const MAX_TOKEN_LENGTH = 4096;
const CONTINUATION = /^[A-Za-z0-9_-]+$/;

// Streams the command's output through, replacing any token with a marker so it never reaches the
// screen. A prefix split across chunks is held back until the next chunk says what it is. A token
// the terminal hard-wrapped arrives as a token line followed by a bare run of token characters, so
// a token that ends at a line break is held until the next line shows whether it continues; a real
// line ("Store this token securely.") has spaces or punctuation and is released as is. The caller
// bounds the hold with `flush`, since the command may print the token and then wait.
export class TokenFilter {
  private pending = "";
  private secret: string | null = null;
  private held: { secret: string; linebreak: string } | null = null;
  readonly tokens: string[] = [];

  feed(text: string, final = false): string {
    this.pending += text;
    let output = "";
    while (this.pending.length > 0) {
      if (this.held !== null) {
        const newline = this.pending.search(/[\r\n]/);
        if (newline < 0) break;
        const line = this.pending.slice(0, newline);
        this.pending = this.pending.slice(newline);
        output += this.decide(line);
        continue;
      }
      if (this.secret !== null) {
        const char = this.pending[0] as string;
        if (TOKEN_CHAR.test(char) && this.secret.length < MAX_TOKEN_LENGTH) {
          this.secret += char;
          this.pending = this.pending.slice(1);
          continue;
        }
        output += this.end();
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
    if (final) output += this.flush();
    return output;
  }

  // True while a decision is waiting on more output: a token in progress, or one held at a break.
  get holding(): boolean {
    return this.secret !== null || this.held !== null;
  }

  // Ends the wait: whatever is in progress is treated as complete and everything pending released.
  flush(): string {
    let output = "";
    if (this.secret !== null) {
      const secret = this.secret;
      this.secret = null;
      output += this.settle(secret);
    }
    if (this.held !== null) {
      const line = this.pending;
      this.pending = "";
      output += this.decide(line);
    }
    output += this.pending;
    this.pending = "";
    return output;
  }

  get token(): string | null {
    return this.tokens.at(-1) ?? null;
  }

  // A candidate ended. At a line break it is held; anywhere else it is decided now.
  private end(): string {
    const secret = this.secret as string;
    this.secret = null;
    const linebreak = /^\r?\n|^\r/.exec(this.pending)?.[0];
    if (linebreak === undefined) return this.settle(secret);
    this.pending = this.pending.slice(linebreak.length);
    this.held = { secret, linebreak };
    return "";
  }

  private decide(line: string): string {
    const { secret, linebreak } = this.held as { secret: string; linebreak: string };
    this.held = null;
    if (
      line.length > 0 &&
      CONTINUATION.test(line) &&
      secret.length + line.length <= MAX_TOKEN_LENGTH
    ) {
      this.secret = secret + line;
      return this.end();
    }
    this.pending = line + this.pending;
    return `${this.settle(secret)}${linebreak}`;
  }

  // Anything that started with the prefix is masked; only a well-formed one counts as the token.
  private settle(secret: string): string {
    if (isClaudeOAuthToken(secret)) this.tokens.push(secret);
    return CAPTURED_MARKER;
  }
}

export function claudeAvailable(): boolean {
  return spawnSync("sh", ["-c", "command -v claude >/dev/null 2>&1"]).status === 0;
}

// `script` gives the command a real terminal, which it needs for the browser flow and for its
// paste-a-code fallback. The terminal is widened because Ink hard-wraps the token at the width. A
// background loop keeps re-applying the width, since util-linux script forwards a resize of the
// popup onto the inner terminal (BSD script does not); it stops once the command is gone. The
// command itself stays in the foreground so it keeps the terminal as its stdin.
export const INNER =
  "stty cols 1024 2>/dev/null; " +
  "( while kill -0 $$ 2>/dev/null; do sleep 0.5; stty cols 1024 </dev/tty 2>/dev/null; done ) & " +
  "exec claude setup-token";

export function captureCommand(platform: NodeJS.Platform = process.platform): {
  command: string;
  args: string[];
} | null {
  if (platform === "win32") return null;
  return platform === "darwin"
    ? { command: "script", args: ["-q", "/dev/null", "sh", "-c", INNER] }
    : { command: "script", args: ["-q", "-f", "-c", INNER, "/dev/null"] };
}

export interface CaptureOptions {
  write: Writer;
  timeoutMs?: number;
  spawnImpl?: (command: string, args: string[]) => ChildProcess;
  killTree?: (child: ChildProcess) => void;
  platform?: NodeJS.Platform;
}

// A wrapped continuation arrives in the same write as the token line; a token the command prints
// and then waits behind is decided after this much silence.
export const HOLD_MS = 300;

// Resolves with the token as soon as one is printed, and stops the command then: nothing it prints
// afterwards can reach the screen. Resolves null when the command fails, times out, or prints none.
export function captureSetupToken(options: CaptureOptions): Promise<string | null> {
  const spec = captureCommand(options.platform);
  if (!spec) return Promise.resolve(null);
  const child = (options.spawnImpl ?? defaultSpawn)(spec.command, spec.args);
  const out = new TokenFilter();
  const err = new TokenFilter();
  const kill = options.killTree ?? killTree;
  return new Promise((resolve) => {
    let settled = false;
    let hold: NodeJS.Timeout | undefined;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hold);
      resolve(value);
    };
    const captured = () => out.token ?? err.token;
    const finishIfCaptured = () => {
      const token = captured();
      if (!token) return;
      options.write("\n");
      kill(child);
      settle(token);
    };
    // Herdr has one popup slot, so an abandoned browser approval must not hold it forever.
    const timer = setTimeout(() => {
      kill(child);
      options.write(`${out.flush()}${err.flush()}`);
      const token = captured();
      if (!token) options.write("\nNo token came back in time.\n");
      settle(token);
    }, options.timeoutMs ?? CAPTURE_TIMEOUT_MS);
    // Once settled, nothing more from the command is shown: a token tail that arrives after a stump
    // was accepted is dropped, and the stump then fails verification instead.
    const onData = (filter: TokenFilter) => (chunk: Buffer | string) => {
      if (settled) return;
      options.write(filter.feed(chunk.toString()));
      finishIfCaptured();
      clearTimeout(hold);
      if (!settled && (out.holding || err.holding)) {
        hold = setTimeout(() => {
          options.write(`${out.flush()}${err.flush()}`);
          finishIfCaptured();
        }, HOLD_MS);
      }
    };
    child.stdout?.on("data", onData(out));
    child.stderr?.on("data", onData(err));
    child.on("error", () => settle(null));
    child.on("close", () => {
      if (settled) return;
      options.write(`${out.flush()}${err.flush()}`);
      settle(captured());
    });
  });
}

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: ["inherit", "pipe", "pipe"] });
}

// script's own child is the shell running claude; both must go, and a lingering claude would keep
// the browser flow alive after the popup has moved on.
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  const pid = child.pid;
  spawnSync("pkill", ["-TERM", "-P", String(pid)]);
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null) {
      spawnSync("pkill", ["-KILL", "-P", String(pid)]);
      child.kill("SIGKILL");
    }
  }, 1000).unref();
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
