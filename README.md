# Upstash Box Herdr plugin

Run a coding agent in an Upstash Box from the worktree you are looking at in [Herdr](https://herdr.dev).

Focus a pane inside a Git worktree, invoke **Start agent in Upstash Box**, and the plugin creates a box, uploads a filtered copy of the worktree, opens a new pane, and puts the agent in it. Close the pane and the agent keeps running. Come back with **Reconnect**, and a box that idled and paused in the meantime resumes on its own. When the agent has done something, **Apply changes** brings its edits back as a checked Git patch.

The pane runs the real Claude Code, Codex, or OpenCode terminal UI, kept alive under tmux inside the box. Your provider credential is passed into each session and never handed to the box.

## Requirements

- Herdr 0.8.0 or newer
- Node.js 22 or newer
- Git and tar
- An Upstash Box API key
- A credential for the model's provider: a Claude subscription token, or an Anthropic, OpenRouter, OpenAI, or OpenCode API key
- Nothing else: the Box SDK is installed with the plugin

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

Setup opens a popup that asks for your Upstash Box API key and checks it against the API before anything else, then asks which agent and which provider credential to use, and writes `config.json` and `secrets.json` (mode 600) for you. Keys are typed without echo, so nothing lands in the scrollback. If you pick the subscription option, setup asks you to run `claude setup-token` in another terminal and paste the token it prints; it checks the token's shape before saving it. A credential that is already present can be kept or replaced, unless it comes from the environment: the environment outranks the file, so setup says to unset it there instead.

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
  "harness": "claude-code",
  "model": "anthropic/claude-sonnet-5",
  "agentArgs": [],
  "runtime": "node",
  "size": "small",
  "keepAlive": false,
  "boxNamePrefix": "herdr",
  "remoteRoot": "/workspace/home/worktree",
  "providerApiKeyEnv": null,
  "allowMultipleBoxes": false,
  "excludedPaths": [],
  "allowSensitivePaths": [],
  "maxFiles": 10000,
  "maxFileBytes": 10485760,
  "maxUploadBytes": 104857600,
  "maxPatchBytes": 52428800,
  "previewPorts": [3000, 5173, 8000],
  "previewAuth": "basic"
}
```

| Setting               | Default                     | Purpose                                                                                                                                                                                                                                                                       |
| --------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness`             | `claude-code`               | `claude-code`, `codex`, or `opencode`. Already installed in every box image.                                                                                                                                                                                                  |
| `model`               | `anthropic/claude-sonnet-5` | A Box model id with its provider prefix. Claude Code takes `anthropic/` and `openrouter/` models. Codex needs an `openai/` model. OpenCode takes any. Incompatible pairs fail at config time.                                                                                 |
| `agentArgs`           | `[]`                        | Extra arguments appended to the harness command. `["--dangerously-skip-permissions"]` lets Claude Code edit without approving each change, which is reasonable in a disposable box with a scoped key and wrong on a laptop; it is never the default for an interactive start. |
| `runtime`             | `node`                      | Box runtime image.                                                                                                                                                                                                                                                            |
| `size`                | `small`                     | `small`, `medium`, or `large`.                                                                                                                                                                                                                                                |
| `keepAlive`           | `false`                     | Keep the box running instead of letting it pause when idle.                                                                                                                                                                                                                   |
| `boxNamePrefix`       | `herdr`                     | Prefix for generated box names.                                                                                                                                                                                                                                               |
| `remoteRoot`          | `/workspace/home/worktree`  | Where the worktree lands in the box. Must stay under `/workspace`. A subdirectory keeps the agent's own config directories out of the Git baseline.                                                                                                                           |
| `providerApiKeyEnv`   | `null`                      | Name the one variable that carries the provider credential. By default the plugin tries the variables that fit the harness and model, subscription token first for Claude Code. Set this and nothing else is ever substituted.                                                |
| `allowMultipleBoxes`  | `false`                     | Allow more than one live box per worktree. Off by default, so a second Start points you at the existing box.                                                                                                                                                                  |
| `excludedPaths`       | `[]`                        | Extra repository-relative paths left out of the upload.                                                                                                                                                                                                                       |
| `allowSensitivePaths` | `[]`                        | Exact files the safety filter would otherwise exclude.                                                                                                                                                                                                                        |
| `maxFiles`            | `10000`                     | Upload file count limit.                                                                                                                                                                                                                                                      |
| `maxFileBytes`        | `10485760`                  | Per-file upload limit, 10 MiB.                                                                                                                                                                                                                                                |
| `maxUploadBytes`      | `104857600`                 | Total upload limit, 100 MiB.                                                                                                                                                                                                                                                  |
| `maxPatchBytes`       | `52428800`                  | Largest patch Apply will download from the box, 50 MiB.                                                                                                                                                                                                                       |
| `previewPorts`        | `[3000, 5173, 8000]`        | Ports the previews pane may expose with a public URL.                                                                                                                                                                                                                         |
| `previewAuth`         | `basic`                     | `basic` puts basic auth on every new public URL. `none` makes the link reachable by anyone who has it.                                                                                                                                                                        |

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
```

A binding for Start:

```toml
[[keys.command]]
key = "prefix+shift+u"
command = "herdr plugin action invoke start-agent --plugin upstash.box"
```

**Start claude**, **Start codex**, and **Start opencode** are Start on a named harness for one launch, meant for key bindings: `config.json` is not touched, the configured model is kept when that harness can use it and otherwise the harness default applies, and `agentArgs` and `providerApiKeyEnv` are dropped because they were written for the configured harness. Herdr cannot pass arguments to an action, which is why these are three verbs rather than one flag. They are still one box per worktree: a second Start on a worktree that already has a live box is refused whichever verb you use. On reconnect, a `providerApiKeyEnv` written for the configured harness and model is ignored for a mapping it does not fit, whether a different harness or a different provider: a box created on an `openrouter/` model keeps its OpenRouter key even after setup moved the config to a subscription token, because the model is recorded per box.

**Start** checks the worktree, refuses if a box already exists for it, then splits the focused pane, creates a box named after the worktree, uploads the filtered tree, records a Git baseline in the box, and opens the agent. **Reconnect** attaches again from any pane the mapping knows, resuming a paused box first and finishing any preparation a crash interrupted. If the pane Start was invoked from no longer exists, which is the case after any Herdr restart, Reconnect anchors to the focused pane instead and remembers it. **Apply changes** exports what changed in the box since the last apply as a binary Git patch, checks it against the worktree, shows the summary, and applies it after you say yes. **Stop** ends the agent session and keeps the box. **Delete** asks you to type `DELETE` in a popup, then removes the box and its mapping. **Info** shows the box status, agent session, paths, and export markers.

**Pause** ends the agent session and pauses the box; **Resume** brings it back without opening the agent. **Snapshot** saves the box state under a timestamped name. **Fork** asks you to type `FORK`, snapshots the box, and starts a second box from that snapshot for the same worktree, with its own mapping, so two directions can run from the same point. **Previews** exposes one of the configured ports with a public URL, with basic auth by default, and removes it again. **Dashboard** opens a zoomed board of every box the plugin owns.

Herdr shows one popup at a time. If a verb reports that another popup is already open, close that popup and run it again. A popup left unattended closes itself after two minutes so it cannot block the other verbs.

## Dashboard

The board lists every mapping newest first, with worktree and branch, box name, agent, local lifecycle, live remote status, and age, and refreshes the remote column every few seconds. Boxes that carry the plugin label but have no mapping appear as orphans and can only be deleted. Every verb is one key away and opens the same pane the matching action would:

```
[j/k] Select  [enter/r] Reconnect  [a] Apply  [i] Info  [s] Stop  [p] Pause  [u] Resume
[n] Snapshot  [f] Fork  [v] Previews
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
- The agent runs inside a tmux session on a tmux server private to the mapping. A Box exec session owns its process, so without tmux closing the pane would kill the agent. tmux is installed on first launch if the image lacks it.
- Provider keys are passed as environment of the exec session only. They never reach the box environment, its filesystem, or a snapshot, and they are never part of box creation.
- Every pane claims the mapping with a connection token. Stop, delete, and reconnect clear or replace it, so a pane that exits later cannot overwrite what they recorded.
- Every interactive mutating verb runs under a per-mapping lock, so stop, pause, resume, snapshot, apply, delete, and fork cannot interleave and write each other's outcome. A second one is refused rather than queued.
- A fork records its mapping before anything billable exists, carries no credential of its own, and gets no source pane.
- Applying a patch also refuses added content that looks like a credential, not just sensitive paths.
- Idle boxes pause, and tmux does not survive a pause. Reconnect resumes the box and relaunches the harness with its continue flag, so the conversation carries on from disk.
- Before the archive is built, every reviewed file is copied into a private staging tree through a no-follow descriptor and checked against the size and hash from the preview. Anything that changed in between stops the start.
- The worktree travels as one tar archive, unpacks into a sibling directory in the box, and is swapped into place only after extraction succeeds. A fresh Git repository there records the upload as a baseline commit.
- Apply snapshots the box tree as a new commit, diffs it against the last applied commit, and downloads the patch to disk in bounded chunks, refusing anything above `maxPatchBytes`. The bytes are bound to that commit by a checksum computed in the box.
- Incoming patches obey the upload rules: no symlinks, and no env or credential paths unless listed in `allowSensitivePaths`. The patch applies locally only when `git apply --check` passes, and one Apply runs per box at a time.

