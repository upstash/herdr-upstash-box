import fs from "node:fs";
import path from "node:path";
import type { Box } from "@upstash/box";
import { createArchive, type Archive } from "./archive.js";
import { UPLOAD_DIR } from "./constants.js";
import type { UploadManifest } from "./manifest.js";
import { PluginError } from "./result.js";
import { shellQuote } from "./session.js";
import type { Mapping } from "./state.js";

export function remoteArchivePath(mappingId: string): string {
  return `${UPLOAD_DIR}/${mappingId.replace(/[^A-Za-z0-9-]/g, "")}.tar`;
}

async function checked(box: Box, command: string, code: string, label: string): Promise<string> {
  const run = await box.exec.command(command);
  if (run.exitCode !== 0) {
    throw new PluginError(code, `${label}: ${String(run.stderr || run.stdout || "").trim()}`);
  }
  return String(run.stdout ?? "");
}

// Unpack beside the root and swap it in; a failed extraction or swap leaves the previous tree in place.
export function extractionCommand(remote: string, root: string): string {
  const q = shellQuote;
  const staging = `${root}.herdr-new`;
  const old = `${root}.herdr-old`;
  return [
    `rm -rf ${q(staging)} ${q(old)}`,
    `mkdir -p ${q(staging)} ${q(path.posix.dirname(root))}`,
    `tar -xf ${q(remote)} -C ${q(staging)}`,
    `if [ -e ${q(root)} ]; then mv ${q(root)} ${q(old)}; fi`,
    `{ mv ${q(staging)} ${q(root)} || { mv ${q(old)} ${q(root)} 2>/dev/null; false; }; }`,
    `rm -rf ${q(old)} ${q(remote)}`,
  ].join(" && ");
}

export interface UploadDeps {
  createArchive?: (manifest: UploadManifest) => Archive;
}

export async function uploadWorktree(
  box: Box,
  mapping: Pick<Mapping, "id" | "remoteRoot">,
  manifest: UploadManifest,
  deps: UploadDeps = {},
): Promise<{ files: number; bytes: number }> {
  await box.files.mkdir(mapping.remoteRoot, { parents: true });
  if (manifest.files.length === 0) return { files: 0, bytes: 0 };
  const archive = (deps.createArchive ?? createArchive)(manifest);
  try {
    const remote = remoteArchivePath(mapping.id);
    await box.files.mkdir(UPLOAD_DIR, { parents: true });
    await box.files.upload([{ path: archive.path, destination: remote }]);
    await checked(
      box,
      extractionCommand(remote, mapping.remoteRoot),
      "upload_extract_failed",
      "Could not unpack the upload in the box",
    );
    return { files: manifest.files.length, bytes: archive.bytes };
  } finally {
    archive.cleanup();
  }
}

export async function initializeRemoteBaseline(
  box: Box,
  mapping: Pick<Mapping, "remoteRoot">,
): Promise<string> {
  const root = shellQuote(mapping.remoteRoot);
  const output = await checked(
    box,
    [
      "set -e",
      `cd ${root}`,
      "git init -q",
      "git config user.name 'Herdr Upstash Box plugin'",
      "git config user.email 'herdr-box@localhost'",
      "git add -f -A",
      "git commit -q --allow-empty -m 'Herdr local upload baseline'",
      "git rev-parse HEAD",
    ].join(" && "),
    "remote_git_init_failed",
    "Could not create the remote Git baseline",
  );
  const commit = output.trim().split(/\s+/).at(-1) ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new PluginError("remote_git_init_failed", "The remote Git baseline returned no commit.");
  }
  return commit;
}

const CHUNK = 4 * 1024 * 1024;

function tooLarge(remotePath: string, size: number, maxBytes: number): PluginError {
  return new PluginError(
    "remote_file_too_large",
    `${remotePath} is ${size} bytes; the limit is ${maxBytes}. Raise maxPatchBytes if this is expected.`,
  );
}

// Size is checked before the first byte moves, and again as chunks land, so memory stays bounded.
export async function downloadRemoteFile(
  box: Box,
  remotePath: string,
  localPath: string,
  options: { maxBytes: number },
): Promise<number> {
  const stat = await box.files.stat(remotePath);
  if (stat.type !== "file") {
    throw new PluginError("remote_file_missing", `${remotePath} is not a file in the box.`);
  }
  if (stat.size > options.maxBytes) throw tooLarge(remotePath, stat.size, options.maxBytes);
  const fd = fs.openSync(localPath, "w", 0o600);
  let written = 0;
  try {
    for (let offset = 0; offset < stat.size; offset += CHUNK) {
      const content = await box.files.read(remotePath, {
        encoding: "base64",
        offset,
        length: Math.min(CHUNK, stat.size - offset),
      });
      const chunk = Buffer.from(content, "base64");
      written += chunk.length;
      if (written > options.maxBytes) throw tooLarge(remotePath, written, options.maxBytes);
      fs.writeSync(fd, chunk);
    }
  } finally {
    fs.closeSync(fd);
  }
  return written;
}
