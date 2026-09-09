import type { Box, ExecSessionHandle } from "@upstash/box";
import { Agent } from "@upstash/box";
import { getHarness, launchEnv, modelArg, type Harness } from "./harness.js";
import { PluginError } from "./result.js";

export function shellQuote(value: string): string {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function idSlug(mappingId: string): string {
  return mappingId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "default";
}

// Each mapping gets its own tmux server socket, so no server is ever shared between mappings.
export function tmuxServerName(mappingId: string): string {
  return `herdr-${idSlug(mappingId)}`;
}

export function tmuxSessionName(mappingId: string): string {
  return `herdr-${mappingId.slice(0, 12)}`.replace(/[^A-Za-z0-9_-]/g, "-");
}

export function tmux(mappingId: string): string {
  return `tmux -L ${shellQuote(tmuxServerName(mappingId))}`;
}

async function commandOutput(box: Box, command: string): Promise<string> {
  const run = await box.exec.command(command);
  return String(run.stdout ?? run.result ?? "");
}

export async function ensureTmux(box: Box): Promise<void> {
  const output = await commandOutput(
    box,
    "command -v tmux >/dev/null 2>&1 || " +
      "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null 2>&1 || " +
      "(sudo apt-get update -qq >/dev/null 2>&1 && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux >/dev/null 2>&1) || " +
      "sudo apk add --no-cache tmux >/dev/null 2>&1; " +
      "command -v tmux >/dev/null 2>&1 && echo TMUX_READY",
  );
  if (!output.includes("TMUX_READY")) {
    throw new PluginError("tmux_unavailable", "Could not install tmux in the box.");
  }
}

export async function hasTmuxSession(box: Box, mappingId: string): Promise<boolean> {
  const output = await commandOutput(
    box,
    `${tmux(mappingId)} has-session -t ${shellQuote(tmuxSessionName(mappingId))} 2>/dev/null && echo YES || echo NO`,
  );
  return output.includes("YES");
}

export function agentCommand(
  harness: Harness,
  model: string,
  resume: boolean,
  agentArgs: readonly string[] = [],
): string {
  const argv = [
    harness.bin,
    ...(resume ? harness.continueArgv : []),
    "--model",
    modelArg(harness, model),
    ...agentArgs,
  ];
  return argv.map(shellQuote).join(" ");
}

// --continue fails with "no conversation found" after a trust-only first launch.
export function windowCommand(
  harness: Harness,
  model: string,
  resume: boolean,
  agentArgs: readonly string[] = [],
): string {
  const start = agentCommand(harness, model, false, agentArgs);
  if (!resume) return start;
  return `${agentCommand(harness, model, true, agentArgs)} || ${start}`;
}

export interface AttachCommandOptions {
  mappingId: string;
  cwd: string;
  model: string;
  resume: boolean;
  exists: boolean;
  agentArgs?: readonly string[];
}

// A new server inherits this exec session's environment; an existing session needs none.
export function attachCommand(harness: Harness, options: AttachCommandOptions): string {
  const session = shellQuote(tmuxSessionName(options.mappingId));
  if (options.exists) return `${tmux(options.mappingId)} -u attach-session -t ${session}`;
  return [
    `${tmux(options.mappingId)} -u new-session -A`,
    `-s ${session}`,
    `-c ${shellQuote(options.cwd)}`,
    "sh",
    "-c",
    shellQuote(windowCommand(harness, options.model, options.resume, options.agentArgs)),
  ].join(" ");
}

export const HARNESS_HOME = "/home/boxuser";

export function claudeOnboardingSeed(existing: unknown, cwd: string): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const projects =
    base.projects && typeof base.projects === "object" && !Array.isArray(base.projects)
      ? { ...(base.projects as Record<string, unknown>) }
      : {};
  const project =
    projects[cwd] && typeof projects[cwd] === "object" && !Array.isArray(projects[cwd])
      ? { ...(projects[cwd] as Record<string, unknown>) }
      : {};
  base.hasCompletedOnboarding = true;
  projects[cwd] = { ...project, hasTrustDialogAccepted: true };
  base.projects = projects;
  return base;
}

// A fresh box asks for a theme, then security notes, then a trust prompt whose default is
// "No, exit". Seeding the config opens the agent on a prompt instead.
export async function seedClaudeOnboarding(box: Box, cwd: string): Promise<void> {
  const file = `${HARNESS_HOME}/.claude.json`;
  let existing: unknown = null;
  try {
    existing = JSON.parse(await box.files.read(file));
  } catch {
    existing = null;
  }
  const seeded = claudeOnboardingSeed(existing, cwd);
  await box.files.write({ path: file, content: JSON.stringify(seeded, null, 2) });
}

export interface AttachOptions {
  harnessId: string;
  model: string;
  apiKey: string;
  cwd: string;
  mappingId: string;
  resume: boolean;
  rows: number;
  cols: number;
  agentArgs?: readonly string[];
  onStdout: (data: Uint8Array) => void;
}

export interface Attached {
  handle: ExecSessionHandle;
  server: string;
  session: string;
  reattached: boolean;
}

export async function attach(box: Box, options: AttachOptions): Promise<Attached> {
  const harness = getHarness(options.harnessId);
  const credentials = launchEnv(harness, options.model, options.apiKey);
  await ensureTmux(box);
  if (harness.id === Agent.ClaudeCode) await seedClaudeOnboarding(box, options.cwd);
  const exists = await hasTmuxSession(box, options.mappingId);
  const cmd = attachCommand(harness, {
    mappingId: options.mappingId,
    cwd: options.cwd,
    model: options.model,
    resume: options.resume,
    exists,
    agentArgs: options.agentArgs,
  });
  const handle = await box.exec.session({
    cmd,
    tty: true,
    rows: options.rows,
    cols: options.cols,
    env: [
      ...credentials,
      `HERDR_AGENT=${harness.detectionKind}`,
      // The image pins the harness version, so a self-update can only fail and show an error line.
      "DISABLE_AUTOUPDATER=1",
      "TERM=xterm-256color",
      "COLORTERM=truecolor",
    ],
    onStdout: options.onStdout,
  });
  return {
    handle,
    server: tmuxServerName(options.mappingId),
    session: tmuxSessionName(options.mappingId),
    reattached: exists,
  };
}

export async function agentSessionRunning(box: Box, mappingId: string): Promise<boolean> {
  return hasTmuxSession(box, mappingId);
}

export async function stopAgent(box: Box, mappingId: string): Promise<"stopped" | "not_running"> {
  const session = shellQuote(tmuxSessionName(mappingId));
  const output = await commandOutput(
    box,
    `if ${tmux(mappingId)} has-session -t ${session} 2>/dev/null; then ${tmux(mappingId)} kill-session -t ${session} && echo STOPPED; else echo NOT_RUNNING; fi; ${tmux(mappingId)} kill-server 2>/dev/null; true`,
  );
  return output.includes("STOPPED") ? "stopped" : "not_running";
}

export async function captureAgentOutput(
  box: Box,
  mappingId: string,
  lines = 200,
): Promise<string> {
  const count = Math.max(1, Math.min(lines, 2000));
  const run = await box.exec.command(
    `${tmux(mappingId)} capture-pane -pt ${shellQuote(tmuxSessionName(mappingId))} -S -${count} 2>/dev/null`,
  );
  if (run.exitCode !== 0) {
    throw new PluginError("agent_session_not_running", "The agent session is not running.");
  }
  return String(run.stdout ?? "");
}
