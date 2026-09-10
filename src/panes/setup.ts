import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { sdkClient, type BoxClient } from "../box.js";
import {
  configDirectory,
  loadConfig,
  loadSecrets,
  resolveSecret,
  validateConfig,
  type PluginConfig,
} from "../config.js";
import {
  BOX_API_KEY_ENV,
  BOX_LABEL,
  PLUGIN_NAME,
  type HarnessId,
  type Mode,
} from "../constants.js";
import {
  CLAUDE_OAUTH_TOKEN_ENV,
  DEFAULT_MODELS,
  getHarness,
  PROVIDER_KEY_ENV,
  providerFor,
  type Provider,
} from "../harness.js";
import { ask, askHidden, clearScreen, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, type Writer } from "../result.js";

export interface SetupPaneDeps {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  write?: Writer;
  prompt?: (question: string) => Promise<string | null>;
  promptSecret?: (question: string) => Promise<string | null>;
  client?: BoxClient;
  claudeOnPath?: () => boolean;
  runSetupToken?: () => number;
}

export type SetupOutcome = "saved" | "aborted";

const KEY_ATTEMPTS = 3;

interface Choice<T extends string> {
  value: T;
  label: string;
}

const HARNESS_CHOICES: readonly Choice<HarnessId>[] = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "opencode", label: "OpenCode" },
];

const MODE_CHOICES: readonly Choice<Mode>[] = [
  { value: "tui", label: "TUI: the agent's own terminal UI, using your provider credential" },
  { value: "native", label: "Native: the Upstash Box CLI on the managed key, no provider key" },
];

type ClaudeCredential = "oauth" | "anthropic" | "openrouter";

const CLAUDE_CREDENTIAL_CHOICES: readonly Choice<ClaudeCredential>[] = [
  { value: "oauth", label: "Claude subscription token, from `claude setup-token`" },
  { value: "anthropic", label: "Anthropic API key" },
  { value: "openrouter", label: "OpenRouter API key" },
];

const OPENCODE_PROVIDER_CHOICES: readonly Choice<Provider>[] = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
];

function claudeOnPath(): boolean {
  return spawnSync("sh", ["-c", "command -v claude >/dev/null 2>&1"]).status === 0;
}

function runSetupToken(): number {
  return spawnSync("claude", ["setup-token"], { stdio: "inherit" }).status ?? 1;
}

// A blank answer keeps the current value; a number picks; anything else asks again.
export async function choose<T extends string>(
  prompt: (question: string) => Promise<string | null>,
  write: Writer,
  title: string,
  choices: readonly Choice<T>[],
  current: T,
): Promise<T | null> {
  for (;;) {
    write(`\n${title}\n`);
    for (const [index, choice] of choices.entries()) {
      const marker = choice.value === current ? " (current)" : "";
      write(`  [${index + 1}] ${choice.label}${marker}\n`);
    }
    const answer = await prompt("Choice (Enter keeps current): ");
    if (answer === null) return null;
    const text = answer.trim();
    if (text === "") return current;
    const picked = choices[Number(text) - 1];
    if (picked) return picked.value;
    write("Enter one of the numbers shown.\n");
  }
}

// Keeps a configured model when it belongs to the chosen provider, else the harness default.
export function modelFor(harness: HarnessId, provider: Provider, configured: string): string {
  try {
    if (providerFor(configured) === provider) return configured;
  } catch {
    // An unparseable configured model falls through to the default.
  }
  if (provider === "openrouter") return "openrouter/anthropic/claude-sonnet-5";
  if (provider === "openai") return "openai/gpt-5.6";
  if (provider === "opencode") return "opencode/claude-sonnet-5";
  return DEFAULT_MODELS[harness];
}

interface CredentialPlan {
  name: string;
  model: string;
  hint: string | null;
}

async function planCredential(
  harness: HarnessId,
  configured: PluginConfig,
  prompt: (question: string) => Promise<string | null>,
  write: Writer,
): Promise<CredentialPlan | null> {
  if (harness === "codex") {
    return {
      name: PROVIDER_KEY_ENV.openai,
      model: modelFor(harness, "openai", configured.model),
      hint: null,
    };
  }
  if (harness === "opencode") {
    const current = ((): Provider => {
      try {
        return providerFor(configured.model);
      } catch {
        return "openrouter";
      }
    })();
    const provider = await choose(prompt, write, "Provider", OPENCODE_PROVIDER_CHOICES, current);
    if (provider === null) return null;
    return {
      name: PROVIDER_KEY_ENV[provider],
      model: modelFor(harness, provider, configured.model),
      hint: null,
    };
  }
  const current: ClaudeCredential =
    configured.providerApiKeyEnv === CLAUDE_OAUTH_TOKEN_ENV
      ? "oauth"
      : configured.model.startsWith("openrouter/")
        ? "openrouter"
        : "anthropic";
  const credential = await choose(prompt, write, "Credential", CLAUDE_CREDENTIAL_CHOICES, current);
  if (credential === null) return null;
  if (credential === "oauth") {
    return {
      name: CLAUDE_OAUTH_TOKEN_ENV,
      model: modelFor(harness, "anthropic", configured.model),
      hint: "setup-token",
    };
  }
  return {
    name: PROVIDER_KEY_ENV[credential],
    model: modelFor(harness, credential, configured.model),
    hint: null,
  };
}

