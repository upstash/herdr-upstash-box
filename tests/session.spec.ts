import { Agent } from "@upstash/box";
import { describe, expect, it } from "vitest";
import { getHarness } from "../src/harness.js";
import {
  agentCommand,
  attach,
  attachCommand,
  claudeOnboardingSeed,
  captureAgentOutput,
  ensureTmux,
  stopAgent,
  tmuxServerName,
  tmuxSessionName,
} from "../src/session.js";
import { fakeBox, MAPPING_ID } from "./helpers.js";

const MODEL = "openrouter/anthropic/claude-sonnet-5";
const SERVER = `-L 'herdr-123456781234'`;

describe("attachCommand", () => {
  const harness = getHarness(Agent.ClaudeCode);
  const base = { mappingId: MAPPING_ID, cwd: "/workspace/home", model: MODEL, resume: false };

  it("uses a private tmux server per mapping and never seeds a shared environment", () => {
    const cmd = attachCommand(harness, { ...base, exists: false });
    expect(cmd.startsWith(`tmux ${SERVER} -u new-session -A`)).toBe(true);
    expect(cmd).toContain(`-s '${tmuxSessionName(MAPPING_ID)}'`);
    expect(cmd).toContain("-c '/workspace/home'");
    expect(cmd).toContain("claude");
    expect(cmd).not.toContain("set-environment");
  });

  it("attaches without a command when the session is already up", () => {
    const cmd = attachCommand(harness, { ...base, exists: true });
    expect(cmd).toBe(`tmux ${SERVER} -u attach-session -t '${tmuxSessionName(MAPPING_ID)}'`);
  });

  it("resumes the prior conversation and appends agent arguments", () => {
    expect(agentCommand(harness, MODEL, true)).toContain("'--continue'");
    expect(agentCommand(getHarness(Agent.OpenCode), MODEL, false, ["--print-logs"])).toBe(
      `'opencode' '--model' '${MODEL}' '--print-logs'`,
    );
  });

  it("falls back to a fresh launch when continue finds no conversation", () => {
    const cmd = attachCommand(harness, { ...base, resume: true, exists: false });
    expect(cmd).toContain("sh -c");
    expect(cmd).toContain("--continue");
    expect(cmd).toContain(" || ");
  });

  it("quotes a working directory containing a space", () => {
    expect(attachCommand(harness, { ...base, cwd: "/work/my repo", exists: false })).toContain(
      "'/work/my repo'",
    );
  });
});

describe("ensureTmux", () => {
  it("passes once tmux answers and fails loudly when it never does", async () => {
    const ready = fakeBox({ commandOutput: () => ({ stdout: "TMUX_READY\n" }) });
    await expect(ensureTmux(ready.box)).resolves.toBeUndefined();
    expect(ready.calls.commands[0]).toContain("apt-get install");
    const broken = fakeBox({ commandOutput: () => ({ stdout: "" }) });
    await expect(ensureTmux(broken.box)).rejects.toThrow(/Could not install tmux/);
  });
});

describe("attach", () => {
  const options = {
    harnessId: "claude-code",
    model: MODEL,
    apiKey: "secret",
    cwd: "/workspace/home",
    mappingId: MAPPING_ID,
    rows: 40,
    cols: 120,
    onStdout: () => undefined,
  };

  it("opens a TTY session carrying the credential and herdr detection", async () => {
    const { box, calls } = fakeBox({
      commandOutput: (command) => ({
        stdout: command.includes("has-session") ? "NO\n" : "TMUX_READY\n",
      }),
    });
    const attached = await attach(box, { ...options, resume: true });
    expect(attached.reattached).toBe(false);
    expect(attached.server).toBe(tmuxServerName(MAPPING_ID));
    const session = calls.sessions[0];
    expect(session?.tty).toBe(true);
    expect(session?.rows).toBe(40);
    expect(session?.cols).toBe(120);
    expect(session?.env).toEqual(
      expect.arrayContaining([
        "ANTHROPIC_AUTH_TOKEN=secret",
        "ANTHROPIC_API_KEY=",
        "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
        "HERDR_AGENT=claude",
        "DISABLE_AUTOUPDATER=1",
        "TERM=xterm-256color",
      ]),
    );
    expect(session?.env).not.toContain("ANTHROPIC_API_KEY=secret");
    expect(session?.cmd).toContain(SERVER);
    expect(session?.cmd).toContain("--continue");
    expect(session?.cmd).toContain(" || ");
    expect(session?.cmd).not.toContain("secret");
    expect(calls.commands[1]).toContain(`${SERVER} has-session`);
  });

  it("reattaches to a session that survived the last pane", async () => {
    const { box, calls } = fakeBox({
      commandOutput: (command) => ({
        stdout: command.includes("has-session") ? "YES\n" : "TMUX_READY\n",
      }),
    });
    const attached = await attach(box, { ...options, resume: false });
    expect(attached.reattached).toBe(true);
    expect(calls.sessions[0]?.cmd).toContain("attach-session");
    expect(calls.sessions[0]?.cmd).not.toContain("claude");
  });

  it("refuses a harness and model that cannot work together before touching the box", async () => {
    const { box, calls } = fakeBox();
    await expect(attach(box, { ...options, harnessId: "codex", resume: false })).rejects.toThrow(
      /Responses API/,
    );
    expect(calls.commands).toEqual([]);
  });
});

