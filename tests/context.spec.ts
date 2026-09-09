import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextCwd, parsePluginContext, resolveGitContext } from "../src/context.js";
import { makeGitRepository, remove, temporaryDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

describe("parsePluginContext", () => {
  it("is empty without a payload and strict with a bad one", () => {
    expect(parsePluginContext(undefined)).toEqual({});
    expect(() => parsePluginContext("[1]")).toThrow(/must be an object/);
    expect(() => parsePluginContext("{")).toThrow(/invalid/);
  });
});

describe("contextCwd", () => {
  it("keeps the focused pane when it sits inside the worktree checkout", () => {
    const context = {
      focused_pane_cwd: "/repo/src",
      worktree: { checkout_path: "/repo" },
    };
    expect(contextCwd(context)).toBe("/repo/src");
  });

  it("uses the checkout when the focused pane is elsewhere", () => {
    const context = { focused_pane_cwd: "/tmp", worktree: { checkout_path: "/repo" } };
    expect(contextCwd(context)).toBe("/repo");
  });

  it("falls back to the workspace and then the given default", () => {
    expect(contextCwd({ workspace_cwd: "/ws" }, "/fallback")).toBe("/ws");
    expect(contextCwd({}, "/fallback")).toBe("/fallback");
  });
});

describe("resolveGitContext", () => {
  it("finds the worktree root, relative cwd, branch, and pane", () => {
    const root = makeGitRepository();
    directories.push(root);
    fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
    const context = {
      focused_pane_cwd: path.join(root, "packages", "app"),
      focused_pane_id: "pane-1",
    };
    const resolved = resolveGitContext(context, { env: {} });
    expect(resolved.root).toBe(root);
    expect(resolved.relativeCwd).toBe("packages/app");
    expect(resolved.branch).toBe("main");
    expect(resolved.sourcePaneId).toBe("pane-1");
  });

  it("takes the pane id from the environment when the context lacks one", () => {
    const root = makeGitRepository();
    directories.push(root);
    const resolved = resolveGitContext(
      { focused_pane_cwd: root },
      { env: { HERDR_PANE_ID: "p7" } },
    );
    expect(resolved.sourcePaneId).toBe("p7");
    expect(resolved.relativeCwd).toBe(".");
  });

  it("refuses a directory outside any Git worktree", () => {
    const plain = temporaryDirectory();
    directories.push(plain);
    expect(() => resolveGitContext({ focused_pane_cwd: plain })).toThrow(/No Git worktree/);
  });
});
