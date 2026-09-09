import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  Box,
  BoxConfig,
  BoxData,
  BoxRunData,
  ExecSessionHandle,
  ExecSessionOptions,
  PublicURL,
  Run,
  RunOptions,
  Schedule,
  AgentScheduleOptions,
  Snapshot,
  UploadFileEntry,
} from "@upstash/box";
import type { BoxClient } from "../src/box.js";
import { runSync } from "../src/process.js";
import type { Mapping } from "../src/state.js";

export function temporaryDirectory(prefix = "herdr-box-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeGitRepository(): string {
  const root = fs.realpathSync.native(temporaryDirectory());
  runSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  runSync("git", ["config", "user.name", "Test User"], { cwd: root });
  runSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "hello\n");
  runSync("git", ["add", "-A"], { cwd: root });
  runSync("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}

export function write(root: string, relativePath: string, content: string, mode?: number): string {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
  return file;
}

export function remove(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export const MAPPING_ID = "12345678-1234-4123-8123-123456789abc";
export const COMMIT_A = "a".repeat(40);

export function sampleMapping(overrides: Partial<Mapping> = {}): Mapping {
  const at = "2026-09-09T10:00:00.000Z";
  return {
    schemaVersion: 1,
    id: MAPPING_ID,
    mode: "tui",
    harness: "claude-code",
    model: "anthropic/claude-sonnet-5",
    credential: "session",
    sourcePaneId: "pane-1",
    remotePaneId: null,
    connectionId: null,
    boxId: "box-1",
    boxName: "herdr-claude-code-repo-abcdef12",
    labels: ["herdr", "hm:1234567812344123"],
    localRoot: "/repo",
    localCwd: "/repo",
    relativeCwd: ".",
    remoteRoot: "/workspace/home",
    branch: "main",
    lifecycleState: "ready",
    prepared: true,
    everAttached: false,
    uploadDigest: null,
    lastAppliedExportCommit: COMMIT_A,
    lastSnapshot: null,
    lastError: null,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function fakeHandle(exitCode = 0): ExecSessionHandle & { written: string[] } {
  const written: string[] = [];
  return {
    pid: 1,
    execId: "exec-1",
    written,
    write(data) {
      written.push(typeof data === "string" ? data : Buffer.from(data).toString());
    },
    endStdin() {},
    resize() {},
    kill() {},
    terminate() {},
    wait: async () => exitCode,
    close() {},
  } as ExecSessionHandle & { written: string[] };
}

export interface FakeBoxOptions {
  id?: string;
  statuses?: string[];
  commandOutput?: (command: string) => { stdout: string; stderr?: string; exitCode?: number };
  session?: (options: ExecSessionOptions) => ExecSessionHandle;
  remoteFiles?: Record<string, Buffer>;
  remoteFile?: (target: string) => Buffer | undefined;
  publicURLs?: PublicURL[];
  keepAlive?: boolean;
  labels?: string[];
  agentRun?: (options: RunOptions<unknown>) => Promise<Run<unknown>>;
  schedules?: Schedule[];
  runs?: BoxRunData[];
}

export interface FakeBoxCalls {
  commands: string[];
  sessions: ExecSessionOptions[];
  mkdirs: string[];
  uploads: UploadFileEntry[];
  removed: string[];
  reads: number;
  resumed: number;
  paused: number;
  deleted: number;
  snapshots: string[];
  exposed: Array<{ port: number; basicAuth: boolean }>;
  unexposed: number[];
  cds: string[];
  agentRuns: RunOptions<unknown>[];
  requests: string[];
  writes: Array<{ path: string; content: string }>;
  scheduleAgents: AgentScheduleOptions<unknown>[];
  schedulePaused: string[];
  scheduleResumed: string[];
  scheduleDeleted: string[];
}

export function fakeBox(options: FakeBoxOptions = {}): { box: Box; calls: FakeBoxCalls } {
  const calls: FakeBoxCalls = {
    commands: [],
    sessions: [],
    mkdirs: [],
    uploads: [],
    removed: [],
    reads: 0,
    resumed: 0,
    paused: 0,
    deleted: 0,
    snapshots: [],
    exposed: [],
    unexposed: [],
    cds: [],
    agentRuns: [],
    requests: [],
    writes: [],
    scheduleAgents: [],
    schedulePaused: [],
    scheduleResumed: [],
    scheduleDeleted: [],
  };
  const statuses = [...(options.statuses ?? ["running"])];
  const remoteFiles = options.remoteFiles ?? {};
  const urls: PublicURL[] = [...(options.publicURLs ?? [])];
  const id = options.id ?? "box-1";
  const schedules = [...(options.schedules ?? [])];
  const box = {
    id,
    keepAlive: options.keepAlive ?? false,
    async getStatus() {
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { status: status ?? "running" };
    },
    async resume() {
      calls.resumed += 1;
    },
    async pause() {
      if (options.keepAlive) throw new Error("Keep-alive boxes cannot be paused");
      calls.paused += 1;
    },
    async delete() {
      calls.deleted += 1;
    },
    async cd(folder: string) {
      calls.cds.push(folder);
      return box;
    },
    agent: {
      async run(runOptions: RunOptions<unknown>) {
        calls.agentRuns.push(runOptions);
        if (options.agentRun) return options.agentRun(runOptions);
        return {
          id: `run-${calls.agentRuns.length}`,
          status: "completed",
          result: { answer: "ok" },
          cost: {
            inputTokens: 10,
            outputTokens: 2,
            cachedInputTokens: 0,
            computeMs: 100,
            totalUsd: 0.01,
          },
        } as Run<unknown>;
      },
    },
    async _request(method: string, url: string) {
      calls.requests.push(`${method} ${url}`);
      return {};
    },
    async listRuns(): Promise<BoxRunData[]> {
      return options.runs ?? [];
    },
    schedule: {
      async list(): Promise<Schedule[]> {
        return schedules.filter((schedule) => schedule.status !== "deleted");
      },
      async agent(scheduleOptions: AgentScheduleOptions<unknown>): Promise<Schedule> {
        calls.scheduleAgents.push(scheduleOptions);
        const now = Math.floor(Date.now() / 1000);
        const schedule: Schedule = {
          id: `schedule-${calls.scheduleAgents.length}`,
          box_id: id,
          type: "prompt",
          cron: scheduleOptions.cron,
          prompt: scheduleOptions.prompt,
          folder: scheduleOptions.folder,
          model: scheduleOptions.model,
          timeout: scheduleOptions.timeout,
          status: "active",
          total_runs: 0,
          total_failures: 0,
          created_at: now,
          updated_at: now,
        };
        schedules.push(schedule);
        return schedule;
      },
      async pause(scheduleId: string) {
        calls.schedulePaused.push(scheduleId);
        const schedule = schedules.find((entry) => entry.id === scheduleId);
        if (schedule) schedule.status = "paused";
      },
      async resume(scheduleId: string) {
        calls.scheduleResumed.push(scheduleId);
        const schedule = schedules.find((entry) => entry.id === scheduleId);
        if (schedule) schedule.status = "active";
      },
      async delete(scheduleId: string) {
        calls.scheduleDeleted.push(scheduleId);
        const schedule = schedules.find((entry) => entry.id === scheduleId);
        if (schedule) schedule.status = "deleted";
      },
    },
    labels: {
      async list() {
        return options.labels ?? ["herdr", "hm:1234567812344123"];
      },
    },
    async snapshot(request: { name: string }): Promise<Snapshot> {
      calls.snapshots.push(request.name);
      return {
        id: `snap-${calls.snapshots.length}`,
        name: request.name,
        box_id: id,
        size_bytes: 4096,
        status: "ready",
        created_at: 1_757_412_000,
      };
    },
    async listSnapshots(): Promise<Snapshot[]> {
      return [];
    },
    async listPublicURLs() {
      return { publicURLs: urls.map((entry) => ({ port: entry.port, url: entry.url })) };
    },
    async getPublicURL(port: number, opts?: { basicAuth?: boolean }): Promise<PublicURL> {
      calls.exposed.push({ port, basicAuth: Boolean(opts?.basicAuth) });
      const entry: PublicURL = {
        port,
        url: `https://p${port}.example.test`,
        ...(opts?.basicAuth ? { username: "box", password: "secret" } : {}),
      };
      urls.push({ port, url: entry.url });
      return entry;
    },
    async deletePublicURL(port: number) {
      calls.unexposed.push(port);
      const index = urls.findIndex((entry) => entry.port === port);
      if (index >= 0) urls.splice(index, 1);
    },
    files: {
      async mkdir(target: string) {
        calls.mkdirs.push(target);
      },
      async upload(entries: UploadFileEntry[]) {
        calls.uploads.push(...entries);
      },
      async stat(target: string) {
        const content = remoteFiles[target] ?? options.remoteFile?.(target);
        if (!content) throw new Error(`no remote file ${target}`);
        return { type: "file", size: content.length, mod_time: "", inode: 1, version: "1" };
      },
      async read(target: string, opts: { encoding?: "base64"; offset?: number; length?: number }) {
        calls.reads += 1;
        const content = remoteFiles[target] ?? options.remoteFile?.(target);
        if (!content) throw new Error(`no remote file ${target}`);
        const offset = opts?.offset ?? 0;
        const slice = content.subarray(offset, offset + (opts?.length ?? content.length));
        return opts?.encoding === "base64" ? slice.toString("base64") : slice.toString("utf8");
      },
      async write(entry: { path: string; content: string }) {
        calls.writes.push(entry);
        remoteFiles[entry.path] = Buffer.from(entry.content);
      },
      async remove(target: string) {
        calls.removed.push(target);
      },
    },
    exec: {
      async command(command: string) {
        calls.commands.push(command);
        const output = options.commandOutput?.(command) ?? { stdout: "", exitCode: 0 };
        return {
          stdout: output.stdout,
          stderr: output.stderr ?? "",
          result: output.stdout,
          exitCode: output.exitCode ?? 0,
        };
      },
      async session(sessionOptions: ExecSessionOptions) {
        calls.sessions.push(sessionOptions);
        return options.session?.(sessionOptions) ?? fakeHandle();
      },
    },
  };
  return { box: box as unknown as Box, calls };
}

export interface FakeClient extends BoxClient {
  created: BoxConfig[];
  forks: Array<{ snapshotId: string; config: BoxConfig }>;
  gets: string[];
}

export function fakeClient(boxes: Record<string, Box>, listing: BoxData[] = []): FakeClient {
  const created: BoxConfig[] = [];
  const forks: Array<{ snapshotId: string; config: BoxConfig }> = [];
  const gets: string[] = [];
  return {
    created,
    forks,
    gets,
    async get(id) {
      gets.push(id);
      const box = boxes[id];
      if (!box) throw new Error(`no box ${id}`);
      return box;
    },
    async list() {
      return listing;
    },
    async create(config) {
      created.push(config);
      const box = boxes.created;
      if (!box) throw new Error("no created box configured");
      return box;
    },
    async fromSnapshot(snapshotId, config) {
      forks.push({ snapshotId, config });
      const box = boxes.forked;
      if (!box) throw new Error("no forked box configured");
      return box;
    },
  };
}

export function listing(entries: Array<Partial<BoxData> & { id: string }>): BoxData[] {
  return entries.map((entry) => ({
    status: "running",
    created_at: 0,
    updated_at: 0,
    labels: ["herdr"],
    ...entry,
  }));
}
