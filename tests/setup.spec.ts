import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoxError } from "@upstash/box";
import type { BoxClient } from "../src/box.js";
import {
  choose,
  defaultClaudeCredential,
  isClaudeOAuthToken,
  modelFor,
  runSetupPane,
} from "../src/panes/setup.js";
import { remove, temporaryDirectory } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) remove(directory);
});

function configDir(): string {
  const directory = temporaryDirectory();
  directories.push(directory);
  return directory;
}

function scripted(answers: Array<string | null>) {
  const asked: string[] = [];
  const prompt = async (question: string) => {
    asked.push(question);
    return answers.length > 0 ? (answers.shift() as string | null) : "";
  };
  return { asked, prompt };
}

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;

function keyClient(
  rejected: string[] = [],
  unreachable: string[] = [],
): BoxClient & { checked: string[] } {
  const checked: string[] = [];
  const unused = () => Promise.reject(new Error("not used by setup"));
  return {
    checked,
    list: async (apiKey) => {
      checked.push(apiKey);
      if (rejected.includes(apiKey)) throw new BoxError("unauthorized", 401);
      if (unreachable.includes(apiKey)) throw new Error("fetch failed");
      return [];
    },
    get: unused,
    create: unused,
    fromSnapshot: unused,
  };
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}

const quiet = () => undefined;
// No real `claude setup-token` and no network from the suite.
const offline = { claudeAvailable: () => false, verifyToken: async () => "valid" as const };

