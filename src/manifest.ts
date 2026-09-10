import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PluginConfig } from "./config.js";
import { runSync } from "./process.js";
import { PluginError } from "./result.js";

export type ManifestConfig = Pick<
  PluginConfig,
  "excludedPaths" | "allowSensitivePaths" | "maxFiles" | "maxFileBytes" | "maxUploadBytes"
>;

export interface ManifestFile {
  path: string;
  absolutePath: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface ExcludedFile {
  path: string;
  reason: string;
}

export interface UploadManifest {
  schemaVersion: 1;
  root: string;
  files: ManifestFile[];
  excluded: ExcludedFile[];
  totalBytes: number;
  digest: string;
}

const ALWAYS_EXCLUDED_COMPONENTS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aws",
  ".ssh",
  ".gnupg",
  ".vercel",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".next",
  "dist",
  "build",
  "target",
  "coverage",
]);

const SENSITIVE_BASENAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials",
  "credentials.json",
  "service-account.json",
  "terraform.tfstate",
  "terraform.tfstate.backup",
  "id_rsa",
  "id_ed25519",
]);

const SENSITIVE_EXTENSIONS = new Set([".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"]);

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[opsu]_[A-Za-z0-9]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

export function normalizeRelative(relativePath: string): string {
  const normalized = relativePath.split(path.sep).join("/").replace(/^\.\//, "");
  if (
    !normalized ||
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new PluginError("unsafe_path", `Unsafe worktree path: ${relativePath}.`);
  }
  return normalized;
}

function matchesPrefix(relativePath: string, prefix: string): boolean {
  const normalized = prefix.replace(/^\.\//, "").replace(/\/$/, "");
  return relativePath === normalized || relativePath.startsWith(`${normalized}/`);
}

export function pathExclusionReason(relativePath: string, config: ManifestConfig): string | null {
  const normalized = normalizeRelative(relativePath);
  const components = normalized.split("/");
  if (components.some((component) => ALWAYS_EXCLUDED_COMPONENTS.has(component))) {
    return "blocked-directory";
  }
  if (config.allowSensitivePaths.includes(normalized)) return null;
  const lowerBase = (components.at(-1) ?? "").toLowerCase();
  if (
    lowerBase.startsWith(".env") &&
    !lowerBase.includes("example") &&
    !lowerBase.includes("sample")
  ) {
    return "environment-file";
  }
  if (SENSITIVE_BASENAMES.has(lowerBase)) return "credential-file";
  if (SENSITIVE_EXTENSIONS.has(path.posix.extname(lowerBase))) return "credential-extension";
  if (normalized.startsWith(".config/gcloud/") || normalized.startsWith(".terraform/")) {
    return "credential-directory";
  }
  if (config.excludedPaths.some((prefix) => matchesPrefix(normalized, prefix))) {
    return "configured-exclusion";
  }
  return null;
}

// Signatures are ASCII, so binary content is scanned too; a NUL byte is not an exemption.
export function detectSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

function contentExclusionReason(buffer: Buffer): string | null {
  return detectSecret(buffer.toString("latin1")) ? "detected-secret" : null;
}

function digestOf(buffer: Buffer | string): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function manifestDigest(files: ManifestFile[]): string {
  const canonical = files.map(({ path: filePath, size, sha256, executable }) => ({
    path: filePath,
    size,
    sha256,
    executable,
  }));
  return digestOf(JSON.stringify(canonical));
}

export function buildUploadManifest(root: string, config: ManifestConfig): UploadManifest {
  const listed = runSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: root,
    maxBuffer: Math.max(32 * 1024 * 1024, config.maxFiles * 1024),
  }).stdout;
  const candidates = listed.split("\0").filter(Boolean).map(normalizeRelative).sort();
  if (candidates.length > config.maxFiles) {
    throw new PluginError(
      "upload_file_limit",
      `The worktree has ${candidates.length} eligible files; the limit is ${config.maxFiles}.`,
    );
  }
  const files: ManifestFile[] = [];
  const excluded: ExcludedFile[] = [];
  const eligible: Array<{ relativePath: string; absolutePath: string; stat: fs.Stats }> = [];
  for (const relativePath of candidates) {
    const pathReason = pathExclusionReason(relativePath, config);
    if (pathReason) {
      excluded.push({ path: relativePath, reason: pathReason });
      continue;
    }
    const absolutePath = path.join(root, ...relativePath.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      excluded.push({ path: relativePath, reason: "deleted" });
      continue;
    }
    if (!stat.isFile()) {
      excluded.push({
        path: relativePath,
        reason: stat.isSymbolicLink() ? "symbolic-link" : "not-regular-file",
      });
      continue;
    }
    if (stat.size > config.maxFileBytes) {
      throw new PluginError(
        "upload_file_too_large",
        `${relativePath} is ${formatBytes(stat.size)}; the per-file limit is ${formatBytes(config.maxFileBytes)}.`,
      );
    }
    eligible.push({ relativePath, absolutePath, stat });
  }
  // Sized from stat before anything is read, so an oversized tree fails fast and names its weight.
  assertUploadFits(
    eligible.map((entry) => ({ path: entry.relativePath, size: entry.stat.size })),
    config.maxUploadBytes,
  );
  let totalBytes = 0;
  for (const { relativePath, absolutePath, stat } of eligible) {
    const buffer = fs.readFileSync(absolutePath);
    const contentReason = config.allowSensitivePaths.includes(relativePath)
      ? null
      : contentExclusionReason(buffer);
    if (contentReason) {
      excluded.push({ path: relativePath, reason: contentReason });
      continue;
    }
    totalBytes += buffer.byteLength;
    files.push({
      path: relativePath,
      absolutePath,
      size: buffer.byteLength,
      sha256: digestOf(buffer),
      executable: Boolean(stat.mode & 0o111),
    });
  }
  return { schemaVersion: 1, root, files, excluded, totalBytes, digest: manifestDigest(files) };
}

