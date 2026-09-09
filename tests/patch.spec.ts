import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { UPLOAD_DIR } from "../src/constants.js";
import {
  applyPreparedPatch,
  exportRemotePatch,
  inspectPatch,
  preparePatch,
  scanPatchContent,
  type ExportedPatch,
  type ExportOptions,
} from "../src/patch.js";
import { runSync } from "../src/process.js";
import {
  COMMIT_A,
  fakeBox,
  makeGitRepository,
  MAPPING_ID,
  remove,
  temporaryDirectory,
  write,
} from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

const NEXT = "d".repeat(40);
const sha256 = (buffer: Buffer): string => crypto.createHash("sha256").update(buffer).digest("hex");

function repoWithPatch(): { root: string; patch: Buffer } {
  const root = makeGitRepository();
  directories.push(root);
  write(root, "file.txt", "before\n");
  runSync("git", ["add", "file.txt"], { cwd: root });
  runSync("git", ["commit", "-qm", "baseline"], { cwd: root });
  write(root, "file.txt", "after\n");
  const patch = Buffer.from(runSync("git", ["diff", "--binary", "HEAD"], { cwd: root }).stdout);
  runSync("git", ["restore", "file.txt"], { cwd: root });
  return { root, patch };
}

function unsafePatch(): Buffer {
  const source = makeGitRepository();
  directories.push(source);
  fs.symlinkSync("README.md", `${source}/link`);
  write(source, ".env", "SECRET=1\n");
  write(source, "node_modules/x.js", "x\n");
  write(source, "src/ok.txt", "ok\n");
  runSync("git", ["add", "-A", "-f"], { cwd: source });
  return Buffer.from(runSync("git", ["diff", "--cached", "--binary"], { cwd: source }).stdout);
}

function mappingFor(root: string) {
  return {
    id: MAPPING_ID,
    localRoot: root,
    remoteRoot: "/workspace/home/worktree",
    lastAppliedExportCommit: COMMIT_A,
  };
}

function exportInto(patch: Buffer) {
  return async (
    _box: unknown,
    _mapping: unknown,
    options: ExportOptions,
  ): Promise<ExportedPatch> => {
    const localPatch = path.join(options.directory, "changes.patch");
    fs.writeFileSync(localPatch, patch);
    return { nextCommit: NEXT, bytes: patch.length, localPatch, sha256: sha256(patch) };
  };
}

function tempDir(): string {
  const directory = temporaryDirectory();
  directories.push(directory);
  return directory;
}

describe("exportRemotePatch", () => {
  const patch = Buffer.from("diff --git a/x b/x\n");

  it("snapshots the box, downloads to the given directory, verifies the checksum, and cleans up", async () => {
    const { box, calls } = fakeBox({
      commandOutput: () => ({ stdout: `${NEXT} ${sha256(patch)}` }),
      remoteFile: (target) => (target.endsWith(".patch") ? patch : undefined),
    });
    const directory = tempDir();
    const exported = await exportRemotePatch(box, mappingFor("/local"), {
      directory,
      maxBytes: 1024,
    });
    expect(exported.nextCommit).toBe(NEXT);
    expect(exported.bytes).toBe(patch.length);
    expect(fs.readFileSync(exported.localPatch).equals(patch)).toBe(true);
    expect(exported.localPatch.startsWith(directory)).toBe(true);
    expect(calls.commands[0]).toContain(`git diff --binary '${COMMIT_A}' "$next"`);
    expect(calls.commands[0]).toContain("sha256sum");
    expect(calls.removed[0]).toMatch(
      new RegExp(`^${UPLOAD_DIR}/${MAPPING_ID}-[0-9a-f-]{36}\\.patch$`),
    );
  });

  it("uses a fresh remote path for every export", async () => {
    const { box, calls } = fakeBox({
      commandOutput: () => ({ stdout: `${NEXT} ${sha256(patch)}` }),
      remoteFile: () => patch,
    });
    await exportRemotePatch(box, mappingFor("/local"), { directory: tempDir(), maxBytes: 1024 });
    await exportRemotePatch(box, mappingFor("/local"), { directory: tempDir(), maxBytes: 1024 });
    expect(calls.removed).toHaveLength(2);
    expect(calls.removed[0]).not.toBe(calls.removed[1]);
  });

  it("refuses a patch whose bytes do not match the checksum from the box", async () => {
    const { box, calls } = fakeBox({
      commandOutput: () => ({ stdout: `${NEXT} ${sha256(Buffer.from("other"))}` }),
      remoteFile: () => patch,
    });
    await expect(
      exportRemotePatch(box, mappingFor("/local"), { directory: tempDir(), maxBytes: 1024 }),
    ).rejects.toMatchObject({ code: "patch_integrity" });
    expect(calls.removed).toHaveLength(1);
  });

  it("refuses an oversized patch before downloading it", async () => {
    const { box, calls } = fakeBox({
      commandOutput: () => ({ stdout: `${NEXT} ${sha256(patch)}` }),
      remoteFile: () => patch,
    });
    await expect(
      exportRemotePatch(box, mappingFor("/local"), { directory: tempDir(), maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "remote_file_too_large" });
    expect(calls.reads).toBe(0);
    expect(calls.removed).toHaveLength(1);
  });

  it("refuses a mapping without a baseline and a failed export", async () => {
    const { box } = fakeBox({ commandOutput: () => ({ stdout: "", stderr: "boom", exitCode: 1 }) });
    await expect(
      exportRemotePatch(
        box,
        { ...mappingFor("/local"), lastAppliedExportCommit: null },
        { directory: tempDir(), maxBytes: 1024 },
      ),
    ).rejects.toThrow(/no remote export baseline/);
    await expect(
      exportRemotePatch(box, mappingFor("/local"), { directory: tempDir(), maxBytes: 1024 }),
    ).rejects.toThrow(/boom/);
  });
});

describe("inspectPatch", () => {
  it("rejects symlinks, env files, and blocked directories, and honours exact overrides", () => {
    const root = makeGitRepository();
    directories.push(root);
    const localPatch = path.join(tempDir(), "unsafe.patch");
    fs.writeFileSync(localPatch, unsafePatch());
    const inspection = inspectPatch(localPatch, { localRoot: root }, DEFAULT_CONFIG);
    expect(inspection.paths).toEqual(
      expect.arrayContaining([".env", "link", "node_modules/x.js", "src/ok.txt"]),
    );
    expect(inspection.problems).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "environment-file" },
        { path: "node_modules/x.js", reason: "blocked-directory" },
        { path: "link", reason: "symlink" },
      ]),
    );
    const allowed = inspectPatch(
      localPatch,
      { localRoot: root },
      { ...DEFAULT_CONFIG, allowSensitivePaths: [".env"] },
    );
    expect(allowed.problems.map((problem) => problem.path)).not.toContain(".env");
    expect(allowed.problems.map((problem) => problem.reason)).toContain("symlink");
  });

  it("passes an ordinary patch", () => {
    const { root, patch } = repoWithPatch();
    const localPatch = path.join(tempDir(), "ok.patch");
    fs.writeFileSync(localPatch, patch);
    expect(inspectPatch(localPatch, { localRoot: root }, DEFAULT_CONFIG)).toEqual({
      paths: ["file.txt"],
      problems: [],
    });
  });
});