describe("setup pane", () => {
  it("validates the Box key, then writes config and secrets at 600 for a subscription token", async () => {
    const directory = configDir();
    const client = keyClient();
    const answers = scripted(["", "1"]);
    const secrets = scripted(["box-key", TOKEN]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client,
    });
    expect(outcome).toBe("saved");
    expect(client.checked).toEqual(["box-key"]);
    expect(readJson(path.join(directory, "config.json"))).toMatchObject({
      harness: "claude-code",
      model: "anthropic/claude-sonnet-5",
      providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(readJson(path.join(directory, "secrets.json"))).toEqual({
      UPSTASH_BOX_API_KEY: "box-key",
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    for (const name of ["config.json", "secrets.json"]) {
      expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("asks again after a rejected key and records only the one that worked", async () => {
    const directory = configDir();
    const client = keyClient(["bad-key"]);
    const answers = scripted(["", "2"]);
    const secrets = scripted(["bad-key", "good-key", "anthropic-key"]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client,
    });
    expect(outcome).toBe("saved");
    expect(client.checked).toEqual(["bad-key", "good-key"]);
    expect(readJson(path.join(directory, "secrets.json"))).toEqual({
      UPSTASH_BOX_API_KEY: "good-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
  });

  it("keeps keys found in the environment out of secrets.json", async () => {
    const directory = configDir();
    const client = keyClient();
    const secrets = scripted([]);
    const outcome = await runSetupPane({
      ...offline,
      env: { UPSTASH_BOX_API_KEY: "from-env", OPENAI_API_KEY: "from-env-too" },
      directory,
      write: quiet,
      // Codex, then Enter to keep the OpenAI key found in the environment.
      prompt: scripted(["2", ""]).prompt,
      promptSecret: secrets.prompt,
      client,
    });
    expect(outcome).toBe("saved");
    expect(client.checked).toEqual(["from-env"]);
    expect(secrets.asked).toEqual([]);
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
    expect(readJson(path.join(directory, "config.json"))).toEqual({
      harness: "codex",
      model: "openai/gpt-5.6",
      providerApiKeyEnv: "OPENAI_API_KEY",
      agentArgs: [],
    });
  });

  it("drops keys config.json no longer accepts and keeps the rest", async () => {
    const directory = configDir();
    fs.writeFileSync(
      path.join(directory, "config.json"),
      JSON.stringify({
        mode: "native",
        nativeKey: "local",
        boxBin: "/opt/box",
        excludedPaths: ["img/"],
      }),
    );
    const output: string[] = [];
    const outcome = await runSetupPane({
      ...offline,
      env: { UPSTASH_BOX_API_KEY: "k", ANTHROPIC_API_KEY: "an" },
      directory,
      write: (chunk) => void output.push(chunk),
      prompt: scripted(["", "", ""]).prompt,
      promptSecret: scripted([]).prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("saved");
    const written = readJson(path.join(directory, "config.json"));
    expect(written).not.toHaveProperty("mode");
    expect(written).not.toHaveProperty("nativeKey");
    expect(written).not.toHaveProperty("boxBin");
    expect(written.excludedPaths).toEqual(["img/"]);
    expect(output.join("")).toMatch(/removed keys no longer supported: mode, nativeKey, boxBin/);
  });

  it("writes nothing when a prompt times out", async () => {
    const directory = configDir();
    const client = keyClient();
    const answers = scripted([null]);
    const secrets = scripted(["box-key"]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client,
    });
    expect(outcome).toBe("aborted");
    expect(fs.existsSync(path.join(directory, "config.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
  });

  it("defaults a fresh TUI Claude setup to the subscription on Enter", async () => {
    const directory = configDir();
    const secrets = scripted(["box-key", TOKEN]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted(["", ""]).prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("saved");
    expect(readJson(path.join(directory, "config.json"))).toMatchObject({
      providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    });
  });

  it("defaults to a Console key only when one is present and no token is, and keeps it on Enter", async () => {
    const directory = configDir();
    const secrets = scripted([]);
    const outcome = await runSetupPane({
      ...offline,
      env: { UPSTASH_BOX_API_KEY: "k", ANTHROPIC_API_KEY: "an" },
      directory,
      write: quiet,
      prompt: scripted(["", "", ""]).prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("saved");
    expect(secrets.asked).toEqual([]);
    expect(readJson(path.join(directory, "config.json"))).toMatchObject({
      providerApiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
  });

  it("replaces a provider key that lives in secrets.json when asked to", async () => {
    const directory = configDir();
    fs.writeFileSync(
      path.join(directory, "secrets.json"),
      JSON.stringify({ UPSTASH_BOX_API_KEY: "k", ANTHROPIC_API_KEY: "old" }),
      { mode: 0o600 },
    );
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted(["", "2", "r"]).prompt,
      promptSecret: scripted(["new-key"]).prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("saved");
    expect(readJson(path.join(directory, "secrets.json"))).toEqual({
      UPSTASH_BOX_API_KEY: "k",
      ANTHROPIC_API_KEY: "new-key",
    });
  });

  it("refuses to replace a provider key that comes from the environment, since env wins", async () => {
    const directory = configDir();
    const secrets = scripted(["never-asked"]);
    const outcome = await runSetupPane({
      ...offline,
      env: { UPSTASH_BOX_API_KEY: "k", ANTHROPIC_API_KEY: "old" },
      directory,
      write: quiet,
      prompt: scripted(["", "2", "r"]).prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("aborted");
    expect(secrets.asked).toEqual([]);
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "config.json"))).toBe(false);
  });

  it("captures the token from claude setup-token when Claude Code is installed", async () => {
    const directory = configDir();
    const output: string[] = [];
    const secrets = scripted(["box-key"]);
    let captured = 0;
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: (chunk) => void output.push(chunk),
      prompt: scripted(["", "1"]).prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
      claudeAvailable: () => true,
      capture: async ({ write }) => {
        captured += 1;
        write("Opening browser...\n[token captured]\n");
        return TOKEN;
      },
    });
    expect(outcome).toBe("saved");
    expect(captured).toBe(1);
    expect(secrets.asked).toEqual(["Upstash Box API key: "]);
    expect(readJson(path.join(directory, "secrets.json"))).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: TOKEN,
    });
    expect(output.join("")).toContain("Checking the token with Anthropic");
    expect(output.join("")).not.toContain(TOKEN);
  });

  it("falls back to a paste when the capture yields nothing", async () => {
    const directory = configDir();
    const secrets = scripted(["box-key", TOKEN]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted(["", "1"]).prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
      claudeAvailable: () => true,
      capture: async () => null,
    });
    expect(outcome).toBe("saved");
    expect(secrets.asked).toEqual(["Upstash Box API key: ", "CLAUDE_CODE_OAUTH_TOKEN: "]);
    expect(readJson(path.join(directory, "secrets.json")).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it("refuses a token Anthropic rejects and writes nothing", async () => {
    const directory = configDir();
    const output: string[] = [];
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: (chunk) => void output.push(chunk),
      prompt: scripted(["", "1"]).prompt,
      promptSecret: scripted(["box-key", TOKEN]).prompt,
      client: keyClient(),
      verifyToken: async () => "invalid",
    });
    expect(outcome).toBe("aborted");
    expect(output.join("")).toContain("Anthropic rejected that token");
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
    expect(fs.existsSync(path.join(directory, "config.json"))).toBe(false);
  });

  it("saves a token it could not check, and says so", async () => {
    const directory = configDir();
    const output: string[] = [];
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: (chunk) => void output.push(chunk),
      prompt: scripted(["", "1"]).prompt,
      promptSecret: scripted(["box-key", TOKEN]).prompt,
      client: keyClient(),
      verifyToken: async () => "unknown",
    });
    expect(outcome).toBe("saved");
    expect(output.join("")).toContain("Could not reach Anthropic");
    expect(readJson(path.join(directory, "secrets.json")).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
  });

  it("refuses a pasted value that is not a setup-token token", async () => {
    const directory = configDir();
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted(["", "1"]).prompt,
      promptSecret: scripted(["box-key", "sk-ant-api03-not-a-subscription-token"]).prompt,
      client: keyClient(),
    });
    expect(outcome).toBe("aborted");
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
  });

  it("stops without blaming the key when the API is unreachable", async () => {
    const directory = configDir();
    const client = keyClient([], ["k1"]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted([]).prompt,
      promptSecret: scripted(["k1", "k2", "k3"]).prompt,
      client,
    });
    expect(outcome).toBe("aborted");
    expect(client.checked).toEqual(["k1"]);
    expect(fs.existsSync(path.join(directory, "config.json"))).toBe(false);
  });

  it("gives up after three rejected keys without writing anything", async () => {
    const directory = configDir();
    const client = keyClient(["a", "b", "c"]);
    const outcome = await runSetupPane({
      ...offline,
      env: {},
      directory,
      write: quiet,
      prompt: scripted([]).prompt,
      promptSecret: scripted(["a", "b", "c"]).prompt,
      client,
    });
    expect(outcome).toBe("aborted");
    expect(client.checked).toEqual(["a", "b", "c"]);
    expect(fs.existsSync(path.join(directory, "config.json"))).toBe(false);
  });
});

describe("setup helpers", () => {
  it("keeps a configured model on the same provider and defaults otherwise", () => {
    expect(modelFor("claude-code", "anthropic", "anthropic/claude-opus-5")).toBe(
      "anthropic/claude-opus-5",
    );
    expect(modelFor("claude-code", "openrouter", "anthropic/claude-opus-5")).toBe(
      "openrouter/anthropic/claude-sonnet-5",
    );
    expect(modelFor("codex", "openai", "not-a-model")).toBe("openai/gpt-5.6");
  });

  it("treats a blank answer as keep and re-asks on nonsense", async () => {
    const answers = scripted(["x", "2"]);
    const picked = await choose(
      answers.prompt,
      quiet,
      "Pick",
      [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
      "a",
    );
    expect(picked).toBe("b");
    expect(answers.asked).toHaveLength(2);
    expect(
      await choose(scripted([""]).prompt, quiet, "Pick", [{ value: "a", label: "A" }], "a"),
    ).toBe("a");
    expect(
      await choose(scripted([null]).prompt, quiet, "Pick", [{ value: "a", label: "A" }], "a"),
    ).toBeNull();
  });

  it("recognises the setup-token shape and picks the subscription default correctly", () => {
    expect(isClaudeOAuthToken(TOKEN)).toBe(true);
    expect(isClaudeOAuthToken(`sk-ant-oat02-${"b".repeat(48)}`)).toBe(true);
    expect(isClaudeOAuthToken("sk-ant-api03-console-key")).toBe(false);
    expect(isClaudeOAuthToken("sk-ant-oat01-short")).toBe(false);
    const none = () => false;
    const fresh = { providerApiKeyEnv: null, model: "anthropic/claude-sonnet-5" };
    expect(defaultClaudeCredential(fresh, none)).toBe("oauth");
    expect(defaultClaudeCredential(fresh, (name) => name === "ANTHROPIC_API_KEY")).toBe(
      "anthropic",
    );
    expect(
      defaultClaudeCredential(fresh, (name) =>
        ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name),
      ),
    ).toBe("oauth");
    expect(
      defaultClaudeCredential({ ...fresh, model: "openrouter/anthropic/claude-sonnet-5" }, none),
    ).toBe("openrouter");
    expect(
      defaultClaudeCredential({ ...fresh, providerApiKeyEnv: "ANTHROPIC_API_KEY" }, none),
    ).toBe("anthropic");
  });
});
