import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UploadManifest } from "./manifest.js";
import { runSync, type RunOptions, type RunResult } from "./process.js";
import { PluginError } from "./result.js";

export interface Archive {
  path: string;
  bytes: number;
  cleanup(): void;
}

export type RunCommand = (command: string, args: string[], options?: RunOptions) => RunResult;

function changed(relativePath: string): PluginError {
  return new PluginError(
    "upload_manifest_changed",
    `${relativePath} changed after the upload preview. Run Start again.`,
  );
}

// Only bytes that still match the reviewed manifest reach the staging tree; the archive is built from that tree.
export function stageManifest(manifest: UploadManifest, staging: string): void {
  for (const file of manifest.files) {
    const target = path.join(staging, ...file.path.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let fd: number;
    try {
      fd = fs.openSync(file.absolutePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch {
      throw changed(file.path);
    }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size !== file.size) throw changed(file.path);
      const buffer = fs.readFileSync(fd);
      if (
        buffer.length !== file.size ||
        crypto.createHash("sha256").update(buffer).digest("hex") !== file.sha256
      ) {
        throw changed(file.path);
      }
      fs.writeFileSync(target, buffer, { mode: file.executable ? 0o755 : 0o644 });
    } finally {
      fs.closeSync(fd);
    }
  }
}

export function createArchive(
  manifest: UploadManifest,
  options: { runCommand?: RunCommand } = {},
): Archive {
  const runCommand = options.runCommand ?? runSync;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-box-upload-"));
  const cleanup = (): void => {
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    const staging = path.join(directory, "tree");
    fs.mkdirSync(staging, { mode: 0o700 });
    stageManifest(manifest, staging);
    const list = path.join(directory, "files.list");
    fs.writeFileSync(list, manifest.files.map((file) => `${file.path}\0`).join(""), {
      mode: 0o600,
    });
    const archive = path.join(directory, "upload.tar");
    runCommand("tar", ["-cf", archive, "-C", staging, "--null", "-T", list], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = fs.statSync(archive).size;
    if (manifest.files.length > 0 && bytes === 0) {
      throw new PluginError("archive_empty", "tar produced an empty archive.");
    }
    return { path: archive, bytes, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