describe("preparePatch and applyPreparedPatch", () => {
  it("checks, applies, and then recognises an already applied patch", async () => {
    const { root, patch } = repoWithPatch();
    const { box } = fakeBox();
    const exportPatch = exportInto(patch);
    const prepared = await preparePatch(box, mappingFor(root), { exportPatch });
    expect(prepared.status).toBe("ready");
    expect(prepared.summary).toContain("file.txt");
    const applied = applyPreparedPatch(prepared, mappingFor(root));
    prepared.cleanup();
    expect(applied.status).toBe("applied");
    expect(fs.readFileSync(`${root}/file.txt`, "utf8")).toBe("after\n");
    const again = await preparePatch(box, mappingFor(root), { exportPatch });
    again.cleanup();
    expect(again.status).toBe("already_applied");
    expect(again.nextCommit).toBe(NEXT);
  });

  it("reports no change for an empty patch", async () => {
    const { root } = repoWithPatch();
    const prepared = await preparePatch(fakeBox().box, mappingFor(root), {
      exportPatch: exportInto(Buffer.alloc(0)),
    });
    expect(prepared.status).toBe("no_change");
    expect(prepared.bytes).toBe(0);
  });

  it("refuses a conflicting local tree", async () => {
    const { root, patch } = repoWithPatch();
    write(root, "file.txt", "local conflict\n");
    await expect(
      preparePatch(fakeBox().box, mappingFor(root), { exportPatch: exportInto(patch) }),
    ).rejects.toMatchObject({ code: "patch_conflict" });
  });

  it("refuses a patch that would create a symlink or an env file, before any check", async () => {
    const root = makeGitRepository();
    directories.push(root);
    await expect(
      preparePatch(fakeBox().box, mappingFor(root), { exportPatch: exportInto(unsafePatch()) }),
    ).rejects.toMatchObject({ code: "patch_unsafe" });
    expect(fs.existsSync(`${root}/.env`)).toBe(false);
    expect(fs.existsSync(`${root}/link`)).toBe(false);
  });

  it("passes the size limit through to the export", async () => {
    const { root } = repoWithPatch();
    const seen: number[] = [];
    await preparePatch(fakeBox().box, mappingFor(root), {
      maxPatchBytes: 123,
      exportPatch: async (box, mapping, options) => {
        seen.push(options.maxBytes);
        return exportInto(Buffer.alloc(0))(box, mapping, options);
      },
    });
    expect(seen).toEqual([123]);
  });
});

describe("content scan", () => {
  it("flags added lines that look like a credential and refuses the patch", async () => {
    const { root } = repoWithPatch();
    write(root, "config.js", "const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz123456';\n");
    write(root, "clean.js", "export const ok = 1;\n");
    runSync("git", ["add", "-A"], { cwd: root });
    const patch = Buffer.from(
      runSync("git", ["diff", "--cached", "--binary"], { cwd: root }).stdout,
    );
    runSync("git", ["reset", "-q"], { cwd: root });
    fs.unlinkSync(`${root}/config.js`);
    fs.unlinkSync(`${root}/clean.js`);
    const localPatch = path.join(tempDir(), "leak.patch");
    fs.writeFileSync(localPatch, patch);
    expect(scanPatchContent(localPatch)).toEqual(["config.js"]);
    await expect(
      preparePatch(fakeBox().box, mappingFor(root), { exportPatch: exportInto(patch) }),
    ).rejects.toThrow(/looks like a credential in: config\.js/);
    expect(fs.existsSync(`${root}/clean.js`)).toBe(false);
  });
});
