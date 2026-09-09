import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Box } from "@upstash/box";
import type { RunCommand } from "./archive.js";
import { DEFAULT_CONFIG } from "./config.js";
import { UPLOAD_DIR } from "./constants.js";
import {
  detectSecret,
  normalizeRelative,
  pathExclusionReason,
  type ManifestConfig,
} from "./manifest.js";
import { runSync } from "./process.js";
import { PluginError } from "./result.js";
import { shellQuote } from "./session.js";
import type { Mapping } from "./state.js";
import { downloadRemoteFile } from "./transfer.js";

export type PatchMapping = Pick<
  Mapping,
  "id" | "localRoot" | "remoteRoot" | "lastAppliedExportCommit"
>;

export interface ExportOptions {
  directory: string;
  maxBytes: number;
}

export interface ExportedPatch {
  nextCommit: string;
  bytes: number;
  localPatch: string;
  sha256: string;
}

function fileDigest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Snapshot the box tree as a commit, diff it against the last applied commit, and bind the bytes to that commit by checksum.
export async function exportRemotePatch(
  box: Box,
  mapping: PatchMapping,
  options: ExportOptions,
): Promise<ExportedPatch> {
  if (!mapping.lastAppliedExportCommit) {
    throw new PluginError("missing_export_baseline", "The mapping has no remote export baseline.");
  }
  const safeId = mapping.id.replace(/[^A-Za-z0-9-]/g, "");
  const patchPath = `${UPLOAD_DIR}/${safeId}-${crypto.randomUUID()}.patch`;
  try {
    const run = await box.exec.command(
      [
        `mkdir -p ${shellQuote(UPLOAD_DIR)}`,
        `cd ${shellQuote(mapping.remoteRoot)}`,
        "git add -A",
        `git commit -q --allow-empty -m ${shellQuote(`Herdr export ${new Date().toISOString()}`)}`,
        "next=$(git rev-parse HEAD)",
        `git diff --binary ${shellQuote(mapping.lastAppliedExportCommit)} "$next" > ${shellQuote(patchPath)}`,
        `sum=$(sha256sum ${shellQuote(patchPath)} | cut -d " " -f 1)`,
        'printf "%s %s" "$next" "$sum"',
      ].join(" && "),
    );
    if (run.exitCode !== 0) {
      throw new PluginError(
        "remote_export_failed",
        `Remote patch export failed: ${String(run.stderr || run.stdout || "").trim()}`,
      );
    }
    const fields = String(run.stdout ?? "")
      .trim()
      .split(/\s+/);
    const nextCommit = fields.at(-2) ?? "";
    const remoteSha = fields.at(-1) ?? "";
    if (!/^[0-9a-f]{40}$/.test(nextCommit) || !/^[0-9a-f]{64}$/.test(remoteSha)) {
      throw new PluginError("remote_export_failed", "Remote patch export returned no commit.");
    }
    const localPatch = path.join(options.directory, "changes.patch");
    const bytes = await downloadRemoteFile(box, patchPath, localPatch, {
      maxBytes: options.maxBytes,
    });
    const sha256 = fileDigest(localPatch);
    if (sha256 !== remoteSha) {
      throw new PluginError(
        "patch_integrity",
        "The downloaded patch does not match the checksum computed in the box. Try again.",
      );
    }
    return { nextCommit, bytes, localPatch, sha256 };
  } finally {
    await box.files.remove(patchPath).catch(() => undefined);
  }
}

export interface PatchProblem {
  path: string;
  reason: string;
}

export interface PatchInspection {
  paths: string[];
  problems: PatchProblem[];
}

function headerPath(block: string): string | null {
  const plus = /^\+\+\+ (?:"b\/(.+)"|b\/(.+))$/m.exec(block);
  if (plus) return plus[1] ?? plus[2] ?? null;
  const header = /^diff --git (?:"a\/.+?"|a\/\S+) (?:"b\/(.+)"|b\/(\S+))$/m.exec(block);
  return header?.[1] ?? header?.[2] ?? null;
}

// Incoming patches obey the same rules as outgoing uploads: no symlinks, no credential or env paths.
export function inspectPatch(
  localPatch: string,
  mapping: Pick<PatchMapping, "localRoot">,
  config: ManifestConfig,
  runCommand: RunCommand = runSync,
): PatchInspection {
  const numstat = runCommand("git", ["apply", "--numstat", "-z", "--binary", localPatch], {
    cwd: mapping.localRoot,
    check: false,
  });
  if (numstat.status !== 0) {
    throw new PluginError(
      "patch_unreadable",
      `git could not read the patch: ${numstat.stderr.trim() || "unknown error"}`,
    );
  }
  const paths: string[] = [];
  const parts = numstat.stdout.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index];
    if (!entry) continue;
    const fields = entry.split("\t");
    if (fields.length < 3) continue;
    if (fields[2] !== "") {
      paths.push(fields[2] ?? "");
    } else {
      index += 2;
      const renamed = parts[index];
      if (renamed) paths.push(renamed);
    }
  }
  const problems: PatchProblem[] = [];
  for (const target of paths) {
    try {
      const reason = pathExclusionReason(normalizeRelative(target), config);
      if (reason) problems.push({ path: target, reason });
    } catch {
      problems.push({ path: target, reason: "unsafe-path" });
    }
  }
  const text = fs.readFileSync(localPatch, "latin1");
  for (const block of text.split(/^(?=diff --git )/m)) {
    if (/^(?:new file mode|new mode) 120000$/m.test(block)) {
      problems.push({ path: headerPath(block) ?? "<unknown>", reason: "symlink" });
    }
  }
  return { paths, problems };
}

