import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginError } from "../src/result.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  buildUploadManifest,
  formatBytes,
  formatManifestSummary,
  pathExclusionReason,
  assertUploadFits,
} from "../src/manifest.js";
import { runSync } from "../src/process.js";
import { makeGitRepository, remove, write } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

function repo(): string {
  const root = makeGitRepository();
  directories.push(root);
  return root;
}

describe("pathExclusionReason", () => {
  it("blocks credentials and accepts exact overrides", () => {
    expect(pathExclusionReason(".env", DEFAULT_CONFIG)).toBe("environment-file");
    expect(pathExclusionReason(".env.example", DEFAULT_CONFIG)).toBeNull();
    expect(pathExclusionReason("nested/id_rsa", DEFAULT_CONFIG)).toBe("credential-file");
    expect(pathExclusionReason("certs/server.pem", DEFAULT_CONFIG)).toBe("credential-extension");
    expect(pathExclusionReason(".config/gcloud/x.json", DEFAULT_CONFIG)).toBe(
      "credential-directory",
    );
    expect(pathExclusionReason("src/index.ts", DEFAULT_CONFIG)).toBeNull();
    expect(
      pathExclusionReason(".env", { ...DEFAULT_CONFIG, allowSensitivePaths: [".env"] }),
    ).toBeNull();
    expect(
      pathExclusionReason("node_modules/tool/token.json", {
        ...DEFAULT_CONFIG,
        allowSensitivePaths: ["node_modules/tool/token.json"],
      }),
    ).toBe("blocked-directory");
    expect(
      pathExclusionReason("fixtures/big.bin", { ...DEFAULT_CONFIG, excludedPaths: ["fixtures/"] }),
    ).toBe("configured-exclusion");
  });

  it("refuses paths that escape the worktree", () => {
    expect(() => pathExclusionReason("../x", DEFAULT_CONFIG)).toThrow(/Unsafe worktree path/);
    expect(() => pathExclusionReason("/etc/passwd", DEFAULT_CONFIG)).toThrow(
      /Unsafe worktree path/,
    );
  });
});

describe("buildUploadManifest", () => {
  it("includes safe tracked and untracked files and excludes secrets", () => {
    const root = repo();
    write(root, "src/index.mjs", "console.log('safe')\n", 0o755);
    write(root, ".env", "TOKEN=secret\n");
    write(root, "private.txt", "-----BEGIN PRIVATE KEY-----\nsecret\n");
    write(root, ".env.example", "TOKEN=replace-me\n");
    write(root, "untracked.txt", "included\n");
    write(root, "ignored.log", "nope\n");
    write(root, ".gitignore", "*.log\n");
    runSync("git", ["add", "src/index.mjs", ".env.example", "private.txt", ".gitignore"], {
      cwd: root,
    });
    runSync("git", ["add", "-f", ".env"], { cwd: root });
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    expect(manifest.files.map((file) => file.path)).toEqual([
      ".env.example",
      ".gitignore",
      "README.md",
      "src/index.mjs",
      "untracked.txt",
    ]);
    expect(manifest.files.find((file) => file.path === "src/index.mjs")?.executable).toBe(true);
    expect(manifest.excluded.map((file) => [file.path, file.reason])).toEqual([
      [".env", "environment-file"],
      ["private.txt", "detected-secret"],
    ]);
    expect(manifest.totalBytes).toBe(manifest.files.reduce((sum, file) => sum + file.size, 0));
    const before = manifest.digest;
    fs.writeFileSync(`${root}/untracked.txt`, "changed\n");
    expect(buildUploadManifest(root, DEFAULT_CONFIG).digest).not.toBe(before);
  });

  it("skips tracked files deleted from the worktree and symlinks", () => {
    const root = repo();
    const removed = write(root, "removed.txt", "remove me\n");
    fs.symlinkSync("README.md", `${root}/link.md`);
    runSync("git", ["add", "removed.txt", "link.md"], { cwd: root });
    runSync("git", ["commit", "-qm", "add"], { cwd: root });
    fs.unlinkSync(removed);
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    expect(manifest.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(manifest.excluded).toEqual([
      { path: "link.md", reason: "symbolic-link" },
      { path: "removed.txt", reason: "deleted" },
    ]);
  });

  it("enforces file, total, and count limits", () => {
    const root = repo();
    write(root, "large.txt", "12345");
    expect(() => buildUploadManifest(root, { ...DEFAULT_CONFIG, maxFileBytes: 4 })).toThrow(
      /per-file limit/,
    );
    expect(() => buildUploadManifest(root, { ...DEFAULT_CONFIG, maxUploadBytes: 4 })).toThrow(
      /the limit is 4 B/,
    );
    expect(() => buildUploadManifest(root, { ...DEFAULT_CONFIG, maxFiles: 1 })).toThrow(
      /limit is 1/,
    );
  });

  it("names the total and the five largest files when the upload is too big", () => {
    const sized = [..."abcdefg"].map((letter, index) => ({
      path: `${letter}.bin`,
      size: (index + 1) * 1000,
    }));
    expect(() => assertUploadFits(sized, 28_000)).not.toThrow();
    let message = "";
    try {
      assertUploadFits(sized, 5000);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/27\.3 KB across 7 files; the limit is 4\.9 KB/);
    expect(message).toMatch(/g\.bin \(6\.8 KB\)/);
    expect(message).toMatch(/c\.bin/);
    expect(message).not.toMatch(/b\.bin/);
    expect(message).toMatch(/excludedPaths/);
    let details: Record<string, unknown> | undefined;
    try {
      assertUploadFits(sized, 5000);
    } catch (error) {
      details = (error as PluginError).details;
    }
    expect((details?.largest as Array<{ path: string }>).map((entry) => entry.path)).toEqual([
      "g.bin",
      "f.bin",
      "e.bin",
      "d.bin",
      "c.bin",
    ]);
  });

  it("scans whole text files for secrets", () => {
    const root = repo();
    write(
      root,
      "late.txt",
      `${"safe\n".repeat(220_000)}sk-proj-abcdefghijklmnopqrstuvwxyz123456\n`,
    );
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    expect(manifest.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(manifest.excluded).toEqual([{ path: "late.txt", reason: "detected-secret" }]);
  });
});

describe("formatManifestSummary", () => {
  it("counts files and lists every exclusion with its reason", () => {
    const text = formatManifestSummary({
      schemaVersion: 1,
      root: "/r",
      files: [{ path: "a", absolutePath: "/r/a", size: 2048, sha256: "x", executable: false }],
      excluded: [{ path: ".env", reason: "environment-file" }],
      totalBytes: 2048,
      digest: "f".repeat(64),
    });
    expect(text).toContain("Upload: 1 file, 2.0 KB (digest ffffffffffff)");
    expect(text).toContain(".env [environment-file]");
    expect(formatBytes(5)).toBe("5 B");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("binary content", () => {
  it("still catches an ASCII credential hidden behind a NUL byte", () => {
    const root = repo();
    fs.writeFileSync(
      `${root}/blob.bin`,
      Buffer.concat([
        Buffer.from([0, 1, 2]),
        Buffer.from("sk-proj-abcdefghijklmnopqrstuvwxyz123456"),
      ]),
    );
    const manifest = buildUploadManifest(root, DEFAULT_CONFIG);
    expect(manifest.excluded).toEqual([{ path: "blob.bin", reason: "detected-secret" }]);
  });
});
