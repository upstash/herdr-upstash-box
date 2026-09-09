import { ensureRunning, openBox, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { PLUGIN_NAME } from "../constants.js";
import { ask, clearScreen, requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, type Writer } from "../result.js";
import type { StateOptions } from "../state.js";

export interface PreviewsPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  config?: PluginConfig;
  client?: BoxClient;
  write?: Writer;
  prompt?: (question: string) => Promise<string>;
  ensureRunning?: typeof ensureRunning;
}

export function parsePreviewCommand(
  answer: string,
  allowedPorts: readonly number[],
):
  | { kind: "close" }
  | { kind: "expose"; port: number }
  | { kind: "remove"; port: number }
  | { kind: "invalid" } {
  const text = answer.trim();
  if (text === "" || text === "q") return { kind: "close" };
  const remove = /^d\s*(\d+)$/.exec(text);
  const raw = remove ? remove[1] : text;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65_536) return { kind: "invalid" };
  if (!remove && !allowedPorts.includes(port)) return { kind: "invalid" };
  return remove ? { kind: "remove", port } : { kind: "expose", port };
}

// Nothing is exposed until a port is named; each URL carries basic auth unless previewAuth is none.
export async function runPreviewsPane(
  mappingId: string,
  deps: PreviewsPaneDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const write = deps.write ?? stdoutWriter;
  const prompt = deps.prompt ?? ask;
  const mapping = requireMappingById(mappingId, deps.state);
  const config = deps.config ?? loadConfig({ env });
  const box = await openBox(mapping, { client: deps.client, env });
  await (deps.ensureRunning ?? ensureRunning)(box, {
    onResume: () => write("Resuming the paused box...\n"),
  });
  for (;;) {
    clearScreen(write);
    write(`${PLUGIN_NAME} previews for ${mapping.boxName}\n\n`);
    const { publicURLs } = await box.listPublicURLs();
    if (publicURLs.length === 0) write("No public URL yet.\n");
    for (const entry of publicURLs) write(`Port ${entry.port}: ${entry.url}\n`);
    write(
      `\nConfigured ports: ${config.previewPorts.join(", ")}. Auth: ${config.previewAuth === "basic" ? "basic auth on new URLs" : "none, anyone with the link can reach it"}.\n`,
    );
    const answer = await prompt("Port to expose, d<port> to remove, Enter to close: ");
    if (answer === null) return;
    const command = parsePreviewCommand(answer, config.previewPorts);
    if (command.kind === "close") return;
    if (command.kind === "invalid") {
      write(`\nUse one of the configured ports, or d<port> to remove one.\n`);
      await prompt("Press Enter to continue. ");
      continue;
    }
    try {
      if (command.kind === "remove") {
        await box.deletePublicURL(command.port);
        write(`\nRemoved the public URL for port ${command.port}.\n`);
      } else {
        const result = await box.getPublicURL(command.port, {
          basicAuth: config.previewAuth === "basic",
        });
        write(`\nPort ${result.port}: ${result.url}\n`);
        if (result.username)
          write(`  user: ${result.username}\n  password: ${result.password ?? ""}\n`);
        if (result.token) write(`  bearer token: ${result.token}\n`);
      }
    } catch (error) {
      write(`\nCould not update the preview: ${errorMessage(error)}\n`);
    }
    await prompt("Press Enter to continue. ");
  }
}