export const LARGEST_FILES_SHOWN = 5;

export function assertUploadFits(
  sized: ReadonlyArray<{ path: string; size: number }>,
  maxUploadBytes: number,
): void {
  const total = sized.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxUploadBytes) return;
  const largest = [...sized]
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, LARGEST_FILES_SHOWN);
  // The weight is often spread over hundreds of small assets, so the five largest files alone can
  // point nowhere; the heaviest top-level directories say what to exclude.
  const directories = heaviestDirectories(sized);
  throw new PluginError(
    "upload_size_limit",
    [
      `The filtered upload is ${formatBytes(total)} across ${sized.length} files; the limit is ${formatBytes(maxUploadBytes)}.`,
      ...(directories.length > 0
        ? [
            "Heaviest directories:",
            ...directories.map(
              (entry) =>
                `  ${entry.path} (${formatBytes(entry.size)}, ${entry.files} ${entry.files === 1 ? "file" : "files"})`,
            ),
          ]
        : []),
      "Largest files:",
      ...largest.map((entry) => `  ${entry.path} (${formatBytes(entry.size)})`),
      "Add directories or files to excludedPaths in config.json. Raising maxUploadBytes past 100 MB does not help: Box rejects larger uploads.",
    ].join("\n"),
    { totalBytes: total, maxUploadBytes, largest, directories },
  );
}

export function heaviestDirectories(
  sized: ReadonlyArray<{ path: string; size: number }>,
  limit = LARGEST_FILES_SHOWN,
): Array<{ path: string; size: number; files: number }> {
  const totals = new Map<string, { size: number; files: number }>();
  for (const entry of sized) {
    const slash = entry.path.indexOf("/");
    if (slash < 0) continue;
    const directory = `${entry.path.slice(0, slash)}/`;
    const current = totals.get(directory) ?? { size: 0, files: 0 };
    current.size += entry.size;
    current.files += 1;
    totals.set(directory, current);
  }
  return [...totals.entries()]
    .map(([path, total]) => ({ path, ...total }))
    .sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    .slice(0, limit);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatManifestSummary(manifest: UploadManifest): string {
  const count = manifest.files.length;
  const lines = [
    `Upload: ${count} ${count === 1 ? "file" : "files"}, ${formatBytes(manifest.totalBytes)} (digest ${manifest.digest.slice(0, 12)})`,
  ];
  if (manifest.excluded.length > 0) {
    lines.push(`Excluded: ${manifest.excluded.length}`);
    for (const entry of manifest.excluded) lines.push(`  ${entry.path} [${entry.reason}]`);
  }
  return lines.join("\n");
}
