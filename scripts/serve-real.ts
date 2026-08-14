/**
 * Real-usage server: mounts the FULL real stack — DeepSeek adapter (key from
 * ~/.dsh/.env or $DEEPSEEK_API_KEY), agent loop, bwrap sandbox, bash tool,
 * filesystem tools, ask-policy approvals, JSONL session persistence — and
 * serves the grok leader protocol on a Unix socket.
 *
 * FALLBACK MODE (0.2.0+): the RECOMMENDED deployment is the official-host
 * bridge — `dsh web` with the grok-server plugin (grok-server.yml / install.sh
 * wire it into the web profile), where this bridge runs INSIDE the host
 * process and shares its single live agent + seq counter per session. This
 * standalone daemon is kept as the fallback for hosts that do not run
 * `dsh web` (grok-dsh.sh prefers the host's leader socket and starts this
 * daemon only when no host is listening, printing a warning). NEVER run this
 * daemon and an official host on the SAME session store at once: two
 * processes with independent seq counters interleave shared logs and the
 * strict loader reports "corrupt session log: seq gap".
 *
 * The tool stack mirrors the shipped `apps/cli/config/base.cordis.yml`
 * composition (web/headless/acp all share it), minus web/UI-only and
 * environment-specific rows (settings, telemetry, repository plugins,
 * session-title, commands, pi-ai, session-query). Goal and plan mode are
 * mounted: goal works tool-call-only (no web goal panel here), plan mode is
 * entered through the grok-specific `plan_mode` tool (see src/plan-tool.ts)
 * and exited through the official `exit_plan_mode` review. In particular
 * `bash-env` is required: `dsh-tool-bash` declares `inject: [...,
 * 'bashEnv']` and Cordis waits for that service before activating the
 * plugin, so without it the bash tool silently never registers.
 *
 * Plugins are mounted directly (not wrapped): Cordis then validates config
 * through each plugin's Schemastery `Config` and fills defaults, which the
 * apply functions rely on (e.g. `tool-web` asserts every budget is a
 * positive integer).
 *
 * Usage:
 *   1. Put your key in ~/.dsh/.env (DEEPSEEK_API_KEY=sk-...) or export it.
 *   2. Terminal 1:  GROK_LEADER_SOCKET=/tmp/dsh-grok.sock node --import tsx scripts/serve-real.ts
 *   3. Terminal 2:  GROK_LEADER_SOCKET=/tmp/dsh-grok.sock <grok-binary> --leader
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BashEnv from '@deepseek-ai/dsh-bash-env'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import CompactBasic from '@deepseek-ai/dsh-compact-basic'
import ToolResultPrune from '@deepseek-ai/dsh-compact-tool-result-prune'
import CommandGoal from '@deepseek-ai/dsh-command-goal'
import Commands from '@deepseek-ai/dsh-commands'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-policy'
import FsSandbox from '@deepseek-ai/dsh-fs-sandbox'
import Goal from '@deepseek-ai/dsh-goal'
import * as GoalSession from '@deepseek-ai/dsh-goal-session'
import * as LlmDeepseek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import PlanMode from '@deepseek-ai/dsh-plan-mode'
import * as RepeatToolGuard from '@deepseek-ai/dsh-repeat-tool-guard'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionTitle from '@deepseek-ai/dsh-session-title'
import * as SessionTitleFirstMessageLlm from '@deepseek-ai/dsh-session-title-first-message-llm'
import Skill from '@deepseek-ai/dsh-skill'
import * as SkillLocal from '@deepseek-ai/dsh-skill-local'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import Subagent from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import TasksLocal from '@deepseek-ai/dsh-tasks-local'
import * as TimeoutPolicy from '@deepseek-ai/dsh-timeout-policy'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as ToolAskUser from '@deepseek-ai/dsh-tool-ask-user'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as ToolFsSearch from '@deepseek-ai/dsh-tool-fs-search'
import * as ToolGoal from '@deepseek-ai/dsh-tool-goal'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import * as ToolStrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSubagentReport from '@deepseek-ai/dsh-tool-subagent-report'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import * as ToolWorkflow from '@deepseek-ai/dsh-tool-workflow'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import Web from '@deepseek-ai/dsh-web'
import * as WebSearchDeepseek from '@deepseek-ai/dsh-web-search-deepseek'
import WorkflowWorkerthread from '@deepseek-ai/dsh-workflow-workerthread'
import * as WorkspaceContext from '@deepseek-ai/dsh-workspace-context'
import { Context } from 'cordis'
import * as GrokServer from '../src/index.ts'
import * as GrokPlanTool from '../src/plan-tool.ts'
import { syncWorkspaceAccounts } from '../src/workspace-attach.ts'

const socketPath = process.env.GROK_LEADER_SOCKET ?? '/tmp/dsh-grok.sock'
// The remembered model lives under the DSH home (same file the official
// host bridge uses, ~/.dsh/grok-last-model), so the choice survives reboots —
// /tmp would reset it on every restart. DSH_GROK_MODEL still overrides.
const lastModelPath =
  process.env.DSH_GROK_LAST_MODEL ??
  join(homedir(), '.dsh', 'grok-last-model')
const remembered = (() => {
  try {
    const value = readFileSync(lastModelPath, 'utf8').trim()
    if (value.length === 0) return undefined
    // The shared memory file may hold a route-encoded id (`provider@model`)
    // written by the official host bridge, whose provider catalog includes
    // opencode-go etc. This daemon only mounts deepseek-official, so a route
    // prefix must not leak into the route — take the model id and let the
    // configured provider below own the route.
    const at = value.indexOf('@')
    return at > 0 ? value.slice(at + 1) : value
  } catch {
    return undefined
  }
})()
const model = process.env.DSH_GROK_MODEL ?? remembered ?? 'deepseek-v4-pro'
// Reasoning effort: 'off' | 'high' | 'max'. Default max; the pager can also
// override per session via its /model picker (mapped in session/set_model).
const effort = process.env.DSH_GROK_EFFORT ?? 'max'
const ctx = new Context()

// Credential store: reads $DSH_HOME/.env (hot-reloaded) so the adapter
// resolves DEEPSEEK_API_KEY per request without inlining secrets here.
await ctx.plugin(CredentialsLocal)

await ctx.plugin(LlmDeepseek, {
  thinking: 'enabled',
  reasoningEffort: effort as 'off' | 'high' | 'max',
  models: [
    // 1M context window: matches the adapter default (DEFAULT_CONTEXT_WINDOW)
    // and the real DeepSeek route capacity; the pager's context bar
    // denominator (`totalContextTokens`) comes from here.
    { id: 'deepseek-v4-pro', contextWindow: 1_000_000 },
    { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
  ],
})

await mountAgentLoopTestDependencies(ctx, {
  systemPrompt: {
    persona:
      'You are DeepSeek Harness running under the grok-build TUI. Working directory: {{cwd}}.',
  },
})
await ctx.plugin(AgentLoop, { agents: [] })

// Tool stack (workspace-write sandbox asks before widening).
await ctx.plugin(SubprocessLocal)
await ctx.plugin(SandboxLocal)
await ctx.plugin(SandboxPolicyService, {
  mode: 'workspace-write',
  workspaceRoot: process.cwd(),
})
await ctx.plugin(BashSandbox, { timeoutMs: 60000 })
// bash-env MUST precede the bash tool: dsh-tool-bash injects `bashEnv` and
// silently stays unactivated without it (Cordis waits for injected services).
await ctx.plugin(BashEnv)
await ctx.plugin(ToolBash)
await ctx.plugin(FsSandbox, { cwd: process.cwd() })
await ctx.plugin(FsPolicy)
await ctx.plugin(ToolFs, {
  readLimit: 2000,
  readMaxLineLength: 2000,
  readMaxBytes: 50 * 1024,
  readStreamMinSize: 10 * 1024 * 1024,
})
// File-search (glob/grep) and the targeted editor complete the fs surface.
await ctx.plugin(ToolFsSearch, { sampleOverCapGlobResults: false })
await ctx.plugin(ToolStrReplaceEditor, { maxOutputChars: 16000 })
// Question bridge: grok-server registers its TUI question router as the
// user-interaction provider; without the service, questions are unsupported.
// tool-ask-user then exposes the model-facing ask_user_question tool whose
// answers surface through the pager's option dialog.
await ctx.plugin(UserQuestions)
await ctx.plugin(ToolAskUser)
// Background tasks: the bash tool's run_in_background registers process
// handles through ctx.tasks; the tool-tasks surface lets the model manage them.
await ctx.plugin(TasksLocal)
await ctx.plugin(ToolTasks)
// Todo pane: the pager's todo panel is fed by plan updates translated from
// todo/write events (grok translate/events.ts), so tool-todo is UI-supported.
// allowParallelInProgress is REQUIRED by dsh-tool-todo since the 2026-08-07
// snapshot (schema-mandated deployment choice); the shipped base bundle sets
// true, and this daemon mirrors it — the agent may fan out parallel work.
await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
// Web search: server-side retrieval via the same DEEPSEEK_API_KEY credential
// the chat adapter uses. Fetch stays disabled (SSRF stance), as shipped.
await ctx.plugin(Web, { searchProvider: 'deepseek-official' })
await ctx.plugin(WebSearchDeepseek, {
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  ...(process.env.DEEPSEEK_SEARCH_BASE_URL !== undefined
    ? { baseURL: process.env.DEEPSEEK_SEARCH_BASE_URL }
    : {}),
})
await ctx.plugin(ToolWeb, { fetch: false, searchTimeoutMs: 60000 })
// Skills: registry + local roots provider + the model-facing tool.
await ctx.plugin(Skill)
await ctx.plugin(SkillLocal)
await ctx.plugin(ToolSkill)
// Workspace instructions (AGENTS.md / CLAUDE.md) into the model context.
await ctx.plugin(WorkspaceContext, { maxBytes: 65536 })
// Loop hygiene, same defaults as the shipped composition.
await ctx.plugin(TimeoutPolicy)
await ctx.plugin(RepeatToolGuard, {
  thresholds: [3, 5, 8],
  argumentsPreviewChars: 500,
})
await ctx.plugin(SpillLocal)
await ctx.plugin(SpillPolicy, { maxInlineBytes: 50000 })
await ctx.plugin(TokenMeter)
await ctx.plugin(CompactBasic)
await ctx.plugin(ToolResultPrune, {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
})
await ctx.plugin(SessionCheckpointPolicy)
await ctx.plugin(LlmRetry)
// Goals: the same-session completion goal service, its logged continuation
// driver, and the model-facing goal tools (create_goal/update_goal/get_goal).
// The web UI's goal panel is absent here, but the tools work tool-call-only.
await ctx.plugin(Goal)
await ctx.plugin(GoalSession)
await ctx.plugin(ToolGoal)
// Human command registry + the /goal slash command (F1): the grok pager's
// slash menu advertises DSH commands and the bridge executes them directly
// (src/commands-bridge.ts + src/acp-server.ts). The official host already
// mounts these (web profile), so the standalone daemon mirrors goal only —
// command-compact/command-feedback need services this daemon does not mount.
await ctx.plugin(Commands)
await ctx.plugin(CommandGoal)
// Plan mode: the kernel plan-mode plugin owns the mode state, the plan
// prompt section, and the exit_plan_mode review tool (its approval routes
// through userQuestions to the pager's plan-review dialog); grok-plan-tool
// adds the missing activation surface for a TUI with no mode-switch button.
await ctx.plugin(PlanMode, {
  section: `You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.

Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.

The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed only to keep the request shape stable. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.

Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.

Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.

When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask "should I proceed?" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.`,
})
await ctx.plugin(GrokPlanTool)
// Delegation: subagents (spawn/fork + control) and workflows, as shipped.
await ctx.plugin(Subagent)
await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
await ctx.plugin(SubagentFork, { providerName: 'fork' })
await ctx.plugin(ToolSubagent, {
  provider: 'spawn',
  toolName: 'subagent',
  backgroundMode: 'continuable',
})
await ctx.plugin(ToolSubagent, {
  provider: 'fork',
  toolName: 'subagent_fork',
  backgroundMode: 'continuable',
})
await ctx.plugin(ToolSubagentControl)
await ctx.plugin(ToolSubagentReport)
await ctx.plugin(WorkflowWorkerthread, { provider: 'spawn' })
await ctx.plugin(ToolWorkflow)
await ctx.plugin(ApprovalService, { policy: 'ask' })
// Session titles: the log-backed service writes a deterministic fallback
// title from the first user message, and the LLM provider upgrades it
// through the session's own model route — so grok-dsh sessions show real
// titles in the shared web session list instead of the workspace name.
await ctx.plugin(SessionTitle, {
  fallbackMaxWords: 5,
  fallbackMaxBytes: 40,
  maxTitleBytes: 80,
})
await ctx.plugin(SessionTitleFirstMessageLlm, {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 4096,
  maxOutputTokens: 64,
  timeoutMs: 60000,
})

// Durable sessions: one shared store with the DSH Web UI (~/.dsh/sessions) so
// /resume in the TUI sees Web sessions and vice versa. DSH_GROK_SESSIONS
// overrides for isolated test runs.
const sessionsRoot =
  process.env.DSH_GROK_SESSIONS ?? join(homedir(), '.dsh', 'sessions')
await ctx.plugin(SessionPersistenceJsonl, {
  root: sessionsRoot,
  compression: 'zstd',
})

// Shared workspace-registry storage with the DSH Web UI (~/.dsh/storages):
// the resume catalog reads the web's archived-session set from here.
// DSH_GROK_STORAGES overrides for isolated test runs.
const storagesRoot =
  process.env.DSH_GROK_STORAGES ?? join(homedir(), '.dsh', 'storages')

await ctx.plugin(GrokServer, {
  socketPath,
  provider: 'deepseek-official',
  model,
  effort,
  lastModelFile: lastModelPath,
  persistenceRoot: sessionsRoot,
  storageRoot: storagesRoot,
  // The running DSH web host's API gateway: session attaches go through it
  // so the host's in-memory registry updates immediately (no restart, no
  // stale-memory clobber). DSH_GROK_WEB_PORT overrides the default web port.
  webPort: Number(process.env.DSH_GROK_WEB_PORT ?? 3080),
})

// Self-heal the shared workspace registry: the web host republishes its own
// in-memory unit on every registry write, silently dropping grok attaches
// made after the host booted. Re-account everything persisted at startup so a
// later web restart sees complete grouping. Idempotent — no write when the
// registry already accounts every session.
const { attached, registered, skipped } = await syncWorkspaceAccounts(
  storagesRoot,
  sessionsRoot,
)
console.log(
  `workspace sync: attached ${attached}, registered ${registered}, skipped ${skipped}`,
)

console.log(
  `dsh-grok-tui ready at ${socketPath} (model ${model}, reasoningEffort ${effort}); connect with GROK_LEADER_SOCKET=${socketPath} grok --leader`,
)
process.on('SIGINT', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
