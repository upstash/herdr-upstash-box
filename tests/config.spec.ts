import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkSecretsFile,
  DEFAULT_CONFIG,
  loadConfig,
  loadSecrets,
  overrideHarness,
  resolveSecret,
  validateConfig,
} from "../src/config.js";
import { PluginError } from "../src/result.js";
import { remove, temporaryDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

function configDir(files: Record<string, string> = {}, mode = 0o600): string {
  const directory = temporaryDirectory();
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(directory, name), content, { mode });
  }
  return directory;
}

describe("validateConfig", () => {
  it("fills every default", () => {
    expect(validateConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("rejects unknown keys so a typo cannot silently change behaviour", () => {
    expect(() => validateConfig({ harnes: "codex" })).toThrow(/Unknown config keys: harnes/);
  });

  it("rejects an unsupported harness, and mode is no longer a setting", () => {
    expect(() => validateConfig({ harness: "cursor" })).toThrow(/harness must be one of/);
    expect(() => validateConfig({ mode: "tui" })).toThrow(/Unknown config keys: mode/);
    expect(() => validateConfig({ nativeKey: "managed" })).toThrow(PluginError);
  });

  it("rejects a model id without a provider prefix", () => {
    expect(() => validateConfig({ model: "claude-sonnet-5" })).toThrow(/Cannot infer a provider/);
  });

  it("rejects a harness and model that cannot work together before any box exists", () => {
    expect(() => validateConfig({ harness: "codex", model: "anthropic/claude-sonnet-5" })).toThrow(
      /Responses API/,
    );
    expect(() => validateConfig({ harness: "claude-code", model: "openai/gpt-5" })).toThrow(
      /Claude Code cannot use a openai model/,
    );
    expect(validateConfig({ harness: "opencode", model: "openai/gpt-5" }).harness).toBe("opencode");
  });

  it("keeps remoteRoot under /workspace", () => {
    expect(() => validateConfig({ remoteRoot: "/tmp/x" })).toThrow(/remoteRoot/);
    expect(validateConfig({ remoteRoot: "/workspace/home/app" }).remoteRoot).toBe(
      "/workspace/home/app",
    );
  });

  it("validates upload paths and limits", () => {
    expect(() => validateConfig({ excludedPaths: ["../x"] })).toThrow(/safe paths/);
    expect(() => validateConfig({ excludedPaths: ["src/*"] })).toThrow(/safe paths/);
    expect(() => validateConfig({ excludedPaths: ["a", "a"] })).toThrow(/duplicates/);
    expect(() => validateConfig({ allowSensitivePaths: [".env/"] })).toThrow(/safe paths/);
    expect(() => validateConfig({ maxFiles: 0 })).toThrow(/positive integer/);
    expect(
      validateConfig({ excludedPaths: ["fixtures/"], allowSensitivePaths: [".env"] }),
    ).toMatchObject({
      excludedPaths: ["fixtures/"],
      allowSensitivePaths: [".env"],
    });
  });
});

describe("loadConfig", () => {
  it("returns defaults when config.json is absent", () => {
    expect(loadConfig({ directory: configDir() })).toEqual(DEFAULT_CONFIG);
  });

  it("reads and validates config.json", () => {
    const directory = configDir({ "config.json": JSON.stringify({ harness: "opencode" }) });
    expect(loadConfig({ directory }).harness).toBe("opencode");
  });

  it("names the config directory env when it is missing", () => {
    expect(() => loadConfig({ env: {} })).toThrow(/HERDR_PLUGIN_CONFIG_DIR/);
  });
});

describe("secrets", () => {
  it("reads variable names from secrets.json and drops empty values", () => {
    const directory = configDir({
      "secrets.json": JSON.stringify({ UPSTASH_BOX_API_KEY: "box", ANTHROPIC_API_KEY: "" }),
    });
    expect(loadSecrets({ directory })).toEqual({ UPSTASH_BOX_API_KEY: "box" });
  });

  it("rejects entries that are not variable names", () => {
    const directory = configDir({ "secrets.json": JSON.stringify({ "box key": "x" }) });
    expect(() => loadSecrets({ directory })).toThrow(/secrets.json entry/);
  });

  it("tightens a secrets file other users can read instead of refusing it", () => {
    const directory = configDir(
      { "secrets.json": JSON.stringify({ UPSTASH_BOX_API_KEY: "box" }) },
      0o644,
    );
    const file = path.join(directory, "secrets.json");
    expect(loadSecrets({ directory })).toEqual({ UPSTASH_BOX_API_KEY: "box" });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked secrets file and one owned by someone else", () => {
    const directory = configDir({ "real.json": "{}" });
    fs.symlinkSync(path.join(directory, "real.json"), path.join(directory, "secrets.json"));
    expect(() => loadSecrets({ directory })).toThrow(/regular file/);
    expect(() => checkSecretsFile(path.join(directory, "real.json"), 424242)).toThrow(
      /owned by the current user/,
    );
  });

  it("is empty when no config directory is known", () => {
    expect(loadSecrets({ env: {} })).toEqual({});
  });

  it("prefers the environment over the file", () => {
    const secrets = { ANTHROPIC_API_KEY: "file" };
    expect(resolveSecret("ANTHROPIC_API_KEY", { env: { ANTHROPIC_API_KEY: "env" }, secrets })).toBe(
      "env",
    );
    expect(resolveSecret("ANTHROPIC_API_KEY", { env: {}, secrets })).toBe("file");
    expect(resolveSecret("OPENAI_API_KEY", { env: {}, secrets })).toBeUndefined();
  });
});

describe("overrideHarness", () => {
  it("keeps a model the harness supports and drops harness-specific settings", () => {
    const config = {
      ...DEFAULT_CONFIG,
      model: "openrouter/anthropic/claude-sonnet-5",
      agentArgs: ["--dangerously-skip-permissions"],
      providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    };
    expect(overrideHarness(config, "claude-code")).toBe(config);
    expect(overrideHarness(config, "opencode")).toMatchObject({
      harness: "opencode",
      model: "openrouter/anthropic/claude-sonnet-5",
      agentArgs: [],
      providerApiKeyEnv: null,
    });
    expect(overrideHarness(config, "codex")).toMatchObject({
      harness: "codex",
      model: "openai/gpt-5.6",
      agentArgs: [],
      providerApiKeyEnv: null,
    });
  });
});
