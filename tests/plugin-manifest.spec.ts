import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTIONS } from "../src/actions.js";
import { PLUGIN_ID } from "../src/constants.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = fs.readFileSync(path.join(root, "herdr-plugin.toml"), "utf8");

function sectionIds(kind: "actions" | "panes"): string[] {
  return manifest
    .split(/^\[\[(actions|panes)\]\]$/m)
    .flatMap((chunk, index, parts) =>
      index > 0 && parts[index - 1] === kind ? [/^id = "([^"]+)"/m.exec(chunk)?.[1] ?? ""] : [],
    )
    .filter(Boolean);
}

describe("herdr-plugin.toml", () => {
  it("carries the plugin id the code uses", () => {
    expect(manifest).toContain(`id = "${PLUGIN_ID}"`);
  });

  it("declares exactly the actions the dispatcher knows", () => {
    expect(sectionIds("actions").sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  it("declares every pane the actions open", () => {
    expect(sectionIds("panes").sort()).toEqual(
      [
        "start",
        "agent",
        "native",
        "operation",
        "confirmation",
        "dashboard",
        "previews",
        "agent-runs",
        "schedules",
      ].sort(),
    );
  });

  it("points every command at a source entrypoint that exists", () => {
    const commands = [...manifest.matchAll(/command = \["node", "dist\/([^"]+)\.js"\]/g)].map(
      (match) => match[1],
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const name of commands) {
      expect(fs.existsSync(path.join(root, "src", `${name}.ts`))).toBe(true);
    }
  });
});