// Added lines are what the apply would write, so they get the same secret scan as an upload.
export function scanPatchContent(localPatch: string): string[] {
  const flagged = new Set<string>();
  let current = "<unknown>";
  for (const line of fs.readFileSync(localPatch, "latin1").split("\n")) {
    const target = /^\+\+\+ (?:"b\/(.+)"|b\/(.+))$/.exec(line);
    if (target) {
      current = target[1] ?? target[2] ?? "<unknown>";
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++") && detectSecret(line.slice(1))) {
      flagged.add(current);
    }
  }
  return [...flagged];
}

export type PatchStatus = "no_change" | "already_applied" | "ready" | "applied";

export interface PreparedPatch {
  status: PatchStatus;
  nextCommit: string;
  bytes: number;
  summary: string;
  localPatch?: string;
  cleanup(): void;
}

function checkPatch(localPatch: string, mapping: PatchMapping, runCommand: RunCommand) {
  return runCommand("git", ["apply", "--check", "--binary", localPatch], {
    cwd: mapping.localRoot,
    check: false,
  });
}

function reverseCheckPatch(localPatch: string, mapping: PatchMapping, runCommand: RunCommand) {
  return runCommand("git", ["apply", "--reverse", "--check", "--binary", localPatch], {
    cwd: mapping.localRoot,
    check: false,
  });
}

function conflictError(stderr: string): PluginError {
  return new PluginError(
    "patch_conflict",
    `git apply --check failed: ${stderr.trim() || "unknown conflict"}`,
  );
}

export interface PatchDeps {
  runCommand?: RunCommand;
  exportPatch?: (box: Box, mapping: PatchMapping, options: ExportOptions) => Promise<ExportedPatch>;
  config?: ManifestConfig;
  maxPatchBytes?: number;
}

export async function preparePatch(
  box: Box,
  mapping: PatchMapping,
  deps: PatchDeps = {},
): Promise<PreparedPatch> {
  const runCommand = deps.runCommand ?? runSync;
  const config = deps.config ?? DEFAULT_CONFIG;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-box-patch-"));
  const cleanup = (): void => {
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const exported = await (deps.exportPatch ?? exportRemotePatch)(box, mapping, {
      directory,
      maxBytes: deps.maxPatchBytes ?? DEFAULT_CONFIG.maxPatchBytes,
    });
    if (exported.bytes === 0) {
      return {
        status: "no_change",
        nextCommit: exported.nextCommit,
        bytes: 0,
        summary: "No changes in the box since the last apply.",
        cleanup,
      };
    }
    const inspection = inspectPatch(exported.localPatch, mapping, config, runCommand);
    if (inspection.problems.length > 0) {
      throw new PluginError(
        "patch_unsafe",
        `The patch touches paths the upload filter would refuse: ${inspection.problems
          .map((problem) => `${problem.path} [${problem.reason}]`)
          .join(
            ", ",
          )}. Add exact files to allowSensitivePaths to accept them; symlinks are never applied.`,
      );
    }
    const leaked = scanPatchContent(exported.localPatch);
    if (leaked.length > 0) {
      throw new PluginError(
        "patch_unsafe",
        `The patch adds content that looks like a credential in: ${leaked.join(", ")}. Remove it in the box, then apply again.`,
      );
    }
    const check = checkPatch(exported.localPatch, mapping, runCommand);
    if (check.status !== 0) {
      if (reverseCheckPatch(exported.localPatch, mapping, runCommand).status === 0) {
        return {
          status: "already_applied",
          nextCommit: exported.nextCommit,
          bytes: exported.bytes,
          summary: "These changes are already present locally.",
          cleanup,
        };
      }
      throw conflictError(check.stderr);
    }
    const stat = runCommand(
      "git",
      ["apply", "--stat", "--summary", "--binary", exported.localPatch],
      { cwd: mapping.localRoot, check: false },
    );
    return {
      status: "ready",
      nextCommit: exported.nextCommit,
      bytes: exported.bytes,
      summary: `${stat.stdout}${stat.stderr}`.trim() || `${exported.bytes} byte binary Git patch`,
      localPatch: exported.localPatch,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function applyPreparedPatch(
  prepared: PreparedPatch,
  mapping: PatchMapping,
  deps: PatchDeps = {},
): PreparedPatch {
  if (prepared.status !== "ready" || !prepared.localPatch) return prepared;
  const runCommand = deps.runCommand ?? runSync;
  const check = checkPatch(prepared.localPatch, mapping, runCommand);
  if (check.status !== 0) {
    if (reverseCheckPatch(prepared.localPatch, mapping, runCommand).status === 0) {
      return { ...prepared, status: "already_applied" };
    }
    throw conflictError(check.stderr);
  }
  runCommand("git", ["apply", "--binary", prepared.localPatch], { cwd: mapping.localRoot });
  return { ...prepared, status: "applied" };
}
