# 0001: Provider credentials

Status: accepted, 2026-09-10.

## Context

TUI mode runs the real Claude Code, Codex, or OpenCode inside the box, and those need a credential for the model provider. Native mode runs on the Upstash Box managed key and needs none. Until now the only accepted Claude credential was `ANTHROPIC_API_KEY`, a Console key billed per token. Most people running Claude Code already pay for a Pro or Max subscription, so asking for a Console key asks them to pay twice, and a reviewer said outright that nobody would use it at that price.

Two other plugins in the same space (e2b, Fly Sprites) accept a subscription token and, in Fly's case, copy a local login into the sandbox by default.

## Decision

1. **A subscription token is a first-class credential.** `CLAUDE_CODE_OAUTH_TOKEN`, produced by `claude setup-token`, is accepted for Claude Code on `anthropic/` models and injected under its own name. It is tried before `ANTHROPIC_API_KEY`.
2. **The credential in force is explicit or ordered, never guessed.** With `providerApiKeyEnv` set, only that variable is read and a missing value is an error. Without it, the plugin tries an ordered list that fits the harness and model. There is no fallback to "whatever is set", so a session cannot bill an account the user did not pick.
3. **Competing variables are blanked.** Whichever Claude credential is in force, the other Claude auth variables are set to empty on the exec session, so nothing inherited from the image or a previous session can win.
4. **Credentials stay out of the box.** They travel only as environment of the exec session, never into the box filesystem, box creation, or a snapshot. Setup reads keys without echo so they never land in a pane scrollback.
5. **`secrets.json` is ours to keep private.** The plugin tightens a loose file to mode 600 rather than refusing it, because it never wrote the file in the first place and an editor leaves it at 644.

## Consequences

- `setup` can offer the subscription option first and run `claude setup-token` when Claude Code is installed locally.
- `start-codex` and `start-opencode` drop `providerApiKeyEnv`, since a variable named for Claude Code is wrong for another harness.
- Decision 4 is what stops us copying a local login the way Fly does. Doing that would put a host credential on the box filesystem and in every snapshot. It is deferred, not rejected; if it is adopted it must be opt-in, this page must be superseded, and the README promise about credentials never reaching the box must change in the same commit.