## Status

Shipped: setup, the lifecycle and the agent pane, worktree upload and patch-back, the dashboard with pause, resume, previews, snapshots and fork, and per-harness starts. Each piece was verified against real boxes and driven end to end inside a live Herdr session, and the setup popup was driven in a real terminal. Decisions with a rationale worth keeping are in [docs/adr](docs/adr/README.md).

Requires `@upstash/box` 0.7.5 or newer, which the plugin installs itself.

## Troubleshooting

**The upload is too large.** Start stops before creating a box and names the total, the file count, the heaviest top-level directories, and the five largest eligible files. The directories are usually the answer: on a docs repository the five largest files were 1 to 3 MB each while 110 MB sat in `img/` across 438 files. The total is measured before file contents are scanned, so a large file the secret filter would have dropped still counts. Add the heavy paths to `excludedPaths`. Raising `maxUploadBytes` past 100 MB does not help, because Box rejects larger uploads.

**Claude Code shows `API Usage Billing` instead of your plan.** That session is not on the subscription token. The model is recorded per box, so a box created on an `openrouter/` model stays on OpenRouter no matter what setup wrote later. Delete it and start a new one; the start pane names the credential before it creates anything.

**A verb says another popup is already open.** Herdr shows one popup at a time. Close the open one and try again; an unattended popup closes itself after two minutes.

## Develop

```bash
npm run typecheck
npm test
npm run lint
```
