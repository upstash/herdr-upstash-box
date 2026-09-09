import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { herdrBinary, openPluginPane, pluginPaneArgs } from "../src/herdr.js";
import { temporaryDirectory } from "./helpers.js";

describe("pluginPaneArgs", () => {
  const context = { focused_pane_id: "pane-1", workspace_id: "ws-1" };

  it("splits beside the focused pane by default", () => {
    const args = pluginPaneArgs("agent", context, { placement: "split" });
    expect(args).toEqual([
      "plugin",
      "pane",
      "open",
      "--plugin",
      "upstash.box",
      "--entrypoint",
      "agent",
      "--placement",
      "split",
      "--target-pane",
      "pane-1",
      "--focus",
    ]);
  });

  it("targets an explicit pane and passes environment", () => {
    const args = pluginPaneArgs("agent", context, {
      placement: "split",
      targetPaneId: "pane-2",
      env: { HERDR_BOX_MAPPING_ID: "m1" },
      focus: false,
    });
    expect(args).toContain("pane-2");
    expect(args).toContain("HERDR_BOX_MAPPING_ID=m1");
    expect(args.at(-1)).toBe("--no-focus");
  });

  it("uses the workspace for tabs and no target for popups", () => {
    const tab = pluginPaneArgs("x", context, { placement: "tab" });
    expect(tab).toContain("--workspace");
    expect(tab).not.toContain("--target-pane");
    const popup = pluginPaneArgs("x", context, { placement: "popup" });
    expect(popup).not.toContain("--target-pane");
  });

  it("rejects environment keys herdr would not accept", () => {
    expect(() => pluginPaneArgs("x", context, { env: { "bad-key": "v" } })).toThrow(
      /Invalid pane environment key/,
    );
  });
});

describe("herdrBinary", () => {
  it("prefers the binary herdr hands to plugins", () => {
    expect(herdrBinary({ HERDR_BIN_PATH: "/opt/herdr" })).toBe("/opt/herdr");
    expect(herdrBinary({})).toBe("herdr");
  });
});

describe("openPluginPane failures", () => {
  const context = { focused_pane_id: "pane-1" };
  function withHerdr(status: number, stdout: string) {
    const bin = `${temporaryDirectory()}/herdr`;
    fs.writeFileSync(bin, `#!/bin/sh\ncat <<'OUT'\n${stdout}\nOUT\nexit ${status}\n`, {
      mode: 0o755,
    });
    return bin;
  }

  it("names a blocked popup instead of surfacing raw herdr JSON", () => {
    const bin = withHerdr(
      1,
      '{"error":{"code":"ui_busy","message":"a popup pane is already open"}}',
    );
    expect(() =>
      openPluginPane("operation", context, {
        placement: "popup",
        processEnv: { HERDR_BIN_PATH: bin },
      }),
    ).toThrow(/Another popup is already open/);
  });

  it("reports any other pane failure with herdr's own detail", () => {
    const bin = withHerdr(1, '{"error":{"code":"unknown_entrypoint"}}');
    expect(() => openPluginPane("nope", context, { processEnv: { HERDR_BIN_PATH: bin } })).toThrow(
      /could not open the nope pane.*unknown_entrypoint/s,
    );
  });

  it("returns the result when herdr succeeds", () => {
    const bin = withHerdr(0, "{}");
    expect(openPluginPane("agent", context, { processEnv: { HERDR_BIN_PATH: bin } }).status).toBe(
      0,
    );
  });
});
