# Compatibility — version pins, breakage points, upgrade checklist

dsh-grok-tui is a thin wire adapter between two independently evolving
projects: the grok-build TUI (a compiled client) and DeepSeek Harness (the
host backend). This file records the exact versions the plugin was verified
against, the coupling surfaces that can break on either side's upgrade, and
the re-verification procedure.

## Official host bridge mode (0.2.0+) — deployment shape

Since 0.2.0 the recommended deployment runs the plugin INSIDE the official
`dsh web` host process (install.sh writes the grok-server row into
`~/.dsh/profiles/web/cordis.patch.yml` and links the package into the
profile's node_modules; `dsh web --patch <plugin>/grok-server.yml` loads it
temporarily). In that shape the host's own services — `agents`,
`sessionPersistence`, `workspace`, `userInteraction` (api-proxy owns the
provider slot), `tools`, `approval` — are the live surface the plugin calls,
so the Section D couplings below move from "build-time" to "the host's
actual runtime"; TypeScript still pins them at rebuild time.

Host-mode specifics to re-verify on upgrade:

- **userInteraction provider slot**: the host's api-proxy must remain the
  sole provider; the plugin must keep `userInteractionProvider: false` in its
  patch config (a second registration fails the whole plugin tree with
  DUPLICATE_PROVIDER — verified failure mode, 0.2.0).
- **Scoped shadow ask tool**: `agent.ctx.tools.register` scoped shadowing of
  `ask_user_question` (schema copied verbatim from `dsh-tool-ask-user`; if
  the official tool's schema or description changes, `src/bridge/shadow-ask.ts`
  must follow — the model-visible face must not drift).
- **Adoption of live agents**: `ctx.agents.get(sessionId)` before
  create/resume; the session store rejects a second live Session
  ("session already exists") and the persistence coordinator rejects
  out-of-continuation appends ("append seq mismatch") — both are the
  structural guarantees that make dual-frontend sharing safe in-process.
- **Workspace attach in-process**: `ctx.workspace.resolveByPath/create +
  attachSession` (the webPort HTTP path remains the daemon-mode fallback).

## Version pins (verified 2026-08-07)

| Component | Version / commit | Location |
|---|---|---|
| grok-build snapshot (dev) | `796754a8bf947b7c6c579049f94c7cfd0ac0ec03` (SOURCE_REV) | `research/grok-build/` |
| grok-build build base | upstream `393430ee4934bc791b0d538f304a21691c517433` (patch base, `GROK_BUILD_REV`) | `scripts/build-grok-pager.sh` |
| grok official binary | 1.0.0 (`3cd0d0cbce`) — fallback only; renders no status items. 1.0.0 is x.ai's public name for the 0.2.121 release (same feature set) | `research/grok-bin/grok` |
| grok source-built binary | 0.2.121 (`393430e`) — **default `GROK_BIN`**, carries the dsh status-bar coupling | `research/grok-build/target/debug/xai-grok-pager` |
| dsh status-bar patch | `vendor/grok-build-dsh.patch` (+372/−9 across 10 pager files) — applied by `scripts/build-grok-pager.sh`; applies clean to 0.2.121 (`393430e`) | `vendor/` |
| DSH snapshot | `78c0f64` (git) | repo root |
| ACP TS SDK | `@agentclientprotocol/sdk@0.25.1` | plugin dependency |
| ACP Rust crate (pager side) | `agent-client-protocol@0.10.4` (+ schema 0.11.4) | grok Cargo.lock |
| Leader wire protocol | v1 (`LEADER_PROTOCOL_VERSION = 1`) | grok `leader/protocol.rs` ↔ plugin `src/types.ts` |
| Plugin | 0.1.0 | `package.json` |

## Coupling surfaces (what an upgrade can touch)

### A. Leader wire protocol — HARD break point

`register`/`ping`/`control`/`acp` framing (4-byte length + JSON) and the
`registered` payload. The pager **rejects a leader advertising a lower
protocol version** (`leader/mod.rs`: `protocol_version <
LEADER_PROTOCOL_VERSION` → `UnsupportedProtocol`). This fails loudly at
connect, never silently.

**Upgrade check**: diff grok `src/leader/protocol.rs` against plugin
`src/types.ts` + `src/leader.ts`; bump `LEADER_PROTOCOL_VERSION` and adapt.

### B. ACP protocol (standard surface) — mostly compatible

Method names and notification shapes follow the ACP spec (negotiated at
`initialize`; both sides speak version 1 today). Version skew between the
pager's Rust crate (0.10.4) and the TS SDK (0.25.1) is absorbed by:

- unknown methods → SDK `extMethod` fallback (plugin implements
  `session/set_model` there),
- unknown notifications → `extNotification` (ignored),
- unknown meta keys → serde/zod defaults (everything is `Option`).

**Upgrade check**: if the pager's protocol crate bumps its major version,
re-verify `session/new`/`session/prompt`/`session/update` shapes against the
plugin's tests (they pin the wire literals).

