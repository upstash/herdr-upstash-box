import fs from "node:fs";
import path from "node:path";
import { runSync } from "./process.js";
import { PluginError } from "./result.js";

export interface PluginContext {
  focused_pane_id?: string;
  focused_pane_cwd?: string;
  workspace_id?: string;
  workspace_cwd?: string;
  worktree?: { checkout_path?: string; branch?: string };
}

export interface GitContext {
  root: string;
  cwd: string;
  relativeCwd: string;
  branch: string | null;
  sourcePaneId: string | null;
}

export function parsePluginContext(raw = process.env.HERDR_PLUGIN_CONTEXT_JSON): PluginContext {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PluginError(
      "invalid_herdr_context",
      `HERDR_PLUGIN_CONTEXT_JSON is invalid: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PluginError("invalid_herdr_context", "HERDR_PLUGIN_CONTEXT_JSON must be an object.");
  }
  return parsed as PluginContext;
}

export function contextCwd(context: PluginContext, fallback = process.cwd()): string {
  const focused = context.focused_pane_cwd;
  const checkout = context.worktree?.checkout_path;
  if (checkout) {
    if (focused) {
      const relative = path.relative(path.resolve(checkout), path.resolve(focused));
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`)) return focused;
    }
    return checkout;
  }
  return focused ?? context.workspace_cwd ?? fallback;
}

export function resolveGitContext(
  context: PluginContext,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): GitContext {
  const requested = path.resolve(contextCwd(context, options.cwd));
  let cwd: string;
  try {
    cwd = fs.realpathSync.native(requested);
  } catch {
    throw new PluginError("invalid_worktree_context", `${requested} does not exist.`);
  }
  const rootResult = runSync("git", ["rev-parse", "--show-toplevel"], { cwd, check: false });
  if (rootResult.status !== 0) {
    throw new PluginError("git_worktree_required", `No Git worktree contains ${cwd}.`);
  }
  const root = fs.realpathSync.native(path.resolve(rootResult.stdout.trim()));
  const relativeCwd = path.relative(root, cwd) || ".";
  if (relativeCwd === ".." || relativeCwd.startsWith(`..${path.sep}`)) {
    throw new PluginError("invalid_worktree_context", `${cwd} is outside ${root}.`);
  }
  const branchResult = runSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, check: false });
  const branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
  const env = options.env ?? process.env;
  return {
    root,
    cwd,
    relativeCwd: relativeCwd.split(path.sep).join("/"),
    branch: branch === "HEAD" ? null : branch,
    sourcePaneId: context.focused_pane_id ?? env.HERDR_PANE_ID ?? null,
  };
}