function readJsonObject(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function writePrivateJson(file: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function sourceOf(name: string, env: NodeJS.ProcessEnv, secrets: Record<string, string>): string {
  return env[name]?.trim() ? "the environment" : secrets[name] ? "secrets.json" : "nowhere";
}

export async function runSetupPane(deps: SetupPaneDeps = {}): Promise<SetupOutcome> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? stdoutWriter;
  const prompt = deps.prompt ?? ask;
  const promptSecret = deps.promptSecret ?? askHidden;
  const client = deps.client ?? sdkClient;
  const directory = deps.directory ?? configDirectory(env);
  const secretsFile = path.join(directory, "secrets.json");
  const configFile = path.join(directory, "config.json");

  clearScreen(write);
  write(`Set up ${PLUGIN_NAME}\n\nConfig directory: ${directory}\n`);

  const configured = loadConfig({ directory });
  const secrets: Record<string, string> = { ...loadSecrets({ directory }) };
  const newSecrets: Record<string, string> = {};

  const abort = (): SetupOutcome => {
    write("\nSetup stopped. Nothing was written.\n");
    return "aborted";
  };

  // Box key first: nothing else is worth asking until it validates.
  let boxKey = resolveSecret(BOX_API_KEY_ENV, { env, secrets });
  if (boxKey)
    write(`\nUpstash Box API key: found in ${sourceOf(BOX_API_KEY_ENV, env, secrets)}.\n`);
  let validated = false;
  for (let attempt = 0; attempt < KEY_ATTEMPTS && !validated; attempt += 1) {
    if (!boxKey) {
      const entered = await promptSecret("Upstash Box API key: ");
      if (entered === null) return abort();
      boxKey = entered.trim();
      if (!boxKey) continue;
    }
    write("Checking the key...\n");
    try {
      await client.list(boxKey, BOX_LABEL);
      validated = true;
      if (!resolveSecret(BOX_API_KEY_ENV, { env, secrets })) newSecrets[BOX_API_KEY_ENV] = boxKey;
    } catch (error) {
      write(`That key was rejected: ${errorMessage(error)}\n`);
      boxKey = undefined;
    }
  }
  if (!validated) {
    write("\nNo working Upstash Box API key. Get one from the console and run setup again.\n");
    return "aborted";
  }

  const harness = await choose(prompt, write, "Agent", HARNESS_CHOICES, configured.harness);
  if (harness === null) return abort();
  const mode = await choose(prompt, write, "Mode", MODE_CHOICES, configured.mode);
  if (mode === null) return abort();

  let model = harness === configured.harness ? configured.model : DEFAULT_MODELS[harness];
  let providerApiKeyEnv: string | null = null;
  if (mode === "tui") {
    const plan = await planCredential(harness, configured, prompt, write);
    if (plan === null) return abort();
    model = plan.model;
    providerApiKeyEnv = plan.name;
    const existing = resolveSecret(plan.name, { env, secrets });
    if (existing) {
      write(`\n${plan.name}: found in ${sourceOf(plan.name, env, secrets)}.\n`);
    } else {
      if (plan.hint === "setup-token") {
        if ((deps.claudeOnPath ?? claudeOnPath)()) {
          write(
            "\nRunning `claude setup-token`. Approve it in the browser, then paste the token here.\n\n",
          );
          (deps.runSetupToken ?? runSetupToken)();
        } else {
          write(
            "\nClaude Code is not installed here. Run `claude setup-token` on a machine where it is, then paste the token.\n",
          );
        }
      }
      const value = await promptSecret(`${plan.name}: `);
      if (value === null) return abort();
      if (!value.trim()) {
        write(`\n${plan.name} is required for TUI mode with this agent.\n`);
        return "aborted";
      }
      newSecrets[plan.name] = value.trim();
    }
  }

  const rawConfig = readJsonObject(configFile);
  const nextConfig: Record<string, unknown> = {
    ...rawConfig,
    mode,
    harness,
    model,
    providerApiKeyEnv,
  };
  if (harness !== configured.harness) nextConfig.agentArgs = [];
  validateConfig(nextConfig);
  writePrivateJson(configFile, nextConfig);
  if (Object.keys(newSecrets).length > 0) {
    writePrivateJson(secretsFile, { ...secrets, ...newSecrets });
  }

  write(`\nSaved ${configFile}\n`);
  write(`  mode: ${mode}\n  harness: ${getHarness(harness).title}\n  model: ${model}\n`);
  if (providerApiKeyEnv) write(`  credential: ${providerApiKeyEnv}\n`);
  if (Object.keys(newSecrets).length > 0) {
    write(`Saved ${Object.keys(newSecrets).join(", ")} to ${secretsFile} (mode 600)\n`);
  }
  write(`\nFocus a pane inside a Git worktree and run start-agent.\n`);
  return "saved";
}
