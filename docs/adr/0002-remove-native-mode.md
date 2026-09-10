# 0002: Remove native mode

Status: accepted, 2026-09-10. Decided by the maintainer.

## Context

The plugin had two modes. TUI mode runs the real Claude Code, Codex, or OpenCode terminal UI under tmux inside the box, with the provider credential passed per exec session. Native mode ran the Upstash Box CLI (`box connect`) instead, driving the box's own agent on the Box managed key, or on a provider key configured on the box when `nativeKey` was `local`.

Three actions existed only for native boxes, because they need an agent configured on the box itself, which TUI mode deliberately never does: `run-task` (a server-side run with a JSON Schema result), `run-results`, and `schedules`.

## Decision

There is one way to run the agent: its own terminal UI, which is what TUI mode was. `mode` is not a setting any more.

Removed with it:

- the `native` pane and the `@upstash/box-cli` dependency it spawned
- `run-task`, `run-results`, `schedules`, their panes, the dashboard keys `t`, `h`, `c`, and the `SCHED` and `MODE` columns
- the config keys `mode`, `nativeKey`, `boxBin`, `agentRunTimeoutMs`, `scheduleTimeoutMs`, `maxRunResultBytes`, `runHistoryLimit`
- the `mode` and `credential` fields on a mapping
- fork's native branch; a fork now carries no credential, like every other box

## Consequences

- No box the plugin creates has an agent or a key configured on it. ADR 0001 decision 4, credentials stay out of the box, now holds without exception.
- Every start needs a provider credential on this machine. There is no managed-key path, so nobody can use the plugin without their own subscription token or API key.
- An old `config.json` carrying any removed key fails with `Unknown config keys`. Running `setup` rewrites the file without them and says which it dropped.
- A mapping written before this change still loads; its extra fields are ignored and it behaves as a TUI mapping. A box that was created in native mode keeps its agent configuration on the Box side, but the plugin no longer uses it.
- `automation.json` in the plugin state directory is no longer read or written. It can be deleted.
- Bringing typed runs or schedules back would mean configuring an agent and a credential on the box, which reverses ADR 0001 decision 4. That needs its own page.
