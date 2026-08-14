# Architecture

Deep-dive documentation for dsh-grok-tui: how the plugin maps the grok TUI
onto DeepSeek Harness. For version pins and the upgrade checklist see
[COMPATIBILITY.md](../COMPATIBILITY.md).

## Overview

The plugin makes the grok-build TUI (`xai-grok-pager-bin`) a pure frontend
for the harness. It owns a Unix socket speaking the grok leader wire
protocol (registration, keepalive, control frames, and Agent Client Protocol
JSON-RPC payloads) and maps ACP methods onto DSH's `ctx.agents` / `ctx.llm`
services.

**Only the TUI is borrowed.** Every kernel concern — system prompt assembly,
tool registry, model routing, session persistence, approvals, sandbox —
stays in DSH; grok-shell code never runs (the pager binary links it, but in
leader mode it connects to this server instead of spawning its own agent).

## Install layout (stable dir + live dsh resolution)

The plugin is installed into a STABLE directory (`~/.dsh/dsh-grok-tui`),
**not** inside the dsh checkout. The backend (`scripts/serve-real.ts`)
imports unpublished `@deepseek-ai/*` workspace packages plus `cordis`; on
every `grok-dsh` launch, `scripts/grok-dsh.sh` resolves the ACTIVE dsh
checkout (`~/.dsh/source/current`) and runs the server through the
checkout's tsx ESM hook with `TSX_TSCONFIG_PATH` set to the checkout's
`tsconfig.json` — the exact mechanism the dsh launcher itself uses, so
`@deepseek-ai/*` and `cordis` resolve through the checkout's tsconfig paths
while the plugin's own npm-installed deps (`@agentclientprotocol/sdk`,
`schemastery`) come from the plugin's `node_modules`. Resolution therefore
always follows the currently installed dsh:

- upgrading dsh (its installer repoints `current` at a fresh worktree) needs
  **no re-install** — the next launch re-resolves against the new checkout;
- the plugin's own deps are versioned by the plugin alone.

`DSH_CURRENT` overrides the checkout location. On systems without `setsid`
(macOS), the backend daemon is detached with `nohup` instead; both keep the
daemon alive after the wrapper exits.

## The pager binary (status bar)

