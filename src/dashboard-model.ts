import path from "node:path";
import type { BoxData } from "@upstash/box";
import { mappingLabel } from "./box.js";
import { BOX_LABEL } from "./constants.js";
import { getHarness } from "./harness.js";
import type { Mapping, PluginState } from "./state.js";

export function formatAge(iso: string, now = Date.now()): string {
  const elapsed = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export function epochToIso(value: number): string {
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

export type BoxSummary = Pick<BoxData, "id" | "name" | "labels" | "status">;

// Ours means both the plugin label and a mapping label; the plugin label alone could be another tool's.
export function isPluginBox(box: BoxSummary): boolean {
  const labels = box.labels ?? [];
  return labels.includes(BOX_LABEL) && labels.some((label) => label.startsWith("hm:"));
}

// A box belongs to a mapping by recorded id, by its mapping label, or by its name.
export function claimedBy(state: PluginState, box: BoxSummary): Mapping | null {
  const labels = box.labels ?? [];
  for (const mapping of Object.values(state.mappings)) {
    if (mapping.boxId === box.id) return mapping;
    if (labels.includes(mappingLabel(mapping.id))) return mapping;
    if (box.name && box.name === mapping.boxName) return mapping;
  }
  return null;
}

export interface MappingRow {
  kind: "mapping";
  id: string;
  mapping: Mapping;
  remote: string;
  createdAt: string;
}

export interface OrphanRow {
  kind: "orphan";
  id: string;
  boxId: string;
  name: string;
  remote: string;
  createdAt: string;
}

export type DashboardRow = MappingRow | OrphanRow;

export function buildRows(state: PluginState, listing: BoxData[] | null): DashboardRow[] {
  const mappings = Object.values(state.mappings).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
  const rows: DashboardRow[] = mappings.map((mapping) => {
    let remote = "checking";
    if (listing) {
      const box = listing.find((entry) =>
        claimedBy({ ...state, mappings: { [mapping.id]: mapping } }, entry),
      );
      remote = box
        ? mapping.boxId
          ? box.status
          : `${box.status}, recoverable`
        : mapping.boxId
          ? "missing"
          : "no box";
    }
    return {
      kind: "mapping",
      id: mapping.id,
      mapping,
      remote,
      createdAt: mapping.createdAt,
    };
  });
  for (const box of listing ?? []) {
    if (box.status === "deleted" || !isPluginBox(box) || claimedBy(state, box)) continue;
    rows.push({
      kind: "orphan",
      id: `orphan:${box.id}`,
      boxId: box.id,
      name: box.name ?? box.id,
      remote: box.status,
      createdAt: epochToIso(box.created_at),
    });
  }
  return rows;
}

export type DashboardAction =
  | "up"
  | "down"
  | "reconnect"
  | "apply-changes"
  | "info"
  | "stop"
  | "pause"
  | "resume"
  | "snapshot"
  | "fork"
  | "previews"
  | "delete"
  | "refresh"
  | "quit";

export const KEY_ACTIONS: Readonly<Record<string, DashboardAction>> = Object.freeze({
  "\u001b[A": "up",
  k: "up",
  "\u001b[B": "down",
  j: "down",
  "\r": "reconnect",
  "\n": "reconnect",
  r: "reconnect",
  a: "apply-changes",
  i: "info",
  s: "stop",
  p: "pause",
  u: "resume",
  n: "snapshot",
  f: "fork",
  v: "previews",
  d: "delete",
  R: "refresh",
  q: "quit",
  "\u0003": "quit",
});

// Raw input can carry several keys in one chunk, or half an escape sequence; both are handled here.
export function splitKeys(chunk: string, pending = ""): { keys: string[]; pending: string } {
  const text = pending + chunk;
  const keys: string[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\u001b") {
      const rest = text.slice(index);
      const sequence = /^\u001b\[[0-9;]*[A-Za-z~]/.exec(rest);
      if (sequence) {
        keys.push(sequence[0]);
        index += sequence[0].length;
        continue;
      }
      if (rest.length < 4) return { keys, pending: rest };
      index += 1;
      continue;
    }
    keys.push(char);
    index += 1;
  }
  return { keys, pending: "" };
}

export const KEY_HELP =
  "[j/k] Select  [enter/r] Reconnect  [a] Apply  [i] Info  [s] Stop  [p] Pause  [u] Resume\n" +
  "[n] Snapshot  [f] Fork  [v] Previews\n" +
  "[d] Delete  [R] Refresh  [q] Close";

export function truncate(value: unknown, width: number): string {
  const text = String(value ?? "");
  if (width <= 1) return text.slice(0, width);
  return text.length <= width ? text.padEnd(width) : `${text.slice(0, width - 1)}…`;
}

export interface RenderMeta {
  width: number;
  syncing: boolean;
  message: string;
  now?: number;
}

export function renderDashboard(rows: DashboardRow[], selected: number, meta: RenderMeta): string {
  const width = Math.max(80, meta.width);
  const treeWidth = Math.min(30, Math.max(18, Math.floor(width * 0.24)));
  const boxWidth = Math.min(40, Math.max(22, width - treeWidth - 45));
  const now = meta.now ?? Date.now();
  const lines: string[] = [];
  lines.push(
    `Upstash Box  ${meta.syncing ? "syncing" : "live"}  ${rows.length} ${rows.length === 1 ? "box" : "boxes"}`,
    "",
    `   ${truncate("WORKTREE / BRANCH", treeWidth)}  ${truncate("BOX", boxWidth)}  ${truncate("AGENT", 11)}  ${truncate("LOCAL", 11)}  ${truncate("REMOTE", 13)}  AGE`,
    `   ${"-".repeat(treeWidth)}  ${"-".repeat(boxWidth)}  ${"-".repeat(11)}  ${"-".repeat(11)}  ${"-".repeat(13)}  ---`,
  );
  if (rows.length === 0) {
    lines.push("   No boxes. Start one from a Git worktree with the start-agent action.");
  }
  rows.forEach((row, index) => {
    const marker = index === selected ? ">" : " ";
    if (row.kind === "mapping") {
      const { mapping } = row;
      const tree = `${path.basename(mapping.localRoot)} / ${mapping.branch ?? "detached"}`;
      lines.push(
        `${marker}  ${truncate(tree, treeWidth)}  ${truncate(mapping.boxName, boxWidth)}  ${truncate(getHarness(mapping.harness).title, 11)}  ${truncate(mapping.lifecycleState, 11)}  ${truncate(row.remote, 13)}  ${formatAge(row.createdAt, now)}`,
      );
    } else {
      lines.push(
        `${marker}  ${truncate("(no mapping)", treeWidth)}  ${truncate(row.name, boxWidth)}  ${truncate("-", 11)}  ${truncate("orphan", 11)}  ${truncate(row.remote, 13)}  ${formatAge(row.createdAt, now)}`,
      );
    }
  });
  const current = rows[selected];
  if (current?.kind === "mapping") {
    const { mapping } = current;
    lines.push(
      "",
      "Selected",
      `  Worktree: ${mapping.localRoot}${mapping.relativeCwd === "." ? "" : ` (${mapping.relativeCwd})`}`,
      `  Box:      ${mapping.boxName}${mapping.boxId ? ` (${mapping.boxId})` : ""}`,
      `  Agent:    ${getHarness(mapping.harness).title}, ${mapping.model}`,
      `  State:    local ${mapping.lifecycleState} / remote ${current.remote}${mapping.prepared ? "" : " / not prepared"}`,
      `  Export:   ${mapping.lastAppliedExportCommit ? mapping.lastAppliedExportCommit.slice(0, 12) : "no baseline"}${mapping.lastSnapshot ? `   Snapshot: ${mapping.lastSnapshot.name}` : ""}`,
      ...(mapping.lastError ? [`  Error:    ${truncate(mapping.lastError, width - 12)}`] : []),
    );
  } else if (current?.kind === "orphan") {
    lines.push(
      "",
      "Selected",
      `  Box:      ${current.name} (${current.boxId})`,
      "  This box carries the plugin labels but no mapping knows it. Delete it, or leave it for the console.",
    );
  }
  lines.push("", KEY_HELP);
  if (meta.message) lines.push("", truncate(meta.message, width - 2));
  return `${lines.join("\n")}\n`;
}