### C. Grok private extensions — soft break points (degrade, don't crash)

| Surface | Plugin location | Failure mode on change |
|---|---|---|
| `x.ai/ask_user_question` ext-method format | `src/bridge/question.ts` | question overlay fails with a visible error |
| ToolOutput union (PascalCase tags, snake_case fields) | `src/translate/tools.ts` | rendering falls back to generic text |
| `_x.ai/*` / `x.ai/*` informational methods | `src/acp-server.ts` extMethod | auxiliary pager surfaces go quiet |
| title conventions (`Web search: <query>`, command-as-title) | `src/translate/tools.ts` | generic card headers |
| `authMethods: []` fail-closed behavior | `src/acp-server.ts` initialize | **login screen appears** (fails visibly) |
| Plan-updates-feed-todo-pane convention | `src/translate/events.ts` | todo pane stays empty |
| `session/set_model` params | `src/acp-server.ts` extMethod | model switch errors |
| model catalog wire ids (`provider@model` for cross-provider duplicates) | `src/acp-server.ts` modelState | duplicate ids collapse to one picker row (pager keys by id); `/model <plain-id>` on a duplicated model needs the suffixed name from the picker |
| `mcpServers` carried on session/new (with secrets) | `src/acp-server.ts` | ignored by design — re-confirm on change |
| `_meta.totalTokens` + `_meta.dshUsage` + `usage_update` notification | `src/translate/events.ts`, `src/usage.ts` | context/stats bars go stale (session still works) |
| `totalContextTokens` in model-state meta | `src/acp-server.ts` modelState | context bar has no denominator |

The pager is designed to degrade gracefully on unknown fields, so most
changes surface as missing polish, not breakage.

### D. DSH host APIs — build-time break points

The plugin bundles a snapshot of DSH's source (rslib, `bundle: true`); at
runtime it calls the HOST's live services. DSH is pre-release and renames
freely (`AGENTS.md`: "foundation over blast radius"). Coupled APIs:

- `agents.create` / `agents.resume` (`packages/core/agent`)
- session event union (`packages/core/session` — `assistant/chunk`,
  `tool/call`, `tool/result`, `todo/write`, `turn/*`)
- `ctx.on('approval/request')` waterfall (`dsh-user-approval`)
- `ctx.llm.listProviders/listModels/resolveCallConfig` (`dsh-llm`)
- `installAgentLlmTarget` (`dsh-agent/llm-target`)
- `userQuestions.registerProvider` (`dsh-user-questions`)

TypeScript surfaces these changes at rebuild time; fixes are mechanical.

## Upgrade checklist

### grok-build upgraded (new pager binary)

1. `git -C research/grok-build diff` the new snapshot's `src/leader/protocol.rs`
   against plugin `src/types.ts` (Section A). Bump and adapt if changed.
2. Run `pnpm test` (51 cases pin the wire shapes).
3. Rebuild the source binary and drive it headlessly:
   `GROK_LEADER_SOCKET=/tmp/dsh-grok.sock python3 research/m0-server/drive_pty.py "hi" /tmp/check.log`
   and eyeball the transcript (welcome screen, answer render).
4. If the pager sends unknown `x.ai/*` methods, add them to `extMethod`
   (empty-result stubs) and record the shape in this file.

### DSH upgraded (new host)

1. `DSH_PATH=<new-dsh-root> pnpm install && pnpm run build` (regenerates
   tsconfig, rebuilds the bundle against the new sources).
2. `pnpm test` — fix API drift the compiler reports (Section D).
3. Re-run the host-bridge verification matrix against a temporary DSH_HOME
   (`scripts/verify-host-bridge.mts` — leader handshake, web/grok alternating
   rounds, zero seq gaps) and the shadow-ask live check
   (`scripts/verify-shadow-live.mts`), plus a real permission-dialog pass in
   the standalone daemon (`scripts/serve-real.ts` + manual TUI).
4. If the host is deployed via install.sh's profile hookup, re-run
   `install.sh` (idempotent) and restart `dsh web` so the bridge reloads
   against the new host.

### Both upgraded

Do both procedures; Section A and D are the two independent failure axes.

## Version pinning options

- **Official binary** (`research/grok-bin/grok`): may auto-update itself
  (installer-managed); `GROK_AUTO_UPDATE` only changes post-update prompts,
  not the check policy. Re-run the checklist whenever its `--version`
  changes — `scripts/grok-dsh.sh` prints the version at launch.
- **Source-built binary** (`research/grok-build/target/debug/xai-grok-pager`):
  built from the pinned snapshot, no auto-update. Pin it with
  `GROK_BIN=/home/chenzongwei/test-chen-001/research/grok-build/target/debug/xai-grok-pager grok-dsh`.

## Versioning the plugin itself

`leader_binary_version` is advertised as `dsh-grok-tui-0.1.0`
(`src/index.ts` `SERVER_VERSION`). The pager only uses it to evict strictly
OLDER leaders, so an unpinned value never triggers eviction; bump it when a
new wire behavior lands so transcripts remain attributable.
