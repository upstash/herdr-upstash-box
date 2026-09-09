import type { Schedule } from "@upstash/box";
import {
  assertNativeAutomationMapping,
  syncScheduledRuns,
  syncSchedules,
  type AutomationOptions,
} from "../automation.js";
import { openBox, type BoxClient } from "../box.js";
import { loadConfig, type PluginConfig } from "../config.js";
import { ask, clearScreen, requireMappingById, stdoutWriter } from "../pane-runtime.js";
import { errorMessage, PluginError, type Writer } from "../result.js";
import { readState, withMappingLock, type StateOptions } from "../state.js";
import { remoteWorkingDirectory } from "../start.js";

export type ScheduleCommand =
  | { kind: "close" }
  | { kind: "create"; cron: string; prompt: string }
  | { kind: "pause" | "resume" | "delete"; id: string }
  | { kind: "invalid" };

export function parseScheduleCommand(answer: string): ScheduleCommand {
  const text = answer.trim();
  if (text === "" || text === "q") return { kind: "close" };
  const create = /^(?:c|create)\s+(.+?)\s*\|\s*(.+)$/s.exec(text);
  if (create) {
    const cron = create[1]?.trim() ?? "";
    const prompt = create[2]?.trim() ?? "";
    if (cron && prompt && !/[\r\n]/.test(cron) && !/[\r\n]/.test(prompt)) {
      return { kind: "create", cron, prompt };
    }
  }
  const mutation = /^(p|pause|r|resume|d|delete)\s+(\S+)$/.exec(text);
  if (!mutation) return { kind: "invalid" };
  const verb = mutation[1] ?? "";
  const kind =
    verb === "p" || verb === "pause"
      ? "pause"
      : verb === "r" || verb === "resume"
        ? "resume"
        : "delete";
  return { kind, id: mutation[2] ?? "" };
}

export function resolveScheduleId(schedules: Schedule[], value: string): string {
  const exact = schedules.find((schedule) => schedule.id === value);
  if (exact) return exact.id;
  const matches = schedules.filter((schedule) => schedule.id.startsWith(value));
  if (matches.length === 1) return matches[0]?.id ?? value;
  if (matches.length === 0) {
    throw new PluginError("schedule_not_found", `No schedule matches ${value}.`);
  }
  throw new PluginError(
    "ambiguous_schedule_id",
    `Schedule prefix ${value} is ambiguous: ${matches.map((schedule) => schedule.id).join(", ")}.`,
  );
}

export interface SchedulesPaneDeps {
  env?: NodeJS.ProcessEnv;
  state?: StateOptions;
  automation?: AutomationOptions;
  config?: PluginConfig;
  client?: BoxClient;
  write?: Writer;
  prompt?: (question: string) => Promise<string>;
  openBox?: typeof openBox;
}

async function mutateSchedule(
  mappingId: string,
  command: Exclude<ScheduleCommand, { kind: "close" | "invalid" }>,
  listed: Schedule[],
  deps: SchedulesPaneDeps,
): Promise<void> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig({ env });
  const prompt = deps.prompt ?? ask;
  const selectedId = command.kind === "create" ? null : resolveScheduleId(listed, command.id);
  if (command.kind === "delete") {
    const confirmation = await prompt(`Type DELETE to delete schedule ${selectedId}: `);
    if (confirmation?.trim() !== "DELETE") return;
  }
  await withMappingLock(mappingId, deps.state ?? { env }, async () => {
    const mapping = readState(deps.state ?? { env }).mappings[mappingId];
    if (!mapping)
      throw new PluginError("mapping_not_found", `Mapping ${mappingId} no longer exists.`);
    assertNativeAutomationMapping(mapping);
    if (command.kind === "create" && !mapping.prepared) {
      throw new PluginError(
        "mapping_not_prepared",
        "The box has no upload baseline yet. Reconnect first so preparation can finish.",
      );
    }
    const box = await (deps.openBox ?? openBox)(mapping, { client: deps.client, env });
    if (command.kind === "create") {
      await box.schedule.agent({
        cron: command.cron,
        prompt: command.prompt,
        folder: remoteWorkingDirectory(mapping),
        model: mapping.model,
        timeout: config.scheduleTimeoutMs,
      });
      return;
    }
    // Revalidate against the live list after taking the operation lock. The row shown
    // before confirmation may have changed while the user was deciding.
    const scheduleId = selectedId ?? "";
    if (!(await box.schedule.list()).some((schedule) => schedule.id === scheduleId)) {
      throw new PluginError("schedule_not_found", `Schedule ${scheduleId} no longer exists.`);
    }
    if (command.kind === "delete") {
      await box.schedule.delete(scheduleId);
    } else if (command.kind === "pause") {
      await box.schedule.pause(scheduleId);
    } else {
      await box.schedule.resume(scheduleId);
    }
  });
}

function renderSchedules(write: Writer, boxName: string, schedules: Schedule[]): void {
  write(`Agent schedules for ${boxName} (cron is UTC)\n\n`);
  if (schedules.length === 0) write("No schedules.\n");
  for (const schedule of schedules) {
    write(
      `${schedule.id}  ${schedule.status.padEnd(6)}  ${schedule.cron}  ${schedule.prompt ?? schedule.command?.join(" ") ?? ""}\n`,
    );
  }
  write(
    "\nCommands: c <cron> | <prompt>  p <id/prefix>  r <id/prefix>  d <id/prefix>  q\n" +
      "A cron wakes an idle or paused box. Scheduled work can incur model and compute costs; its output is untyped.\n",
  );
}

export async function runSchedulesPane(
  mappingId: string,
  deps: SchedulesPaneDeps = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  const config = deps.config ?? loadConfig({ env });
  const write = deps.write ?? stdoutWriter;
  const prompt = deps.prompt ?? ask;
  const initial = requireMappingById(mappingId, deps.state ?? { env });
  assertNativeAutomationMapping(initial);
  for (;;) {
    const mapping = requireMappingById(mappingId, deps.state ?? { env });
    assertNativeAutomationMapping(mapping);
    const box = await (deps.openBox ?? openBox)(mapping, { client: deps.client, env });
    const [schedules, runs] = await Promise.all([box.schedule.list(), box.listRuns()]);
    await Promise.all([
      syncSchedules(mappingId, schedules, {
        ...deps.state,
        ...deps.automation,
        env: deps.automation?.env ?? deps.state?.env ?? env,
      }),
      syncScheduledRuns(mapping, runs, {
        ...deps.state,
        ...deps.automation,
        env: deps.automation?.env ?? deps.state?.env ?? env,
        historyLimit: config.runHistoryLimit,
        maxResultBytes: config.maxRunResultBytes,
      }),
    ]);
    clearScreen(write);
    renderSchedules(write, mapping.boxName, schedules);
    const answer = await prompt("Schedule command: ");
    if (answer === null) return;
    const command = parseScheduleCommand(answer);
    if (command.kind === "close") return;
    if (command.kind === "invalid") {
      write("\nInvalid schedule command.\n");
      await prompt("Press Enter to continue. ");
      continue;
    }
    try {
      await mutateSchedule(mappingId, command, schedules, deps);
    } catch (error) {
      write(`\nCould not update the schedule: ${errorMessage(error)}\n`);
      await prompt("Press Enter to continue. ");
    }
  }
}
