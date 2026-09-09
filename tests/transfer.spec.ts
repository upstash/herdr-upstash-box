import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createArchive } from "../src/archive.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { UPLOAD_DIR } from "../src/constants.js";
import { buildUploadManifest } from "../src/manifest.js";
import { runSync } from "../src/process.js";
import {
  downloadRemoteFile,
  extractionCommand,
  initializeRemoteBaseline,
  remoteArchivePath,
  uploadWorktree,
} from "../src/transfer.js";
import {
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

function repo(): string {
  const root = makeGitRepository();
  directories.push(root);
  return root;
}

describe("createArchive", () => {
  it("packs exactly the manifest files from a staging tree, keeping modes and odd names", () => {
    const root = repo();
    write(root, "bin/run.sh", "#!/bin/sh\n", 0o755);
    write(root, "docs/with space.md", "x\n");
    write(root, ".env", "SECRET=1\n");
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    const archive = createArchive(manifest);
    try {
      const listed = runSync("tar", ["-tf", archive.path]).stdout.trim().split("\n").sort();
      expect(listed).toEqual(["README.md", "bin/run.sh", "docs/with space.md"]);
      const out = temporaryDirectory();
      directories.push(out);
      runSync("tar", ["-xf", archive.path, "-C", out]);
      expect(fs.statSync(path.join(out, "bin/run.sh")).mode & 0o111).not.toBe(0);
      expect(fs.readFileSync(path.join(out, "docs/with space.md"), "utf8")).toBe("x\n");
      expect(archive.bytes).toBeGreaterThan(0);
    } finally {
      archive.cleanup();
    }
    expect(fs.existsSync(archive.path)).toBe(false);
  });

  it("refuses a file that changed after the preview", () => {
    const root = repo();
    write(root, "src/app.js", "safe\n");
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    write(root, "src/app.js", "sk-proj-abcdefghijklmnopqrstuvwxyz123456\n");
    expect(() => createArchive(manifest)).toThrow(/src\/app\.js changed after the upload preview/);
    write(root, "src/app.js", "SAFE\n");
    expect(() => createArchive(manifest)).toThrow(/changed after the upload preview/);
  });

  it("refuses a file swapped for a symlink or removed after the preview", () => {
    const root = repo();
    write(root, "src/app.js", "safe\n");
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    fs.unlinkSync(`${root}/src/app.js`);
    fs.symlinkSync("../README.md", `${root}/src/app.js`);
    expect(() => createArchive(manifest)).toThrow(/src\/app\.js changed/);
    fs.unlinkSync(`${root}/src/app.js`);
    expect(() => createArchive(manifest)).toThrow(/src\/app\.js changed/);
  });

  it.skipIf(process.platform !== "darwin")(
    "never emits AppleDouble entries for files with xattrs",
    () => {
      const root = repo();
      write(root, "tagged.txt", "x\n");
      runSync("xattr", ["-w", "test.attr", "value", path.join(root, "tagged.txt")]);
      const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
      const archive = createArchive(manifest);
      try {
        const listed = runSync("tar", ["-tf", archive.path]).stdout.trim().split("\n");
        expect(listed.some((entry) => entry.includes("._"))).toBe(false);
        expect(listed).toContain("tagged.txt");
      } finally {
        archive.cleanup();
      }
    },
  );
});

describe("extractionCommand", () => {
  it("unpacks beside the root and swaps it in only after tar succeeds", () => {
    const command = extractionCommand("/tmp/herdr-box/x.tar", "/workspace/home/worktree");
    const steps = command.split(" && ");
    expect(steps[0]).toContain("rm -rf '/workspace/home/worktree.herdr-new'");
    expect(
      steps.some((step) =>
        step.startsWith("tar -xf '/tmp/herdr-box/x.tar' -C '/workspace/home/worktree.herdr-new'"),
      ),
    ).toBe(true);
    const tarAt = steps.findIndex((step) => step.startsWith("tar -xf"));
    const swapAt = steps.findIndex((step) =>
      step.startsWith("{ mv '/workspace/home/worktree.herdr-new' '/workspace/home/worktree'"),
    );
    expect(swapAt).toBeGreaterThan(tarAt);
    expect(steps.at(-1)).toContain(
      "rm -rf '/workspace/home/worktree.herdr-old' '/tmp/herdr-box/x.tar'",
    );
  });
});

describe("uploadWorktree", () => {
  const mapping = { id: MAPPING_ID, remoteRoot: "/workspace/home/worktree" };

  it("uploads one archive and runs the transactional extraction", async () => {
    const root = repo();
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    const { box, calls } = fakeBox();
    const result = await uploadWorktree(box, mapping, manifest);
    expect(result.files).toBe(1);
    expect(calls.mkdirs).toEqual(["/workspace/home/worktree", UPLOAD_DIR]);
    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0]?.destination).toBe(remoteArchivePath(MAPPING_ID));
    expect(calls.commands[0]).toBe(
      extractionCommand(remoteArchivePath(MAPPING_ID), mapping.remoteRoot),
    );
  });

  it("only creates the remote root when there is nothing to upload", async () => {
    const { box, calls } = fakeBox();
    const empty = {
      schemaVersion: 1 as const,
      root: "/r",
      files: [],
      excluded: [],
      totalBytes: 0,
      digest: "",
    };
    expect(await uploadWorktree(box, mapping, empty)).toEqual({ files: 0, bytes: 0 });
    expect(calls.uploads).toEqual([]);
    expect(calls.mkdirs).toEqual(["/workspace/home/worktree"]);
  });

  it("surfaces an extraction failure", async () => {
    const root = repo();
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    const { box } = fakeBox({
      commandOutput: () => ({ stdout: "", stderr: "tar: broken", exitCode: 2 }),
    });
    await expect(uploadWorktree(box, mapping, manifest)).rejects.toThrow(/tar: broken/);
  });
});

