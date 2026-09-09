import { Agent } from "@upstash/box";
import { describe, expect, it } from "vitest";
import {
  assertHarnessSupportsModel,
  getHarness,
  launchEnv,
  modelArg,
  providerFor,
  providerKeyEnv,
} from "../src/harness.js";
import { PluginError } from "../src/result.js";

const OR_SONNET = "openrouter/anthropic/claude-sonnet-5";

describe("providerFor", () => {
  it("reads the provider off the Box model prefix", () => {
    expect(providerFor(OR_SONNET)).toBe("openrouter");
    expect(providerFor("anthropic/claude-sonnet-4-5")).toBe("anthropic");
    expect(providerFor("openai/gpt-5.3-codex")).toBe("openai");
    expect(providerFor("opencode/claude-sonnet-5")).toBe("opencode");
  });

  it("refuses a model id it cannot place", () => {
    expect(() => providerFor("claude-sonnet-5")).toThrow(PluginError);
  });

  it("names the variable that carries each provider's key", () => {
    expect(providerKeyEnv(OR_SONNET)).toBe("OPENROUTER_API_KEY");
    expect(providerKeyEnv("openai/gpt-5")).toBe("OPENAI_API_KEY");
  });
});

describe("assertHarnessSupportsModel", () => {
  it("accepts the documented pairs and rejects the rest before anything runs", () => {
    expect(assertHarnessSupportsModel(getHarness(Agent.ClaudeCode), OR_SONNET)).toBe("openrouter");
    expect(assertHarnessSupportsModel(getHarness(Agent.OpenCode), "openai/gpt-5")).toBe("openai");
    expect(() => assertHarnessSupportsModel(getHarness(Agent.ClaudeCode), "openai/gpt-5")).toThrow(
      /Claude Code cannot use a openai model/,
    );
    expect(() => assertHarnessSupportsModel(getHarness(Agent.Codex), OR_SONNET)).toThrow(
      /Responses API/,
    );
  });

  it("names an unknown harness", () => {
    expect(() => getHarness("cursor")).toThrow(/No interactive harness for cursor/);
  });
});

describe("modelArg", () => {
  it("strips the Box prefix for CLIs that take a bare model id", () => {
    expect(modelArg(getHarness(Agent.ClaudeCode), OR_SONNET)).toBe("anthropic/claude-sonnet-5");
    expect(modelArg(getHarness(Agent.Codex), "openai/gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps the full id for OpenCode, which addresses provider/model", () => {
    expect(modelArg(getHarness(Agent.OpenCode), OR_SONNET)).toBe(OR_SONNET);
    expect(modelArg(getHarness(Agent.OpenCode), "anthropic/claude-sonnet-5")).toBe(
      "anthropic/claude-sonnet-5",
    );
  });
});

describe("launchEnv", () => {
  it("points Claude Code at the OpenRouter Anthropic-compatible endpoint", () => {
    expect(launchEnv(getHarness(Agent.ClaudeCode), OR_SONNET, "k")).toEqual([
      "ANTHROPIC_AUTH_TOKEN=k",
      "ANTHROPIC_API_KEY=",
      "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
    ]);
  });

  it("leaves the base URL alone when the key is a direct Anthropic key", () => {
    expect(launchEnv(getHarness(Agent.ClaudeCode), "anthropic/claude-sonnet-4-5", "k")).toEqual([
      "ANTHROPIC_API_KEY=k",
    ]);
  });

  it("uses each provider's own variable for OpenCode", () => {
    expect(launchEnv(getHarness(Agent.OpenCode), OR_SONNET, "k")).toEqual(["OPENROUTER_API_KEY=k"]);
    expect(launchEnv(getHarness(Agent.OpenCode), "opencode/claude-sonnet-5", "k")).toEqual([
      "OPENCODE_API_KEY=k",
    ]);
  });

  it("refuses Codex on a provider that does not serve the Responses API", () => {
    expect(() => launchEnv(getHarness(Agent.Codex), "openrouter/openai/gpt-4.1", "k")).toThrow(
      /Responses API/,
    );
  });

  it("allows Codex on a direct OpenAI key", () => {
    expect(launchEnv(getHarness(Agent.Codex), "openai/gpt-5.3-codex", "k")).toEqual([
      "OPENAI_API_KEY=k",
      "CODEX_API_KEY=k",
    ]);
  });
});
