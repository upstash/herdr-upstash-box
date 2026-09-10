import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BoxClient } from "../src/box.js";
import { choose, modelFor, runSetupPane } from "../src/panes/setup.js";
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

function keyClient(rejected: string[] = []): BoxClient & { checked: string[] } {
  const checked: string[] = [];
  const unused = () => Promise.reject(new Error("not used by setup"));
  return {
    checked,
    list: async (apiKey) => {
      checked.push(apiKey);
      if (rejected.includes(apiKey)) throw new Error("401 unauthorized");
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

describe("setup pane", () => {
  it("validates the Box key, then writes config and secrets at 600 for a subscription token", async () => {
    const directory = configDir();
    const client = keyClient();
    const answers = scripted(["", "", "1"]);
    const secrets = scripted(["box-key", "oauth-token"]);
    const outcome = await runSetupPane({
      env: {},
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client,
      claudeOnPath: () => false,
    });
    expect(outcome).toBe("saved");
    expect(client.checked).toEqual(["box-key"]);
    expect(readJson(path.join(directory, "config.json"))).toMatchObject({
      mode: "tui",
      harness: "claude-code",
      model: "anthropic/claude-sonnet-5",
      providerApiKeyEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(readJson(path.join(directory, "secrets.json"))).toEqual({
      UPSTASH_BOX_API_KEY: "box-key",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    });
    for (const name of ["config.json", "secrets.json"]) {
      expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    }
  });

  it("asks again after a rejected key and records only the one that worked", async () => {
    const directory = configDir();
    const client = keyClient(["bad-key"]);
    const answers = scripted(["", "", "2"]);
    const secrets = scripted(["bad-key", "good-key", "anthropic-key"]);
    const outcome = await runSetupPane({
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

  it("keeps keys found in the environment out of secrets.json and skips the credential in native mode", async () => {
    const directory = configDir();
    const client = keyClient();
    const answers = scripted(["2", "2"]);
    const secrets = scripted([]);
    const outcome = await runSetupPane({
      env: { UPSTASH_BOX_API_KEY: "from-env" },
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client,
    });
    expect(outcome).toBe("saved");
    expect(client.checked).toEqual(["from-env"]);
    expect(secrets.asked).toEqual([]);
    expect(fs.existsSync(path.join(directory, "secrets.json"))).toBe(false);
    expect(readJson(path.join(directory, "config.json"))).toMatchObject({
      mode: "native",
      harness: "codex",
      model: "openai/gpt-5.6",
      providerApiKeyEnv: null,
    });
  });

  it("writes nothing when a prompt times out", async () => {
    const directory = configDir();
    const client = keyClient();
    const answers = scripted([null]);
    const secrets = scripted(["box-key"]);
    const outcome = await runSetupPane({
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

  it("runs claude setup-token when Claude Code is installed locally", async () => {
    const directory = configDir();
    let ran = 0;
    const answers = scripted(["", "", "1"]);
    const secrets = scripted(["box-key", "oauth-token"]);
    await runSetupPane({
      env: {},
      directory,
      write: quiet,
      prompt: answers.prompt,
      promptSecret: secrets.prompt,
      client: keyClient(),
      claudeOnPath: () => true,
      runSetupToken: () => {
        ran += 1;
        return 0;
      },
    });
    expect(ran).toBe(1);
  });

  it("gives up after three rejected keys without writing anything", async () => {
    const directory = configDir();
    const client = keyClient(["a", "b", "c"]);
    const outcome = await runSetupPane({
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
});