describe("initializeRemoteBaseline", () => {
  it("returns the baseline commit", async () => {
    const { box, calls } = fakeBox({ commandOutput: () => ({ stdout: `${"c".repeat(40)}\n` }) });
    expect(await initializeRemoteBaseline(box, { remoteRoot: "/workspace/home" })).toBe(
      "c".repeat(40),
    );
    expect(calls.commands[0]).toContain("git init -q");
    expect(calls.commands[0]).toContain("git add -f -A");
  });

  it("rejects output that is not a commit", async () => {
    const { box } = fakeBox({ commandOutput: () => ({ stdout: "fatal\n", exitCode: 128 }) });
    await expect(initializeRemoteBaseline(box, { remoteRoot: "/workspace/home" })).rejects.toThrow(
      /Could not create the remote Git baseline/,
    );
  });
});

describe("downloadRemoteFile", () => {
  it("streams a large file to disk in bounded chunks", async () => {
    const content = crypto.randomBytes(9_000_000);
    const { box, calls } = fakeBox({ remoteFiles: { "/tmp/herdr-box/x.patch": content } });
    const directory = temporaryDirectory();
    directories.push(directory);
    const local = path.join(directory, "x.patch");
    const written = await downloadRemoteFile(box, "/tmp/herdr-box/x.patch", local, {
      maxBytes: 10_000_000,
    });
    expect(written).toBe(content.length);
    expect(fs.readFileSync(local).equals(content)).toBe(true);
    expect(calls.reads).toBe(3);
    expect(fs.statSync(local).mode & 0o077).toBe(0);
  });

  it("refuses an oversized file before reading a single byte", async () => {
    const { box, calls } = fakeBox({
      remoteFiles: { "/tmp/herdr-box/big.patch": Buffer.alloc(200) },
    });
    const directory = temporaryDirectory();
    directories.push(directory);
    await expect(
      downloadRemoteFile(box, "/tmp/herdr-box/big.patch", path.join(directory, "big"), {
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ code: "remote_file_too_large" });
    expect(calls.reads).toBe(0);
  });
});

describe("extraction rollback", () => {
  it("puts the previous tree back if the swap fails", () => {
    const command = extractionCommand("/tmp/herdr-box/x.tar", "/workspace/home/worktree");
    expect(command).toContain(
      "{ mv '/workspace/home/worktree.herdr-new' '/workspace/home/worktree' || { mv '/workspace/home/worktree.herdr-old' '/workspace/home/worktree' 2>/dev/null; false; }; }",
    );
  });
});
