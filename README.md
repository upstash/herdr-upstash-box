# Upstash Box Herdr plugin

Run a coding agent in an Upstash Box from the worktree you are looking at in [Herdr](https://herdr.dev).

Focus a pane inside a Git worktree, invoke **Start agent in Upstash Box**, and the plugin creates a box, uploads a filtered copy of the worktree, opens a new pane, and puts the agent in it. Close the pane and the agent keeps running. Come back with **Reconnect**, and a box that idled and paused in the meantime resumes on its own. When the agent has done something, **Apply changes** brings its edits back as a checked Git patch.

## Two ways to sit in front of the agent

|                       | TUI mode (default)                                                                         | Native mode                                                         |
| --------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| What runs in the pane | The real Claude Code, Codex, or OpenCode terminal UI, kept alive under tmux inside the box | The Upstash Box CLI REPL, driving the box's own agent               |
| Credential            | Your provider API key, passed into each session and never handed to the box                | The Box managed key. Set `nativeKey` to `local` to use your own key |
| Herdr agent detection | Real, through `HERDR_AGENT`                                                                | Not available                                                       |
| Needs                 | A provider key on this machine                                                             | The `box` CLI on this machine                                       |

Pick with `mode` in the config.

## Requirements

- Herdr 0.8.0 or newer
- Node.js 22 or newer
- Git and tar
- An Upstash Box API key
- TUI mode: an API key for the model's provider (Anthropic, OpenRouter, OpenAI, or OpenCode)
- Nothing else: the Box SDK and the `box` CLI that native mode runs are installed with the plugin

## Install

```bash
herdr plugin install upstash/herdr-upstash-box
```

The install step fetches the Box SDK and CLI and compiles the plugin, so nothing needs to be on your `PATH`.

To work on it locally instead:

```bash
git clone https://github.com/upstash/herdr-upstash-box
cd herdr-upstash-box
npm install
npm run build
herdr plugin link "$(pwd)"
```

## Set up

```bash
herdr plugin action invoke setup --plugin upstash.box
```

Setup opens a popup that asks for your Upstash Box API key and checks it against the API before anything else, then asks which agent, which mode, and which provider credential to use, and writes `config.json` and `secrets.json` (mode 600) for you. Keys are typed without echo, so nothing lands in the scrollback. If Claude Code is installed locally and you pick the subscription option, setup runs `claude setup-token` for you and stores the token it produces.

Everything setup writes can also be written by hand, as below.

Keys can come from the environment Herdr runs in, or from a `secrets.json` in the plugin config directory. The environment is enough when you start Herdr from a terminal; the file exists because Herdr launched from the Dock or Spotlight does not inherit your shell exports.

```bash
herdr plugin config-dir upstash.box
```

```json
{
  "UPSTASH_BOX_API_KEY": "...",
  "CLAUDE_CODE_OAUTH_TOKEN": "...",
  "ANTHROPIC_API_KEY": "...",
  "OPENROUTER_API_KEY": "..."
}
```

`CLAUDE_CODE_OAUTH_TOKEN` is a subscription token from `claude setup-token`, so a Claude Pro or Max plan can drive Claude Code in the box without a pay-per-token Console key. For Claude Code on an `anthropic/` model the plugin looks for `CLAUDE_CODE_OAUTH_TOKEN` first and `ANTHROPIC_API_KEY` second. Set `providerApiKeyEnv` to name one variable outright; then only that variable is read, and a missing value is an error rather than a fallback to some other key, so a session can never bill an account you did not choose. Whichever credential is in force, the competing Claude variables are blanked on the exec session so nothing inherited from the image can win.

Environment variables win over the file. The file must be a regular file that you own; if other users can read it, the plugin tightens it to mode 600 before reading.

## Configure

Create `config.json` in the same directory. Every key is optional.

```json
{
  "mode": "tui",
  "harness": "claude-code",
  "model": "anthropic/claude-sonnet-5",
  "agentArgs": [],
  "nativeKey": "managed",
  "runtime": "node",
  "size": "small",
  "keepAlive": false,
  "boxNamePrefix": "herdr",
  "remoteRoot": "/workspace/home/worktree",
  "boxBin": null,
  "providerApiKeyEnv": null,
  "allowMultipleBoxes": false,
  "excludedPaths": [],
  "allowSensitivePaths": [],
  "maxFiles": 10000,
  "maxFileBytes": 10485760,
  "maxUploadBytes": 104857600,
  "maxPatchBytes": 52428800,
  "agentRunTimeoutMs": 600000,
  "scheduleTimeoutMs": 600000,
  "maxRunResultBytes": 262144,
  "runHistoryLimit": 50,
  "previewPorts": [3000, 5173, 8000],
  "previewAuth": "basic"
}
```

| Setting               | Default                     | Purpose                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                | `tui`                       | `tui` runs the harness terminal UI, `native` runs the Box CLI REPL.                                                                                                                                                                                                                       |
| `harness`             | `claude-code`               | `claude-code`, `codex`, or `opencode`. Already installed in every box image.                                                                                                                                                                                                              |
| `model`               | `anthropic/claude-sonnet-5` | A Box model id with its provider prefix. Claude Code takes `anthropic/` and `openrouter/` models. Codex needs an `openai/` model. OpenCode takes any. Incompatible pairs fail at config time.                                                                                             |
| `agentArgs`           | `[]`                        | Extra arguments appended to the harness command in TUI mode. `["--dangerously-skip-permissions"]` lets Claude Code edit without approving each change, which is reasonable in a disposable box with a scoped key and wrong on a laptop; it is never the default for an interactive start. |
| `nativeKey`           | `managed`                   | Native mode credential. `managed` uses the Box managed key. `local` configures your provider key on the box at creation.                                                                                                                                                                  |
| `runtime`             | `node`                      | Box runtime image.                                                                                                                                                                                                                                                                        |
| `size`                | `small`                     | `small`, `medium`, or `large`.                                                                                                                                                                                                                                                            |
| `keepAlive`           | `false`                     | Keep the box running instead of letting it pause when idle.                                                                                                                                                                                                                               |
| `boxNamePrefix`       | `herdr`                     | Prefix for generated box names.                                                                                                                                                                                                                                                           |
| `remoteRoot`          | `/workspace/home/worktree`  | Where the worktree lands in the box. Must stay under `/workspace`. A subdirectory keeps the agent's own config directories out of the Git baseline.                                                                                                                                       |
| `boxBin`              | `null`                      | Path to a `box` CLI for native mode. Defaults to the one installed with the plugin; `HERDR_BOX_BIN` also overrides it.                                                                                                                                                                    |
| `providerApiKeyEnv`   | `null`                      | Name the one variable that carries the provider credential. By default the plugin tries the variables that fit the harness and model, subscription token first for Claude Code. Set this and nothing else is ever substituted.                                                            |
| `allowMultipleBoxes`  | `false`                     | Allow more than one live box per worktree. Off by default, so a second Start points you at the existing box.                                                                                                                                                                              |
| `excludedPaths`       | `[]`                        | Extra repository-relative paths left out of the upload.                                                                                                                                                                                                                                   |
| `allowSensitivePaths` | `[]`                        | Exact files the safety filter would otherwise exclude.                                                                                                                                                                                                                                    |
| `maxFiles`            | `10000`                     | Upload file count limit.                                                                                                                                                                                                                                                                  |
| `maxFileBytes`        | `10485760`                  | Per-file upload limit, 10 MiB.                                                                                                                                                                                                                                                            |
| `maxUploadBytes`      | `104857600`                 | Total upload limit, 100 MiB.                                                                                                                                                                                                                                                              |
| `maxPatchBytes`       | `52428800`                  | Largest patch Apply will download from the box, 50 MiB.                                                                                                                                                                                                                                   |
| `agentRunTimeoutMs`   | `600000`                    | Timeout for an interactive typed agent run.                                                                                                                                                                                                                                               |
| `scheduleTimeoutMs`   | `600000`                    | Timeout applied when creating an agent schedule.                                                                                                                                                                                                                                          |
| `maxRunResultBytes`   | `262144`                    | Maximum serialized result retained for one run; larger results are marked and truncated.                                                                                                                                                                                                  |
| `runHistoryLimit`     | `50`                        | Persisted manual and scheduled run records retained per mapping.                                                                                                                                                                                                                          |
| `previewPorts`        | `[3000, 5173, 8000]`        | Ports the previews pane may expose with a public URL.                                                                                                                                                                                                                                     |
| `previewAuth`         | `basic`                     | `basic` puts basic auth on every new public URL. `none` makes the link reachable by anyone who has it.                                                                                                                                                                                    |

Unknown keys and invalid values stop the action with a named error.

## Use

```bash
herdr plugin action invoke setup --plugin upstash.box
herdr plugin action invoke start-agent --plugin upstash.box
herdr plugin action invoke start-claude --plugin upstash.box
herdr plugin action invoke start-codex --plugin upstash.box
herdr plugin action invoke start-opencode --plugin upstash.box
herdr plugin action invoke reconnect --plugin upstash.box
herdr plugin action invoke apply-changes --plugin upstash.box
herdr plugin action invoke info --plugin upstash.box
herdr plugin action invoke stop --plugin upstash.box
herdr plugin action invoke delete-box --plugin upstash.box
herdr plugin action invoke pause --plugin upstash.box
herdr plugin action invoke resume --plugin upstash.box
herdr plugin action invoke snapshot --plugin upstash.box
herdr plugin action invoke fork --plugin upstash.box
herdr plugin action invoke previews --plugin upstash.box
herdr plugin action invoke dashboard --plugin upstash.box
herdr plugin action invoke run-task --plugin upstash.box
herdr plugin action invoke run-results --plugin upstash.box
herdr plugin action invoke schedules --plugin upstash.box
```

A binding for Start:

```toml
[[keys.command]]
key = "prefix+shift+u"
command = "herdr plugin action invoke start-agent --plugin upstash.box"
```

**Start claude**, **Start codex**, and **Start opencode** are Start on a named harness for one launch, meant for key bindings: `config.json` is not touched, the configured model is kept when that harness can use it and otherwise the harness default applies, and `agentArgs` and `providerApiKeyEnv` are dropped because they were written for the configured harness. Herdr cannot pass arguments to an action, which is why these are three verbs rather than one flag.

**Start** checks the worktree, refuses if a box already exists for it, then splits the focused pane, creates a box named after the worktree, uploads the filtered tree, records a Git baseline in the box, and opens the agent. **Reconnect** attaches again from any pane the mapping knows, resuming a paused box first and finishing any preparation a crash interrupted. **Apply changes** exports what changed in the box since the last apply as a binary Git patch, checks it against the worktree, shows the summary, and applies it after you say yes. **Stop** ends the agent session and keeps the box. **Delete** asks you to type `DELETE` in a popup, then removes the box and its mapping. **Info** shows the box status, agent session, paths, and export markers. In native mode the REPL opens in the box home; the worktree is in `worktree` there.

**Pause** ends the agent session and pauses the box; **Resume** brings it back without opening the agent. An active schedule can wake a paused box at its next cron and incur compute and model costs. **Snapshot** saves the box state under a timestamped name. **Fork** asks you to type `FORK`, snapshots the box, and starts a second box from that snapshot for the same worktree, with its own mapping, so two directions can run from the same point. **Previews** exposes one of the configured ports with a public URL, with basic auth by default, and removes it again. **Dashboard** opens a zoomed board of every box the plugin owns.

**Run task**, **Run results**, and **Schedules** are server-side automation and only work with native-mode mappings. Actions reject TUI mappings before opening a pane. Run task asks for a one-line prompt and one-line JSON Schema, converts the schema with Zod, runs from the mapped remote working directory, and persists the typed result and cost. Press Ctrl-C while a task runs to cancel it; one typed run per box at a time, and a typed run is never retried automatically, because the SDK would treat the cancelled stream as a failure and start a fresh billed run. Run results syncs scheduled Box run records, marks any run whose pane never came back as failed, and shows recent manual and scheduled history. Automation history lives in a separate private, atomically-written `automation.json` with mode 600. At the default limits it can hold about 12 MB of agent output; lower `runHistoryLimit` or `maxRunResultBytes` if that matters.

Schedules use textual commands in the popup: `c <cron> | <prompt>`, `p <id>`, `r <id>`, and `d <id>`. They work on normal idle-pausing boxes: the scheduler wakes a paused box when a cron fires. Scheduled agents can therefore incur model and compute costs even while Herdr is closed. Their output is stored as plain untyped output because the SDK schedule API does not accept a `responseSchema`.

Herdr shows one popup at a time. If a verb reports that another popup is already open, close that popup and run it again. A popup left unattended closes itself after two minutes so it cannot block the other verbs.

## Dashboard

The board lists every mapping newest first, with worktree and branch, box name, agent, mode, local lifecycle, live remote status, and age, and refreshes the remote column every few seconds. Boxes that carry the plugin label but have no mapping appear as orphans and can only be deleted. Every verb is one key away and opens the same pane the matching action would:

```
[j/k] Select  [enter/r] Reconnect  [a] Apply  [i] Info  [s] Stop  [p] Pause  [u] Resume
[n] Snapshot  [f] Fork  [v] Previews  [t] Run task  [h] Results  [c] Schedules
[d] Delete  [R] Refresh  [q] Close
```

A binding for it:

```toml
[[keys.command]]
key = "prefix+shift+b"
command = "herdr plugin action invoke dashboard --plugin upstash.box"
```

## What gets uploaded

The upload is `git ls-files` plus untracked files, minus what `.gitignore` ignores, minus:

- `.git`, dependency and build directories, `.aws`, `.ssh`, `.gnupg`
- `.env` files except examples and samples
- credential files by name and extension, such as `id_rsa`, `.npmrc`, `.pem`
- text files that contain a private key block or a recognisable API token
- symlinks and anything that is not a regular file

The start pane lists every excluded file with its reason before the box is created. Use `allowSensitivePaths` for an exact file you want anyway, and `excludedPaths` for more to leave out.

## How it works

Decisions with a rationale worth keeping live in [docs/adr](docs/adr/README.md).

- One mapping connects a Start invocation, a local worktree, a Herdr pane, and a box. When more than one box matches a pane or a worktree, actions refuse to guess and point you at the dashboard; a fork always leaves two, so pick boxes there afterwards. Mappings live in the plugin state directory. Boxes carry both a `herdr` label and a `hm:<mapping id>` label, so a mapping can find its box again even if the state file is lost, and recovery refuses to guess when more than one box matches. The dashboard only calls a box an orphan when it carries both labels and no mapping claims it by id, label, or name, and deletion re-checks that against fresh state.
- Attaching Claude Code seeds its config in the box first, marking onboarding complete and the worktree trusted. A fresh box otherwise opens on a theme picker, then security notes, then a trust prompt whose default is to exit.
- In TUI mode the agent runs inside a tmux session on a tmux server private to the mapping. A Box exec session owns its process, so without tmux closing the pane would kill the agent. tmux is installed on first launch if the image lacks it.
- Provider keys are passed as environment of the exec session only. They never reach the box environment, its filesystem, or a snapshot, and they are never part of box creation in TUI mode.
- Every pane claims the mapping with a connection token. Stop, delete, and reconnect clear or replace it, so a pane that exits later cannot overwrite what they recorded.
- Every interactive mutating verb runs under a per-mapping lock, so stop, pause, resume, snapshot, apply, delete, fork, and schedule changes cannot interleave and write each other's outcome. A second one is refused rather than queued. A typed run holds the lock only while it starts and while it records its result, never during the model call, so stop, pause, and delete stay available while it runs, and Ctrl-C in its pane cancels it through the box's run id. A scheduled run is independent background work, so pause it before taking a deliberately stable snapshot or patch.
- A fork records its mapping before anything billable exists, carries the credential mode of the box it came from rather than today's config, and gets no source pane.
- Applying a patch also refuses added content that looks like a credential, not just sensitive paths.
- Idle boxes pause, and tmux does not survive a pause. Reconnect resumes the box and relaunches the harness with its continue flag, so the conversation carries on from disk.
- Server-side schedules wake idle or paused native-mode boxes at their next cron. The dashboard's `SCHED` column shows locally synchronized active and paused counts; opening Schedules or Results refreshes those records from Box.
- Before the archive is built, every reviewed file is copied into a private staging tree through a no-follow descriptor and checked against the size and hash from the preview. Anything that changed in between stops the start.
- The worktree travels as one tar archive, unpacks into a sibling directory in the box, and is swapped into place only after extraction succeeds. A fresh Git repository there records the upload as a baseline commit.
- Apply snapshots the box tree as a new commit, diffs it against the last applied commit, and downloads the patch to disk in bounded chunks, refusing anything above `maxPatchBytes`. The bytes are bound to that commit by a checksum computed in the box.
- Incoming patches obey the upload rules: no symlinks, and no env or credential paths unless listed in `allowSensitivePaths`. The patch applies locally only when `git apply --check` passes, and one Apply runs per box at a time.

## Status

All four phases are done: the lifecycle and both panes, worktree upload and patch-back, the dashboard with pause, resume, previews, snapshots and fork, and server-side typed runs and schedules. Every phase was verified against real boxes, and the whole thing was driven end to end inside a live Herdr session.

Native mode needs `@upstash/box` 0.7.5 or newer to cancel a typed run cleanly; on 0.7.4 a cancelled run is retried once by the SDK. The plugin already passes `maxRetries: 0`, so it is unaffected either way.

## Troubleshooting

**The upload is too large.** Start stops before creating a box and names the total, the file count, and the five largest eligible files. Add the heavy paths to `excludedPaths`. Raising `maxUploadBytes` past 100 MB does not help, because Box rejects larger uploads.

**Native mode connects to the wrong API.** The `box` CLI reads a `.env` from the directory it runs in, which is your worktree. If that file sets `UPSTASH_BOX_BASE_URL`, the REPL will use it while the rest of the plugin uses its own. Unset it, or set the same value in the environment Herdr runs in.

**A verb says another popup is already open.** Herdr shows one popup at a time. Close the open one and try again; an unattended popup closes itself after two minutes.

## Develop

```bash
npm run typecheck
npm test
npm run lint
```
