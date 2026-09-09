import { Agent } from "@upstash/box";
import type { HarnessId } from "./constants.js";
import { PluginError } from "./result.js";

export interface Harness {
  readonly id: HarnessId;
  readonly title: string;
  readonly bin: string;
  readonly detectionKind: string;
  readonly continueArgv: readonly string[];
}

export const HARNESSES: Readonly<Record<HarnessId, Harness>> = Object.freeze({
  "claude-code": {
    id: "claude-code",
    title: "Claude Code",
    bin: "claude",
    detectionKind: "claude",
    continueArgv: ["--continue"],
  },
  codex: {
    id: "codex",
    title: "Codex",
    bin: "codex",
    detectionKind: "codex",
    continueArgv: ["resume", "--last"],
  },
  opencode: {
    id: "opencode",
    title: "OpenCode",
    bin: "opencode",
    detectionKind: "opencode",
    continueArgv: ["--continue"],
  },
});

export function getHarness(id: string): Harness {
  const harness = (HARNESSES as Record<string, Harness>)[id];
  if (!harness) {
    throw new PluginError(
      "unsupported_harness",
      `No interactive harness for ${id}. Supported: ${Object.keys(HARNESSES).join(", ")}.`,
    );
  }
  return harness;
}

export type Provider = "openrouter" | "anthropic" | "openai" | "opencode";

export const PROVIDER_KEY_ENV: Readonly<Record<Provider, string>> = Object.freeze({
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  opencode: "OPENCODE_API_KEY",
});

// Codex speaks only the Responses API, which OpenRouter does not serve.
export const SUPPORTED_PROVIDERS: Readonly<Record<HarnessId, readonly Provider[]>> = Object.freeze({
  "claude-code": ["anthropic", "openrouter"],
  codex: ["openai"],
  opencode: ["openrouter", "opencode", "anthropic", "openai"],
});

export function providerFor(model: string): Provider {
  if (model.startsWith("openrouter/")) return "openrouter";
  if (model.startsWith("opencode/")) return "opencode";
  if (model.startsWith("openai/")) return "openai";
  if (model.startsWith("anthropic/")) return "anthropic";
  throw new PluginError("unknown_provider", `Cannot infer a provider from model id: ${model}`);
}

export function providerKeyEnv(model: string): string {
  return PROVIDER_KEY_ENV[providerFor(model)];
}

export function assertHarnessSupportsModel(harness: Harness, model: string): Provider {
  const provider = providerFor(model);
  if (SUPPORTED_PROVIDERS[harness.id].includes(provider)) return provider;
  const hint =
    harness.id === Agent.Codex
      ? "Codex speaks only the Responses API, so it needs a direct OpenAI key and an openai/ model. Or pick Claude Code or OpenCode."
      : `Use one of: ${SUPPORTED_PROVIDERS[harness.id].map((p) => `${p}/`).join(", ")}.`;
  throw new PluginError(
    "provider_unsupported_by_harness",
    `${harness.title} cannot use a ${provider} model (${model}). ${hint}`,
  );
}

// OpenCode addresses models as provider/model; the other CLIs take the bare id.
export function modelArg(harness: Harness, model: string): string {
  providerFor(model);
  if (harness.id === Agent.OpenCode) return model;
  return model.slice(model.indexOf("/") + 1);
}

export function launchEnv(harness: Harness, model: string, apiKey: string): string[] {
  const provider = assertHarnessSupportsModel(harness, model);
  switch (harness.id) {
    case Agent.ClaudeCode:
      // Claude Code 2.1+ sends ANTHROPIC_AUTH_TOKEN as Authorization: Bearer.
      // ANTHROPIC_API_KEY is x-api-key and must be blank or it falls back to Anthropic/Max.
      return provider === "openrouter"
        ? [
            `ANTHROPIC_AUTH_TOKEN=${apiKey}`,
            "ANTHROPIC_API_KEY=",
            "ANTHROPIC_BASE_URL=https://openrouter.ai/api",
          ]
        : [`ANTHROPIC_API_KEY=${apiKey}`];
    case Agent.OpenCode:
      return [`${PROVIDER_KEY_ENV[provider]}=${apiKey}`];
    case Agent.Codex:
      return [`OPENAI_API_KEY=${apiKey}`, `CODEX_API_KEY=${apiKey}`];
    default:
      throw new PluginError("unsupported_harness", `No launch environment for ${harness.id}.`);
  }
}
