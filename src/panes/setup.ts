import fs from "node:fs";
import path from "node:path";
import { BoxError } from "@upstash/box";
import { sdkClient, type BoxClient } from "../box.js";
import {
  configDirectory,
  DEFAULT_CONFIG,
  loadSecrets,
  resolveSecret,
  validateConfig,
  type PluginConfig,
} from "../config.js";
import { BOX_API_KEY_ENV, BOX_LABEL, PLUGIN_NAME, type HarnessId } from "../constants.js";
import {
  CLAUDE_OAUTH_TOKEN_ENV,
  DEFAULT_MODELS,
  getHarness,
  PROVIDER_KEY_ENV,
  providerFor,
  type Provider,
} from "../harness.js";
import { ask, askHidden, clearScreen, stdoutWriter } from "../pane-runtime.js";
import {
  captureSetupToken,
  claudeAvailable,
  isClaudeOAuthToken,
  verifyClaudeToken,
  type CaptureOptions,
  type TokenCheck,
} from "../setup-token.js";
import { errorMessage, type Writer } from "../result.js";

export { isClaudeOAuthToken } from "../setup-token.js";

export interface SetupPaneDeps {
  env?: NodeJS.ProcessEnv;
  directory?: string;
  write?: Writer;
  prompt?: (question: string) => Promise<string | null>;
  promptSecret?: (question: string) => Promise<string | null>;
  client?: BoxClient;
  claudeAvailable?: () => boolean;
  capture?: (options: CaptureOptions) => Promise<string | null>;
  verifyToken?: (token: string) => Promise<TokenCheck>;
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

// Subscription first: it is what most Claude Code users already pay for. A Console key is the
// default only when one is already present and no token is.
export function defaultClaudeCredential(
  configured: Pick<PluginConfig, "providerApiKeyEnv" | "model">,
  present: (name: string) => boolean,
): ClaudeCredential {
  if (configured.providerApiKeyEnv === CLAUDE_OAUTH_TOKEN_ENV) return "oauth";
  if (configured.providerApiKeyEnv === PROVIDER_KEY_ENV.anthropic) return "anthropic";
  if (configured.providerApiKeyEnv === PROVIDER_KEY_ENV.openrouter) return "openrouter";
  if (present(CLAUDE_OAUTH_TOKEN_ENV)) return "oauth";
  if (configured.model.startsWith("openrouter/")) return "openrouter";
  if (present(PROVIDER_KEY_ENV.anthropic)) return "anthropic";
  return "oauth";
}

async function planCredential(
  harness: HarnessId,
  configured: PluginConfig,
  present: (name: string) => boolean,
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
  const current = defaultClaudeCredential(configured, present);
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

// Runs `claude setup-token` and captures the token when Claude Code is installed here; otherwise,
// or when the capture fails, asks for a paste. Either way the token is checked before it is kept.
async function obtainSetupToken(
  name: string,
  deps: SetupPaneDeps,
  write: Writer,
  promptSecret: (question: string) => Promise<string | null>,
): Promise<string | null> {
  let token: string | null = null;
  if ((deps.claudeAvailable ?? claudeAvailable)()) {
    write(
      "\nRunning `claude setup-token`. Approve it in the browser; the token is captured here and never shown.\n\n",
    );
    token = await (deps.capture ?? captureSetupToken)({ write });
    if (token === null) write("\nNo token was captured. Paste one instead.\n");
  } else {
    write(
      "\nClaude Code is not installed on this machine. Where it is, run `claude setup-token`, approve it in the browser, and paste the token here. It is not echoed.\n",
    );
  }
  if (token === null) {
    const pasted = await promptSecret(`${name}: `);
    if (pasted === null) return null;
    token = pasted.trim();
    if (!token) return "";
    if (!isClaudeOAuthToken(token)) {
      write("\nThat is not a `claude setup-token` token; they start with sk-ant-oat.\n");
      return null;
    }
  }
  write("Checking the token with Anthropic...\n");
  const check = await (deps.verifyToken ?? verifyClaudeToken)(token);
  if (check === "invalid") {
    write(
      "\nAnthropic rejected that token. Copy it again as one line, or run `claude setup-token` again.\n",
    );
    return null;
  }
  if (check === "unknown") write("Could not reach Anthropic to check it; saving it anyway.\n");
  return token;
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

function isAuthFailure(error: unknown): boolean {
  return error instanceof BoxError && (error.statusCode === 401 || error.statusCode === 403);
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

  // Keys config.json no longer accepts (such as the removed mode) are dropped, so setup is the fix
  // for an old file rather than one more thing that fails on it.
  const rawConfig = readJsonObject(configFile);
  const dropped = Object.keys(rawConfig).filter((key) => !Object.hasOwn(DEFAULT_CONFIG, key));
  for (const key of dropped) delete rawConfig[key];
  const configured = validateConfig(rawConfig);
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
      // Only a refused key counts against the attempts; an unreachable API is not the user's fault.
      if (!isAuthFailure(error)) {
        write(`\nCould not reach the Upstash Box API: ${errorMessage(error)}\n`);
        return abort();
      }
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
  const present = (name: string) => Boolean(resolveSecret(name, { env, secrets }));
  const plan = await planCredential(harness, configured, present, prompt, write);
  if (plan === null) return abort();
  let wanted = !present(plan.name);
  if (!wanted) {
    const source = sourceOf(plan.name, env, secrets);
    const answer = await prompt(
      `\n${plan.name}: found in ${source}. Enter keeps it, r replaces it: `,
    );
    if (answer === null) return abort();
    wanted = answer.trim().toLowerCase() === "r";
    // The environment wins over secrets.json, so a replacement there would never be read.
    if (wanted && env[plan.name]?.trim()) {
      write(
        `\n${plan.name} comes from the environment Herdr runs in, which takes precedence over secrets.json. Unset it there, then run setup again.\n`,
      );
      return "aborted";
    }
  }
  if (wanted) {
    const value =
      plan.hint === "setup-token"
        ? await obtainSetupToken(plan.name, deps, write, promptSecret)
        : await promptSecret(`${plan.name}: `);
    if (value === null) return abort();
    const trimmed = value.trim();
    if (!trimmed) {
      write(`\n${plan.name} is required for this agent.\n`);
      return "aborted";
    }
    newSecrets[plan.name] = trimmed;
  }

  const nextConfig: Record<string, unknown> = {
    ...rawConfig,
    harness,
    model: plan.model,
    providerApiKeyEnv: plan.name,
  };
  if (harness !== configured.harness) nextConfig.agentArgs = [];
  validateConfig(nextConfig);
  writePrivateJson(configFile, nextConfig);
  if (Object.keys(newSecrets).length > 0) {
    writePrivateJson(secretsFile, { ...secrets, ...newSecrets });
  }

  write(`\nSaved ${configFile}\n`);
  write(
    `  harness: ${getHarness(harness).title}\n  model: ${plan.model}\n  credential: ${plan.name}\n`,
  );
  if (dropped.length > 0) write(`  removed keys no longer supported: ${dropped.join(", ")}\n`);
  if (Object.keys(newSecrets).length > 0) {
    write(`Saved ${Object.keys(newSecrets).join(", ")} to ${secretsFile} (mode 600)\n`);
  }
  write(`\nFocus a pane inside a Git worktree and run start-agent.\n`);
  return "saved";
}