The top-right status items (context bar + dsh stats chip, see "Status bar")
are rendered by the grok TUI pager itself, not by the server. The official
downloaded `grok` binary predates the `dshUsage` meta and the chat-kind
context gate, so it renders only the stock grok items. The full status bar
requires the pager built from [grok-build](https://github.com/xai-org/grok-build)
with the dsh patch shipped in this repo (`vendor/grok-build-dsh.patch` — a
small pager-side change, +372/−9 lines across 10 files, kept separate so the
upstream tree stays pristine).

`scripts/build-grok-pager.sh` reproduces that build on any machine: it
fetches grok-build at a pinned revision, applies the patch, and runs `cargo
build -p xai-grok-pager-bin`, producing
`<plugin>/../grok-build/target/debug/xai-grok-pager`. `install.sh` offers the
build during install (default yes on interactive runs; `GROK_BUILD=0` skips,
`sh install.sh --build-grok` forces). `grok-dsh` prefers the sibling
source-built pager (debug or release) over the official binary.

## Build

Set `DSH_PATH` to an absolute DSH repository root when building: the
`postinstall` script generates the local `tsconfig.json` from that root and
validates it (without `DSH_PATH` it skips generation — the runtime runs from
source via tsx and never needs it). The DSH root must have its `lib/types`
built (`tsc -b` at the DSH root) for typechecking:

```bash
DSH_PATH=/absolute/path/to/dsh pnpm install
DSH_PATH=/absolute/path/to/dsh pnpm run build
```

## Running

One command (recommended): `grok-dsh` (or `scripts/grok-dsh.sh`). **Every
invocation owns its own backend** — a dedicated server process and socket
plus its own TUI — exactly like other AI-agent CLIs: windows never share a
backend, and closing a window (Ctrl+C or `/exit`) stops that window's
backend. History is still shared across windows: sessions persist to one
store, so `/resume` in any window can restore sessions created by any other
window.

```bash
alias grok-dsh=/path/to/dsh-grok-tui/scripts/grok-dsh.sh
grok-dsh           # start THIS window's backend + open the TUI
grok-dsh stop      # stop ALL grok-dsh backends
grok-dsh status    # this window's backend status + grok binary version
grok-dsh restart   # stop + start this window's backend
```

A new model chosen in the TUI is remembered (`/tmp/dsh-grok-last-model`):
the next window and the next server start use it instead of the configured
default.

The TUI (and each session's working directory) stays in the directory where
you ran `grok-dsh` — run it from a project folder and the agent works there;
only the backend daemon itself lives in the plugin directory.

### Session history and workspaces

**Session history is shared with the DSH Web UI.** The backend persists to
the same store the web app uses (`~/.dsh/sessions`, override with
`DSH_GROK_SESSIONS`): `/resume` in the TUI lists web sessions too, web
sessions resume in the TUI, and TUI sessions appear on the web side. Sessions
the user **archived in the web UI stay out of the TUI resume catalog** — the
server reads the web's registry-global archive set from the shared storage
unit (`~/.dsh/storages/workspace.json`, override with `DSH_GROK_STORAGES`)
and filters it from `x.ai/session/list`. Do not drive the SAME session from
the web UI and the TUI at the same time — their appends interleave and the
log can become unreadable; the server self-heals interleaved logs on resume
(it rebuilds the log and retries), so a session damaged that way recovers
automatically.

**TUI sessions group under their web workspace.** DSH's workspace registry
only attaches sessions created through the web's own `session.create` flow,
so without help every TUI session would show under "Ungrouped" in the web
sidebar even when its `cwd` matches a registered workspace. The server
performs the same attach the web would have done — a direct read-merge-write
of the shared workspace unit (`~/.dsh/storages/workspace.json`): the
session's `cwd` is canonicalized and prepended to the account of the
workspace owning that directory, exactly like the registry's `attachSession`
(prepend + `updatedAt` stamp; a session already accounted is never
double-booked). A directory with **no registered workspace gets one
registered on first use** — record path is the canonical cwd, title is its
basename, and the record is prepended to the registry order, the same act
the web's first-bootstrap performs for historical sessions; a missing unit
file is created the same way. Only a cwd that does not resolve to an
existing directory stays ungrouped (and is logged) — DSH's workspace create
rejects the same path.

The attach fires on the session's **first flush, not at session/new and
not at the first event**: persistence is lazy, so a session the pager opens
but never uses never materializes a log, and booking it at create would
leave a ghost account for a session that does not exist. The flush is the
harness's observation barrier for the eager write path, so the log exists
once events flowed. Before calling the web host, the server additionally
waits for the log file itself (`waitForSessionLog`): without that barrier a
running web host can CREATE the session first (its `session.create` finds no
log yet, its own agent startup writes boot events and materializes the log),
and this server's materialize is then rejected forever — every turn of that
session fails with "refusing to materialize ... a log already exists on
disk". With the barrier in place the host always RESUMES. When a web host is
**running**, the attach goes through the host's **own API gateway**
(`workspace.create` by path, then `session.create` with the session id — the
host resumes the persisted session and attaches it in its in-memory
registry): the sidebar shows the grouping immediately, the host's next
registry write republishes its memory (which now includes the session), so
no stale-memory clobber and **no restart is ever needed**. When no host is
reachable, the server falls back to the direct unit write, and every server
start additionally runs a **registry sync** (`syncWorkspaceAccounts`) that
re-accounts every persisted session, so the shared unit self-heals on the
next window you open. The web port is configurable (`webPort`, default 3080;
`DSH_GROK_WEB_PORT` in the launcher). One caveat: the API attach resumes the
session in the web host, so it holds an idle live copy — do not drive that
session from the web UI and the TUI at the same time (the documented
interleaving hazard). Existing ungrouped sessions can be backfilled with
`node --import tsx scripts/backfill-attach.ts` (dry run by default;
`--apply` writes — it registers workspaces for directories that have none).

### Environment

`DSH_GROK_MODEL` selects the model (default `deepseek-v4-pro`;
`deepseek-v4-flash` for the lighter one); `DSH_GROK_EFFORT` selects the
reasoning effort (default `max`; `off|high|max`). `GROK_BIN` resolves in
order: the `GROK_BIN` override, a sibling source build
(`../grok-build/target/debug/xai-grok-pager` — the source of record for the
status-bar coupling), then the official `grok` binary on PATH or
`~/.grok/bin/grok` (which renders no status items, see "Status bar" below).

### In-TUI controls

- **Model switch**: Ctrl+M (or `/model <id>`, e.g. `/model deepseek-v4-flash max`)
  — lists the DSH provider catalog; the picker's effort sub-step sends the
  grok effort value, mapped to the harness vocabulary (`max` stays `max`,
  `high`/`xhigh` → `high`, the rest → `off`) via `session/set_model`.
- **Permission dialogs**: Enter allows once, Esc rejects.
- **Resume**: `/resume` opens the session picker, listing persisted DSH
  sessions (`x.ai/session/list`); picking one restores it via `session/load`
  (transcript replay). From the CLI: `grok --resume <session-id>`.
- **Todo pane**: Ctrl+T. **Quit TUI**: `/exit` (backend keeps running).

### Status bar (top right)

The pager's built-in context bar and a dsh-specific stats chip live on the
right edge of the status bar:

- **Context bar** — `2.0K / 1.0M`: current context usage over the model's
  context window. The server stamps `_meta.totalTokens` (provider-reported
  prompt size of the newest request) on every notification and advertises
  `totalContextTokens` in the model-state meta (the DeepSeek adapter's 1M
  window); both are needed or the bar stays hidden. Refreshes immediately
  after each usage change via the standard ACP `usage_update` notification
  (the pager applies the `_meta` fields and ignores the body).
- **dsh stats chip** — `Cache 97% · In 58 · Out 98 · API 1 · Tools 0.1s`:
  cache-hit share of billed input, cumulative input/output tokens, provider
  call count, and summed tool wall time — the same figures the web UI shows.
  Carried by `_meta.dshUsage` (see `src/usage.ts` for the fold). A group
  drops out until it has data (e.g. `Tools` appears only after the first
  tool call).

Both require the **source-built pager** — `scripts/grok-dsh.sh` prefers a
sibling `grok-build` source build, so a machine with one gets them. The
official downloaded binary (`~/.grok/bin/grok`) predates the `dshUsage`
meta and the chat-kind context gate, so it renders neither (the session
still works — only the status items are missing).

Manually, boot a DSH host that mounts this plugin (see `scripts/serve.ts`
for a keyless demo composition: real agent loop + bwrap-sandboxed bash +
ask-policy approvals with a scripted mock provider), then run the grok TUI
against it:

```bash
GROK_LEADER_SOCKET=/tmp/dsh-grok.sock node --import tsx scripts/serve.ts
GROK_LEADER_SOCKET=/tmp/dsh-grok.sock grok --leader
```

The pager connects to the socket, registers, and never spawns its own leader
(`connect_or_spawn` prefers an existing listener; `$GROK_LEADER_SOCKET`
overrides the default `~/.grok/leader.sock` on both sides). `--leader` (or
`use_leader = true` in the pager config) forces leader mode.

## Config

| Key | Type | Default | Description |
|---|---|---|---|
| `socketPath` | string | `$GROK_LEADER_SOCKET` or `~/.grok/leader.sock` | Leader socket path. |
| `provider` | string | — | Initial provider route for every created agent. |
| `model` | string | — | Initial model for every created agent (also the model picker default). |

The plugin injects `agents` and `llm`. When the composition also mounts
`@deepseek-ai/dsh-user-questions`, the plugin registers its single question
provider; without it, `ask_user_question` is simply not served.

## Protocol surface

### Leader transport (`src/leader.ts`)

Length-prefixed JSON frames (4-byte big-endian length, 64 MB cap) over a
Unix domain socket, mirroring `xai-grok-shell/src/leader/protocol.rs`:

- `register` → `registered` (protocol version 1, `control_v1` capabilities)
- `ping` → `pong` (the pager keepalives every 30 s)
- `control` → `control_result` (`get_leader_info` answered; everything else errors cleanly)
- `acp` → JSON-RPC payloads dispatched to the ACP layer (see below)
- `disconnect` → connection close, owned agents quiesced

### ACP methods (`src/acp-server.ts`)

| Method | Behavior |
|---|---|
| `initialize` | Version negotiation; advertises the `xai.api_key` auth method (the pager fail-closes on an empty list — this skips its login screen), a baseline prompt surface, and `_meta.modelState` built from the DSH provider catalog. |
| `authenticate` | No-op; DSH resolves credentials at request time. |
| `session/new` | `agents.create` with an absolute `cwd`; honors `_meta.sessionId`; client-supplied `mcpServers` are accepted and **ignored** (the pager forwards its own config.toml servers, with secrets — DSH never spawns them). |
| `session/load` | Resumes a persisted session through `agents.resume` (or replays an owned one) and re-delivers the transcript as `isReplay` notifications, so the pager restores scrollback after reconnect. |
| `session/prompt` | Text blocks → `agent.followup`; one in-flight prompt per session; settles from the owning `turn/end` with the mapped stop reason. |
| `session/cancel` | Cancels the addressed agent and settles its pending prompt as `cancelled`. |
| `session/set_model` | Routes the pager's model switch through `ctx.llm.resolveCallConfig` + `installAgentLlmTarget`. |
| `x.ai/commands/list` | Serves the DSH command registry (`ctx.commands.list`) filtered of pager-builtin collisions; the pager merges the rows into its slash menu. |
| other `x.ai/*` / `_x.ai/*` | Empty results; unknown methods fail with method-not-found. |

### Notifications (`src/translate/events.ts`)

DSH session events translate to the pager's live surface:

- `assistant/chunk` text deltas → `agent_message_chunk`; reasoning deltas → `agent_thought_chunk` (token-level streaming)
- `tool/call` → `tool_call` cards (ToolKind category, camelCase-shaped `rawInput`, grok title conventions: `Web search: <query>`, command-as-title for bash, path for edit/read)
- `tool/result` → `tool_call_update` with `rawOutput` in the grok `ToolOutput` union (`Bash` exit code, `ReadFile` line counts, `SearchReplace` hunks from the fs tool's result meta, `WebSearch`, `Text` fallback), `status: failed` on error
- `todo/write` → `plan` updates (the pager's todo pane is fed by Plan updates)
- Replays additionally echo `user/message` as `user_message_chunk` and synthesize committed `assistant/message` text, all stamped `_meta.isReplay`

### Approvals and questions (`src/bridge/`)

- `approval/request` (waterfall) → `session/request_permission` with one-shot allow/reject choices; the pager's dialog answer maps back to the harness outcome (`always` folds to one-shot allow; unknown answers fail closed; client errors → `unavailable`).
- `ask_user_question` → the `x.ai/ask_user_question` extension method on the owning connection; the pager's overlay answers map back to the harness answer shape (option labels → `selected`, freeform notes → `custom`; `plan-review` intents use plan mode).

## Model Experience

### Prompt text

Prompts submitted through the grok TUI become ordinary `user/message`
session events with `source.kind: 'user'`, identical to a web or headless
submission. No content is synthesized for the wire; responses are streamed
from the durable session log. Tool results are the harness's own
model-facing text — the grok `ToolOutput` shapes exist only on the wire to
the TUI, never in the model request.

### Token and KV Cache effect

None — the adapter performs no extra model calls; a prompt waits on the same
turn the DSH agent loop runs. The only wire-side cost is the TUI rendering
stream, which the session log already contains. Request-prefix stability is
unaffected by the transport; model switches route through the same
`installAgentLlmTarget` mechanism the web GUI uses.

### Permission decisions

Nothing reaches the model directly; the owning tool records its allowed,
rejected, cancelled, or unavailable outcome through the normal tool-result
path. Only the owning tool result contributes tokens; the session log stays
append-only.

## Known Limitations and Deferred Work

- **No auth layer on the leader socket** — the socket path is the only fence; a process client that can reach it can drive the harness. Same posture as the pager's own leader.
- **Windows named pipes not implemented** — the leader transport is Unix-socket-only; the pager's Windows pipe hash is documented in the grok source for a future port.
- **`session/load` cursor ignored** — replays the whole transcript; the pager dedups by `eventId`, so this is safe but not optimal for large logs.
- **`session_info_update` not sent** — session titles stay off the wire (the pager falls back to the first prompt); `usage_update` **is** sent (it drives the context/stats bars, see "Status bar" above).
- **`extNotification` ignores all `_x.ai/*` notifications** — the pager's telemetry logs are dropped (never forwarded anywhere).

## DSH command bridge (slash commands in the TUI)

DSH registers its human-facing slash commands (`/goal`, `/feedback`, …) in
the `ctx.commands` registry (`@deepseek-ai/dsh-commands`). The bridge exposes
them to the pager:

- **Catalog**: after every session/new, session/load and re-align the server
  pushes an ACP `available_commands_update` notification, and the pager's
  `x.ai/commands/list` pull is answered from `ctx.commands.list(agent)`
  (`src/commands-bridge.ts`). Commands whose name collides with a pager
  builtin (`/plan`, `/resume`, `/model`, …) are filtered out — the pager's
  own builtin keeps winning the keystroke.
- **Execution**: the pager has no ACP method to RUN an agent command; picking
  one produces a `PassThrough` prompt (`/goal …` as plain text). The
  `session/prompt` handler intercepts slash lines that resolve to a DSH
  command and executes them through `ctx.commands.execute(agent, line,
  signal)` instead of handing the raw line to the model (which has no idea
  what `/goal` means). The handler's result text is delivered back to the
  pager as a single assistant message; `session/cancel` aborts an in-flight
  execution.
- **Service availability**: the commands service is duck-typed through
  `ctx.get('commands')`. The official host mounts it (web profile); the
  standalone daemon mounts `dsh-commands` + `dsh-command-goal` in
  `scripts/serve-real.ts`. Absent service = no menu entries and no
  interception.

## Development

```bash
pnpm test          # rstest: transport, ACP mapping, translation, bridges (keyless)
pnpm run build     # rslib bundle (requires DSH_PATH + built DSH lib/types)
pnpm run check     # biome
```

The test suite mounts the REAL agent loop with a scripted mock provider (no
API key): streaming chunks, tool cards, permissions, questions, and
session/load replay are all covered end-to-end in-process. `scripts/serve.ts`
+ a PTY driver (e.g. `research/m0-server/drive_pty.py` in the parent tree)
run the real pager against the real stack headlessly.