describe("stopAgent and captureAgentOutput", () => {
  it("kills the session and its private server", async () => {
    const running = fakeBox({ commandOutput: () => ({ stdout: "STOPPED\n" }) });
    expect(await stopAgent(running.box, MAPPING_ID)).toBe("stopped");
    expect(running.calls.commands[0]).toContain("kill-session");
    expect(running.calls.commands[0]).toContain(`${SERVER} kill-server`);
    const idle = fakeBox({ commandOutput: () => ({ stdout: "NOT_RUNNING\n" }) });
    expect(await stopAgent(idle.box, MAPPING_ID)).toBe("not_running");
  });

  it("returns the visible scrollback or names a missing session", async () => {
    const live = fakeBox({ commandOutput: () => ({ stdout: "hello\n", exitCode: 0 }) });
    expect(await captureAgentOutput(live.box, MAPPING_ID, 50)).toBe("hello\n");
    expect(live.calls.commands[0]).toContain("-S -50");
    const gone = fakeBox({ commandOutput: () => ({ stdout: "", exitCode: 1 }) });
    await expect(captureAgentOutput(gone.box, MAPPING_ID)).rejects.toThrow(/not running/);
  });
});

describe("names", () => {
  it("are stable and shell-safe", () => {
    expect(tmuxServerName(MAPPING_ID)).toBe("herdr-123456781234");
    expect(tmuxSessionName(MAPPING_ID)).toBe("herdr-12345678-123");
    expect(tmuxServerName("weird/id:here")).toMatch(/^[A-Za-z0-9-]+$/);
  });
});

describe("Claude Code first run", () => {
  it("marks onboarding complete and the worktree trusted, without losing other settings", () => {
    const fresh = claudeOnboardingSeed(null, "/workspace/home/worktree");
    expect(fresh.hasCompletedOnboarding).toBe(true);
    expect(fresh.projects).toEqual({
      "/workspace/home/worktree": { hasTrustDialogAccepted: true },
    });
    const merged = claudeOnboardingSeed(
      {
        theme: "dark",
        userID: "abc",
        projects: {
          "/other": { hasTrustDialogAccepted: true },
          "/workspace/home/worktree": { allowedTools: ["Read"], hasTrustDialogAccepted: false },
        },
      },
      "/workspace/home/worktree",
    );
    expect(merged).toMatchObject({ theme: "dark", userID: "abc", hasCompletedOnboarding: true });
    expect(merged.projects).toEqual({
      "/other": { hasTrustDialogAccepted: true },
      "/workspace/home/worktree": { allowedTools: ["Read"], hasTrustDialogAccepted: true },
    });
  });

  it("seeds the config before attaching, and only for Claude Code", async () => {
    const claude = fakeBox({
      commandOutput: (command) => ({
        stdout: command.includes("has-session") ? "NO\n" : "TMUX_READY\n",
      }),
    });
    await attach(claude.box, {
      harnessId: "claude-code",
      model: MODEL,
      apiKey: "secret",
      cwd: "/workspace/home/worktree",
      mappingId: MAPPING_ID,
      resume: false,
      rows: 24,
      cols: 80,
      onStdout: () => undefined,
    });
    const seeded = claude.calls.writes.find((entry) => entry.path.endsWith(".claude.json"));
    expect(seeded).toBeDefined();
    expect(JSON.parse(seeded?.content ?? "{}")).toMatchObject({
      hasCompletedOnboarding: true,
      projects: { "/workspace/home/worktree": { hasTrustDialogAccepted: true } },
    });
    expect(seeded?.content).not.toContain("secret");
    const codex = fakeBox({
      commandOutput: (command) => ({
        stdout: command.includes("has-session") ? "NO\n" : "TMUX_READY\n",
      }),
    });
    await attach(codex.box, {
      harnessId: "codex",
      model: "openai/gpt-5",
      apiKey: "secret",
      cwd: "/workspace/home/worktree",
      mappingId: MAPPING_ID,
      resume: false,
      rows: 24,
      cols: 80,
      onStdout: () => undefined,
    });
    expect(codex.calls.writes).toEqual([]);
  });
});
