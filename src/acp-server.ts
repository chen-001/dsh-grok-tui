/**
 * ACP agent factory: one `Agent` per leader connection, mapping ACP JSON-RPC
 * methods onto the harness's `ctx.agents` services. The session registry,
 * in-flight prompt slot, turn settlement, and committed-message emission
 * mirror `@deepseek-ai/dsh-acp` exactly; the differences are the grok-facing
 * initialize surface (api_key auth method + modelState meta) and the socket
 * transport, which live outside this module.
 * @module dsh-grok-tui/acp-server
 */

import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  type Agent as AcpAgent,
  AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  PROTOCOL_VERSION,
  type PromptRequest,
  type PromptResponse,
  RequestError,
  type SessionNotification,
  type StopReason,
} from '@agentclientprotocol/sdk'
import {
  type Agent,
  type AgentSetup,
  installModelSelection,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import {
  type SessionEvent,
  type SessionHeader,
  SessionId,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
// Side-effect type import: activates the approval waterfall merge answered below.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { Context, LoggerService } from 'cordis'
import { readArchivedSessionIds } from './archive.ts'
import { installShadowAsk } from './bridge/shadow-ask.ts'
import type { QuestionRouter } from './bridge/question.ts'
import {
  acpPromptToText,
  promptHasUnsupportedContent,
  turnEndToStopReason,
} from './codec.ts'
import {
  firstUserPromptFromLog,
  sessionLogPath,
  sessionTitleFromLog,
} from './first-prompt.ts'
import {
  removeSessionLog,
  sessionLogState,
  waitForSessionLog,
} from './session-store.ts'
import type { AcpChannel } from './stream.ts'
import {
  buildUsageUpdateNotification,
  type ToolCallRecord,
  translateEvent,
} from './translate/events.ts'
import {
  createUsageState,
  foldUsageWithView,
  type SessionUsageState,
} from './usage.ts'
import {
  attachSessionToWorkspace,
  attachSessionViaWebHost,
} from './workspace-attach.ts'

/** Preserve invalid-parameter detail in the SDK wire error message. */
function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail)
}

/**
 * Status-file path for the usage panel (scripts/usage-panel.mjs). Lives next
 * to the session store in the DSH home so both bridge and standalone modes
 * share one location; the panel defaults to the same path.
 */
function usageStatusFile(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return join(home, '.dsh', 'grok-usage.json')
}

/** Preserve failed-turn detail; plain handler errors become a generic wire internal error. */
function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail)
}

/** Per-session protocol state, identical to dsh-acp's automation bridge. */
interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /**
   * Whether this record ADOPTED an already-live agent instead of creating or
   * resuming one. Inside the official host the web's api-proxy holds one
   * live agent per session id (the session store rejects a second live
   * session — and the persistence coordinator rejects out-of-continuation
   * appends), so a grok resume of a session the web has open must adopt that
   * live agent: the record then shares the agent, never disposes it, never
   * cancels it at teardown, and skips log-identity alignment (the same
   * process is the only writer, so disk state is always in sync).
   */
  adopted?: boolean
  /** Disposer of the scoped shadow ask_user_question tool (reinstalled after re-align). */
  disposeShadow?: () => void
  /**
   * Mutable per-session model selection. `session/set_model` updates
   * `ref.current` IN PLACE (never reinstalls) so the single
   * `installModelSelection` listener pair sees the new choice; reinstalling
   * per switch would stack `agent/request` waterfall listeners and let the
   * FIRST (outermost) listener's stale choice shadow every later one — which
   * silently reverts the model the moment the prompt leaves assembly.
   */
  modelSelectionRef?: ModelSelectionRef
  /** Disposer of the single model-selection listener pair (installed lazily). */
  disposeModelSelection?: () => void
  /** In-flight prompt: its queued message id (the claim-correlation key), the captured turn, and settlement slots. */
  inflight:
    | {
      resolve: (reason: StopReason) => void
      reject: (error: Error) => void
      messageId: string
      turn: number | undefined
    }
    | undefined
  /**
   * The shared log artifact's size/mtime as of this server's LAST flush (a
   * resumed session only; freshly created sessions are sole-writer by
   * construction). The pre-write alignment check in `prompt` compares the
   * artifact against it: a change means another frontend (the Web UI) appended
   * while grok held the session, so grok re-resumes from disk instead of
   * re-carrying seqs the log already holds.
   */
  logIdentity?: { size: number; mtimeMs: number }
}

/** ACP-facing plugin configuration. */
export interface GrokServerConfig {
  /** Initial provider route for every created agent. */
  provider?: string
  /** Initial model for every created agent. */
  model?: string
  /** Default reasoning effort advertised to the model picker ('off'|'high'|'max'). */
  effort?: string
  /** Path for remembering the last model chosen in the TUI (shared across windows). */
  lastModelFile?: string
  /**
   * Session-persistence root directory. When set, the resume catalog reads
   * each session's first prompt from the leading zstd frames of its JSONL
   * artifact instead of decompressing whole logs (the shared Web store holds
   * multi-hundred-MB logs that would stall the picker).
   */
  persistenceRoot?: string
  /**
   * Harness storages root holding the workspace registry unit files shared
   * with the DSH Web UI (default `~/.dsh/storages`). The resume catalog
   * reads the web's archived-session set from here and hides those sessions.
   */
  storageRoot?: string
  /**
   * Port of the RUNNING DSH web host. When set, session attaches go through
   * the host's own API gateway (its in-memory registry updates immediately —
   * no restart, no stale-memory clobber); when unset or unreachable the
   * server falls back to writing the shared unit directly.
   */
  webPort?: number
  /**
   * Whether to register the plugin as the context's single
   * user-interaction provider. Defaults to true (the standalone daemon owns
   * the slot). The OFFICIAL host must set this to false: its api-proxy owns
   * the slot and the provider seam rejects a second registration
   * (DUPLICATE_PROVIDER fails the whole plugin tree). Cannot be auto-detected
   * because grok-server activates before the api-proxy registers.
   */
  userInteractionProvider?: boolean
  /**
   * Whether the proactive session-log health watch runs (default true).
   * The OFFICIAL host sets this to false: a single process cannot produce
   * interleaved logs, and scanning a large shared store at the 15s interval
   * stacks concurrent passes (~118s per pass on a 355MB store) into
   * multi-core saturation that starves the host event loop. Legacy
   * interleaved logs are still repaired on demand by `resumeWithRepair`.
   */
  healthWatch?: boolean
  /**
   * Interval of the proactive session-log health watch over the shared
   * persistence root (default 15s). The watch repairs interleaved logs so the
   * Web UI's history reads — which grok cannot intercept — see a clean log.
   */
  healthCheckIntervalMs?: number
}

/**
 * One connection's ACP server: builds the SDK `Agent`, wires the session
 * event listener, and returns the connection plus a disposer that settles
 * pending prompts, cancels owned agents, and drains them.
 */
export interface LastModelRef {
  /** The last model selected through the pager, shared across connections. */
  current: string | undefined
}

export function createAcpAgent(
  ctx: Context,
  config: GrokServerConfig,
  channel: AcpChannel,
  logger: LoggerService,
  questions?: QuestionRouter,
  lastModel?: LastModelRef,
): { connection: AgentSideConnection; dispose: () => Promise<void> } {
  const agents = ctx.agents
  const sessions = new Map<SessionId, SessionRecord>()
  let closed = false
  let conn: AgentSideConnection | undefined

  /**
   * The remembered model, sanitized for THIS runtime's provider catalog: a
   * route-encoded id (`provider@model`) whose provider is not registered
   * here degrades to the bare model id. The shared memory file is written by
   * whichever frontend ran last — the official host's catalog (with
   * opencode-go etc.) differs from a standalone daemon's (deepseek-official
   * only) — so the daemon must not route to a provider it does not have.
   * Read at use time (lastModel.current changes on every session/set_model).
   */
  const rememberedModel = (): string | undefined => {
    const raw = lastModel?.current
    if (raw === undefined) return undefined
    const at = raw.indexOf(MODEL_ROUTE_SEPARATOR)
    if (at <= 0) return raw
    const provider = raw.slice(0, at)
    if (ctx.llm.listProviders().some(p => p.id === provider)) return raw
    return raw.slice(at + 1)
  }

  /**
   * Compose the agent from the roster preset exactly like the web api-proxy
   * does. Without the preset mount, grok sessions resolve ONLY the
   * global-layer tools (view_image / visualize): the bash/fs/… surface lives
   * in the preset's standing scope, which an agent only joins through
   * `presets.mount()` inside the creation `setup`. The standalone daemon has
   * no roster (tools are host-global there), so this degrades to no-op.
   * @returns the preset id to record on the header and the setup callback.
   */
  const composeFromPreset = async (): Promise<{
    agentPreset?: string
    setup?: AgentSetup
  }> => {
    const presets = ctx.get('agentPresets')
    if (presets === undefined) return {}
    const preset = await presets.resolve()
    return {
      agentPreset: preset.id,
      // AgentSetup must NOT return the mount value: a non-undefined return
      // is treated as an AgentSetupCommit (commit() is required). Await and
      // return nothing, exactly like the api-proxy's composeAgent.
      setup: async (agentCtx: Context): Promise<void> => {
        await presets.mount(agentCtx, preset.id)
      },
    }
  }

  /** Return the connection-owned record for an agent, rejecting same-id impostors. */
  const ownedRecord = (agent: Agent): SessionRecord | undefined => {
    const record = sessions.get(agent.session.id)
    return record?.agent === agent ? record : undefined
  }

  const assertOpen = (): void => {
    if (closed) throw internalError('the grok connection has been disposed')
  }

  const requireSession = (sessionId: SessionId): SessionRecord => {
    const record = sessions.get(sessionId)
    if (record === undefined)
      throw invalidParams(`unknown session: ${sessionId}`)
    return record
  }

  /**
   * Adopt the already-live agent for a session id, or undefined when none is
   * live. Inside the official host every live session id has at most one live
   * agent (the web api-proxy returns it for all its clients; the session
   * store rejects a second live Session on the same id), so a grok window
   * opening the same session shares the host's agent instead of failing with
   * "session already exists". Ownership stays with the creator: the adopted
   * record's `dispose` is a no-op and teardown never cancels the agent.
   */
  const adoptLiveAgent = (sessionId: SessionId): SessionRecord | undefined => {
    const live = ctx.agents.get(sessionId)
    if (live === undefined) return undefined
    logger.info(
      `grok-server: session ${sessionId} already live in this host — adopting the shared agent`,
    )
    return {
      agent: live,
      dispose: () => Promise.resolve(),
      adopted: true,
      inflight: undefined,
    }
  }

  /**
   * Install the scoped shadow ask_user_question tool on one record's agent
   * (阶段 1): grok sessions' asks ride the ACP channel to the TUI instead of
   * the web dialog. The registration binds to the agent's scoped context, so
   * agent teardown removes it automatically; the disposer is kept on the
   * record for explicit teardown and for re-installation after re-align
   * swaps the agent. No-op when the agent scope has no tools service.
   */
  const installShadow = (record: SessionRecord): void => {
    if (questions === undefined) return
    const tools = record.agent.ctx.get('tools')
    if (tools === undefined) {
      logger.info(
        'grok-server: no tools service in the agent scope — skipping the scoped shadow ask tool',
      )
      return
    }
    record.disposeShadow?.()
    record.disposeShadow = installShadowAsk(record.agent.ctx, questions)
  }

  /**
   * Resume one session, self-healing an interleaved shared log once before
   * failing: when the store was written by two frontends at once (Web UI +
   * grok TUI) the strict loader rejects the log; repair it and retry. Inside
   * the official host a session may already be LIVE (the web holds it): the
   * store rejects a second live Session, so adopt the live agent instead —
   * resume cannot and must not create a competing one. The returned handle
   * carries `adopted` so callers can build records that never dispose or
   * cancel a shared agent.
   */
  const resumeWithRepair = async (
    sessionId: SessionId,
  ): Promise<
    Awaited<ReturnType<typeof agents.resume>> & { adopted?: boolean }
  > => {
    const adopted = adoptLiveAgent(sessionId)
    if (adopted !== undefined) {
      // The handle shape callers consume (agent + dispose) is exactly the
      // adopted record; disposal is a no-op because ownership stays with the
      // agent's creator (the web host).
      return { agent: adopted.agent, dispose: adopted.dispose, adopted: true }
    }
    try {
      const composed = await composeFromPreset()
      return await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(config),
        ...(composed.setup !== undefined ? { setup: composed.setup } : {}),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (
        config.persistenceRoot === undefined ||
        !detail.includes('corrupt session log')
      ) {
        throw error
      }
      const { repairInterleavedLog } = await import('./repair.ts')
      if (!(await repairInterleavedLog(config.persistenceRoot, sessionId))) {
        throw error
      }
      const composed = await composeFromPreset()
      return await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: agentOptions(config),
        ...(composed.setup !== undefined ? { setup: composed.setup } : {}),
      })
    }
  }

  /** The shared artifact's size/mtime, or undefined when absent/unreadable. */
  const logIdentityOf = async (session: {
    header: SessionHeader
  }): Promise<{ size: number; mtimeMs: number } | undefined> => {
    if (config.persistenceRoot === undefined) return undefined
    const { stat } = await import('node:fs/promises')
    try {
      const st = await stat(
        sessionLogPath(
          config.persistenceRoot,
          session.header.cwd,
          String(session.header.id),
        ),
      )
      return { size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      return undefined
    }
  }

  /** Send a protocol update without letting a disconnected client fail an agent turn. */
  const notify = (notification: SessionNotification): void => {
    if (conn === undefined) return
    void conn.sessionUpdate(notification).catch((error: unknown) => {
      logger.warn(`grok-server: session/update failed: ${String(error)}`)
    })
    // Mirror the usage view to a status file for the optional usage panel
    // (scripts/usage-panel.mjs — a tmux side pane rendered from this file,
    // so the stock grok binary shows cache hit rate / in / out tokens without
    // any pager patch). Only notifications carrying a usage view write it;
    // a failed write must never disturb the agent turn.
    const usage = (
      notification._meta as { dshUsage?: unknown } | undefined
    )?.dshUsage
    if (usage === undefined) return
    void writeFile(
      usageStatusFile(),
      `${JSON.stringify({
        sessionId: String(notification.sessionId),
        updatedAt: Date.now(),
        usage,
      })}\n`,
    ).catch(() => {
      /* status file is best-effort; ignore write errors */
    })
  }

  const settlePrompt = (record: SessionRecord, reason: StopReason): void => {
    const inflight = record.inflight
    if (inflight === undefined) return
    record.inflight = undefined
    inflight.resolve(reason)
  }

  const rejectFromError = (
    inflight: NonNullable<SessionRecord['inflight']>,
    reason: Extract<TurnEndReason, { kind: 'error' }>,
  ): void => {
    inflight.reject(internalError(`turn failed: ${reason.error.message}`))
  }

  // Emit live stream updates: text/reasoning deltas as chunks, tool calls and
  // results as typed cards, todo writes as plan updates (the pager's todo pane
  // is fed by Plan updates). Turn settlement rides the same listener.
  const calls = new Map<string, ToolCallRecord>()
  const usageBySession = new Map<SessionId, SessionUsageState>()
  // Sessions whose first event already triggered the workspace attach.
  const workspaceAttached = new Set<SessionId>()

  /**
   * Account one session to its web workspace at its first TURN END, not at
   * session/new and not at the first event: persistence is lazy, so a
   * session the pager opens but never uses never materializes a log —
   * attaching earlier would book a ghost account for a session that does
   * not exist. The turn/end is the conversation barrier (the loop no longer
   * flushes at turn boundaries — checkpoint-policy owns durability — so a
   * flush is not an observable barrier in every runtime); the attach then
   * reaches the web host with the log in place and the host RESUMES the
   * session instead of creating a competing one.
   */
  const attachWorkspace = async (
    sessionId: SessionId,
    cwd: string,
    storageRoot: string,
  ): Promise<void> => {
    const fallback = (): Promise<void> =>
      attachSessionToWorkspace(storageRoot, String(sessionId), cwd)
        .then((outcome) => {
          if (outcome === 'cwd-unresolved') {
            logger.info(
              `grok-server: session ${sessionId} left ungrouped in the web workspace registry (${outcome})`,
            )
          }
        })
        .catch((error: unknown) => {
          logger.warn(
            `grok-server: could not attach session ${sessionId} to a web workspace: ${String(error)}`,
          )
        })
    // Durability barrier: the drain listener for the flush we observed runs
    // concurrently with this attach, so wait for the log file itself before
    // the web-host RPC. Without it the host can CREATE the session (its log
    // lands first) and this server's own materialize is rejected forever —
    // every turn of that session fails with "refusing to materialize".
    if (config.persistenceRoot !== undefined) {
      try {
        await waitForSessionLog(
          config.persistenceRoot,
          String(sessionId),
          2000,
        )
      } catch {
        logger.warn(
          `grok-server: session ${sessionId} log not observed after flush — attaching anyway`,
        )
      }
    }
    // Preferred path inside the official host: the SAME process owns the
    // workspace service, so attach through its in-memory registry directly —
    // the sidebar updates immediately and the next registry write republishes
    // memory that already includes the session (no stale-memory clobber, no
    // restart, no HTTP round trip). Falls back to the web-host RPC and then
    // the direct unit write for daemon mode, where the service is absent.
    const workspace = ctx.get('workspace') as
      | {
        resolveByPath(
          path: string,
        ): Promise<
            | { attachSession(sessionId: string): Promise<void> }
            | undefined
        >
        create(
          path: string,
          title?: string,
        ): Promise<{ attachSession(sessionId: string): Promise<void> }>
      }
      | undefined
    if (workspace !== undefined) {
      try {
        const existing = await workspace.resolveByPath(cwd)
        const ws = existing ?? (await workspace.create(cwd))
        await ws.attachSession(String(sessionId))
        return
      } catch (error: unknown) {
        logger.warn(
          `grok-server: in-process workspace attach failed (${String(error)}), falling back`,
        )
      }
    }
    // Preferred path with a RUNNING web host (daemon mode): the host's own API
    // gateway. The host attaches in ITS in-memory registry, so the sidebar
    // shows the grouping immediately and the host's next registry write
    // republishes its memory (which now includes the session) — no
    // stale-memory clobber, no restart.
    if (config.webPort !== undefined) {
      try {
        await attachSessionViaWebHost(
          { origin: `http://127.0.0.1:${config.webPort}` },
          String(sessionId),
          cwd,
        )
        return
      } catch (error: unknown) {
        logger.info(
          `grok-server: web-host attach unavailable (${String(error)}), writing the shared unit directly`,
        )
      }
    }
    await fallback()
  }

  const disposeEvents = ctx.on(
    'session/event',
    (session, event: SessionEvent) => {
      const record = sessions.get(session.header.id)
      if (record === undefined || record.agent.session !== session) return
      try {
        let usage = usageBySession.get(session.header.id)
        if (usage === undefined) {
          usage = createUsageState()
          usageBySession.set(session.header.id, usage)
        }
        const view = foldUsageWithView(usage, event)
        // A changed view with no wire surface (e.g. the usage chunk itself)
        // still needs to reach the pager, or the context/stats bar would lag
        // one request; the standard usage_update body is ignored by the pager
        // but its `_meta` refreshes both bars immediately.
        if (view !== null) {
          notify(
            buildUsageUpdateNotification(session.header.id, view, event, false),
          )
        }
        for (const update of translateEvent(
          session.header.id,
          event,
          calls,
          false,
          view ?? undefined,
        ))
          notify(update)
      } finally {
        const inflight = record.inflight
        if (
          inflight !== undefined &&
          event.type === 'turn/end' &&
          inflight.turn === event.data.turn
        ) {
          if (event.data.reason.kind === 'error') {
            record.inflight = undefined
            rejectFromError(inflight, event.data.reason)
          } else {
            record.inflight = undefined
            inflight.resolve(turnEndToStopReason(event.data.reason))
          }
        }
        // Workspace attach at the first turn/end: a conversation became real
        // (events flowed into the session), and a pager-opened session that
        // never prompts stays out of the web registry.
        if (
          event.type === 'turn/end' &&
          config.storageRoot !== undefined &&
          session.header.cwd !== undefined &&
          !workspaceAttached.has(session.header.id)
        ) {
          workspaceAttached.add(session.header.id)
          void attachWorkspace(
            session.header.id,
            session.header.cwd,
            config.storageRoot,
          )
        }
      }
    },
  )

  // The loop claims a queued prompt message for exactly one turn; that claim
  // (not the turn/start payload, which no longer carries a trigger) is the
  // prompt's correlation anchor for exact settlement.
  const disposeClaimed = ctx.on(
    'agent/inbox/claimed',
    ({ agent, message, turn }) => {
      const record = ownedRecord(agent)
      const inflight = record?.inflight
      if (inflight !== undefined && inflight.messageId === message.id)
        inflight.turn = turn
    },
  )

  const disposeFlush = ctx.on('session/flush', (session) => {
    const record = sessions.get(session.header.id)
    if (record === undefined || record.agent.session !== session) return
    // Adopted records have no alignment anchor (the host is the only writer),
    // so there is nothing to refresh.
    if (record.adopted === true) return
    // Refresh the pre-write alignment anchor: this flush is grok's own write,
    // so a prompt-time comparison against the previous anchor must not see it
    // as an external modification.
    void logIdentityOf(session).then((identity) => {
      const current = sessions.get(session.header.id)
      if (current === record && identity !== undefined)
        current.logIdentity = identity
    })
  })

  // Permission requests surface as the pager's permission dialog: the bridge
  // offers one-shot choices only and never infers a durable grant from an
  // unknown client response. Mirrors dsh-acp's machine-policy channel.
  //
  // Inside the official host the web's api-proxy registers its own
  // 'approval/request' answerer (the browser dialog) at boot; 'approval/request'
  // is a waterfall, so the FIRST listener to return an outcome claims the
  // request. Prepending puts the pager ahead of the browser: grok-owned
  // sessions answer in the TUI, web-exclusive sessions fall through `next()`
  // to the browser, and a session shared with the web is answered by
  // whichever frontend the user answers first (the pager dialog claims it
  // when shown). Standalone-daemon mode has no competing answerer.
  const disposeApproval = ctx.on(
    'approval/request',
    (request, next) => {
      const record = ownedRecord(request.agent)
      if (
        record === undefined ||
        request.callId === undefined ||
        conn === undefined
      )
        return next()
      return conn
        .requestPermission({
          sessionId: record.agent.session.id,
          toolCall: { toolCallId: request.callId },
          options: [
            {
              optionId: 'allow-once',
              name: 'Allow once',
              kind: 'allow_once',
            },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        })
        .then(({ outcome }) => {
          if (outcome.outcome === 'cancelled') return 'cancelled'
          return outcome.optionId === 'allow-once'
            ? 'allowed-once'
            : 'rejected'
        })
    },
    { prepend: true },
  )

  const agent: AcpAgent = {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      // Single-version agent: the spec's "same version if supported, else the
      // latest supported" both resolve to this server's one version.
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'dsh-grok-tui', version: '0.1.0' },
        agentCapabilities: {
          promptCapabilities: {
            image: false,
            audio: false,
            embeddedContext: false,
          },
        },
        // The grok pager fail-closes on an empty authMethods list (it shows
        // its own login screen); advertising the api_key method makes the
        // pager send an `authenticate` request we answer with Ok, skipping
        // login entirely. DSH owns credentials; the key never reaches grok.
        authMethods: [{ id: 'xai.api_key', name: 'xai.api_key' }],
        _meta: {
          defaultAuthMethodId: 'xai.api_key',
          // Model picker state: the DSH provider catalog (adapter-declared
          // models only; catalog lookups stay advisory like the gateway).
          modelState: await modelState(ctx, config, rememberedModel()),
        },
      }
    },

    authenticate(_params: AuthenticateRequest): Promise<void> {
      // The api_key method carries no credential DSH needs; the harness's own
      // credential provider resolves keys at request time.
      return Promise.resolve()
    },

    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      assertOpen()
      validateSessionParams(params)
      const sessionId = SessionId(
        typeof params._meta?.sessionId === 'string'
          ? params._meta.sessionId
          : randomUUID(),
      )
      // Official-host adoption: a session the web already holds is LIVE in
      // this process (the store rejects a second live Session on the same
      // id), so "new" degrades to sharing the web's agent — same as a second
      // browser tab. Outside the host this branch never fires (agents.get
      // only returns agents this process created).
      const adopted = adoptLiveAgent(sessionId)
      if (adopted !== undefined) {
        sessions.set(sessionId, adopted)
        installShadow(adopted)
        if (questions !== undefined)
          questions.register(String(sessionId), connectionRef())
        void connectionRef().extNotification('_x.ai/mcp_initialized', {
          sessionId: String(sessionId),
        })
        return { sessionId }
      }
      // Self-heal on-disk limbo before creating: dsh's create path skips
      // unreadable logs in list() but materialize still rejects a file that
      // exists ("refusing to materialize ... a log already exists on disk"),
      // which would fail every turn of this session forever. A valid log is
      // resumed instead (the persistence error's own guidance); an empty log
      // (no readable frame — nothing to lose) is removed so create succeeds.
      const persisted =
        config.persistenceRoot === undefined
          ? undefined
          : await sessionLogState(config.persistenceRoot, String(sessionId))
      if (persisted?.kind === 'empty') {
        logger.warn(
          `grok-server: removing empty session log for ${sessionId} (${persisted.path})`,
        )
        await removeSessionLog(
          config.persistenceRoot as string,
          String(sessionId),
        )
      }
      let handle:
        | Awaited<ReturnType<typeof agents.create>>
        | (Awaited<ReturnType<typeof agents.resume>> & { adopted?: boolean })
      if (persisted?.kind === 'valid') {
        logger.warn(
          `grok-server: session ${sessionId} already has a log on disk — resuming instead of creating`,
        )
        handle = await resumeWithRepair(sessionId)
      } else {
        try {
          const composed = await composeFromPreset()
          handle = await agents.create({
            sessionId,
            meta: { cwd: params.cwd, agentPreset: composed.agentPreset },
            agentOptions: agentOptions(config, rememberedModel()),
            ...(composed.setup !== undefined ? { setup: composed.setup } : {}),
          })
        } catch (error) {
          // A raced writer materialized the log between our scan and create;
          // follow the persistence error's own guidance (load/resume it
          // instead) rather than failing the conversation.
          const detail = error instanceof Error ? error.message : String(error)
          if (
            !detail.includes('refusing to materialize') &&
            !detail.includes('already exists')
          ) {
            throw error
          }
          logger.warn(
            `grok-server: create raced an existing log for ${sessionId} — resuming`,
          )
          handle = await resumeWithRepair(sessionId)
        }
      }
      /* v8 ignore next 4 -- a real socket close can race an in-flight create. */
      if (closed) {
        await handle.dispose()
        throw internalError('connection closed during session/new')
      }
      const logIdentity = await logIdentityOf(handle.agent.session)
      const record: SessionRecord = {
        agent: handle.agent,
        dispose: () => {
          return handle.dispose()
        },
        inflight: undefined,
        ...('adopted' in handle && handle.adopted === true
          ? { adopted: true }
          : {}),
        // A resumed session's artifact identity anchors the pre-write
        // alignment check; a freshly created session has no artifact yet and
        // stays unanchored until its first flush records one.
        ...(logIdentity === undefined ? {} : { logIdentity }),
      }
      sessions.set(sessionId, record)
      // The scoped shadow ask tool rides the owning connection's ACP channel.
      installShadow(record)
      // Workspace attach happens on the session's FIRST EVENT (see the
      // session/event listener): sessions the pager opens but never uses stay
      // out of the registry, and the web only ever sees real conversations.
      if (questions !== undefined)
        questions.register(String(sessionId), connectionRef())
      // DSH owns no MCP servers; declare initialization complete so the
      // pager's "Starting session…" seed indicator clears immediately
      // instead of lingering until its 30-second auto-expiry.
      // Leading underscore: agent→client extension notifications carry it on
      // the wire; the pager's Rust SDK rejects unprefixed extension methods.
      void connectionRef().extNotification('_x.ai/mcp_initialized', {
        sessionId: String(sessionId),
      })
      return { sessionId }
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      assertOpen()
      const sessionId = SessionId(params.sessionId)
      const record = requireSession(sessionId)
      if (record.inflight !== undefined) {
        throw invalidParams('a prompt is already in flight for this session')
      }
      if (promptHasUnsupportedContent(params.prompt)) {
        throw invalidParams(
          'only text and resource_link prompt content is supported',
        )
      }
      const text = acpPromptToText(params.prompt)
      if (text.trim().length === 0) throw invalidParams('empty prompt')

      await alignWithSharedLog(record, sessionId)

      if (ctx.agents.get(record.agent.id) !== record.agent) {
        throw internalError(
          'prompt was not queued: the agent was disposed outside the bridge',
        )
      }
      const stopReason = await new Promise<StopReason>((resolve, reject) => {
        const message = createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'user' },
        })
        const inflight: NonNullable<SessionRecord['inflight']> = {
          resolve,
          reject,
          messageId: message.id,
          turn: undefined,
        }
        record.inflight = inflight
        try {
          record.agent.followup(message)
          /* v8 ignore start -- future-proofing guard, see dsh-acp */
        } catch (error: unknown) {
          record.inflight = undefined
          const detail = error instanceof Error ? error.message : String(error)
          throw internalError(`prompt was not queued: ${detail}`)
        }
        /* v8 ignore stop */
        void record.agent.whenIdle().then(() => {
          if (record.inflight !== inflight || inflight.turn !== undefined)
            return
          // The prompt's turn never completed (admission discarded the
          // message, or the agent idled before the claim): report cancelled.
          record.inflight = undefined
          inflight.resolve('cancelled')
        })
      })
      return { stopReason }
    },

    cancel(params: CancelNotification): Promise<void> {
      const record = sessions.get(SessionId(params.sessionId))
      if (record === undefined) return Promise.resolve()
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
      return Promise.resolve()
    },

    async loadSession(
      params: LoadSessionRequest,
    ): Promise<LoadSessionResponse> {
      assertOpen()
      if (!isAbsolute(params.cwd))
        throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
      const sessionId = SessionId(params.sessionId)
      let record = sessions.get(sessionId)
      if (record === undefined) {
        // Cold or foreign-attached session: resume through the registry so the
        // loop adopts the persisted log and this connection owns the agent.
        // Self-heal interleaved logs: when the shared store was written by two
        // frontends at once (Web UI + grok TUI) the strict loader rejects the
        // log; repair it once and retry before failing.
        const handle = await resumeWithRepair(sessionId)
        /* v8 ignore next 4 -- a real socket close can race an in-flight resume. */
        if (closed) {
          await handle.dispose()
          throw internalError('connection closed during session/load')
        }
        record = {
          agent: handle.agent,
          dispose: () => {
            return handle.dispose()
          },
          inflight: undefined,
          ...(handle.adopted === true ? { adopted: true } : {}),
        }
        // Adopted records share the host's live agent: the disk artifact is
        // always written by this same process, so no alignment anchor exists
        // (and re-resuming a live session would fail anyway).
        if (handle.adopted !== true) {
          const logIdentity = await logIdentityOf(handle.agent.session)
          if (logIdentity !== undefined) record.logIdentity = logIdentity
        }
        sessions.set(sessionId, record)
        installShadow(record)
        if (questions !== undefined)
          questions.register(String(sessionId), connectionRef())
      }
      // Leading underscore: agent→client extension notifications carry it on
      // the wire; the pager's Rust SDK rejects unprefixed extension methods.
      void connectionRef().extNotification('_x.ai/mcp_initialized', {
        sessionId: String(sessionId),
      })
      // Replay the durable transcript as isReplay notifications; the pager
      // dedups by event id, so a later cursor is safe to ignore.
      await replaySession(sessionId, record.agent.session.events)
      return {}
    },

    async extMethod(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      // ACP wire convention: client→agent extension methods carry a leading
      // underscore (`_x.ai/session/list`); the Rust SDK strips it on decode and
      // this TypeScript SDK passes it through verbatim, so normalize here.
      if (method.startsWith('_')) method = method.slice(1)
      if (method === 'session/set_model') {
        // The pager's model switch (ACP SetSessionModelRequest); the SDK routes
        // it here because session/set_model is newer than the SDK's method map.
        const { sessionId, modelId, _meta } = params as {
          sessionId?: string
          modelId?: string
          _meta?: { reasoningEffort?: unknown }
        }
        if (typeof sessionId !== 'string' || typeof modelId !== 'string') {
          throw invalidParams(
            'session/set_model requires sessionId and modelId',
          )
        }
        const record = requireSession(SessionId(sessionId))
        const route = await resolveModelRoute(ctx, modelId)
        if (route === undefined) {
          throw invalidParams(
            `model not found in any provider catalog: ${modelId}`,
          )
        }
        const resolved = await ctx.llm.resolveCallConfig(route)
        const effort = mapGrokEffort(_meta?.reasoningEffort)
        // Install the listener pair ONCE per record and update the selection
        // in place. Reinstalling per switch would stack `agent/request`
        // waterfall listeners; the outermost (first-installed) one then
        // re-applies its STALE selection over the newer inner result, so the
        // model would visibly change in the pager but silently revert at
        // request time.
        if (record.modelSelectionRef === undefined) {
          record.modelSelectionRef = { current: undefined, assembled: undefined }
          record.disposeModelSelection = installModelSelection(
            record.agent.ctx,
            record.modelSelectionRef,
          )
        }
        record.modelSelectionRef.current = {
          provider: resolved.provider,
          model: resolved.model,
          ...(effort === undefined
            ? {}
            : { reasoningEffort: ReasoningEffortId(effort) }),
        }
        if (lastModel !== undefined && config.lastModelFile !== undefined) {
          // Persist the ROUTE-ENCODED id so a later session/new routes to the
          // same provider even when the model id exists under several routes.
          lastModel.current = `${resolved.provider}${MODEL_ROUTE_SEPARATOR}${resolved.model}`
          void persistLastModel(config.lastModelFile, lastModel.current)
        }
        return {}
      }
      if (method === 'x.ai/session/list') {
        // The pager's resume picker asks the agent for its session catalog
        // (x.ai/session/list); DSH serves the persisted sessions. Sessions
        // without a usable first user prompt are skipped — the picker drops
        // them anyway. The store is shared with the DSH Web UI, so the catalog
        // can far exceed the pager's 30-row page: serve up to 100 and rank by
        // LAST activity (log mtime), not creation time — otherwise the web
        // sessions (older by creation) vanish below the grok-dsh ones.
        // Sessions the user archived in the web UI stay out of the catalog.
        const persistence = ctx.get('sessionPersistence') as
          | {
            list(signal?: AbortSignal): Promise<SessionHeader[]>
            inspect(
              id: SessionId,
              signal?: AbortSignal,
            ): Promise<{ meta: SessionHeader; events: SessionEvent[] }>
          }
          | undefined
        if (persistence === undefined) return { sessions: [] }
        const requested = (params as { limit?: unknown }).limit
        // The pager pages at 30, but the shared store holds far more and we
        // serve the whole catalog in one response (no next-cursor paging), so
        // never truncate below the full catalog size.
        const limit = Math.max(
          100,
          typeof requested === 'number' ? requested : 30,
        )
        const archived =
          config.storageRoot === undefined
            ? new Set<string>()
            : await readArchivedSessionIds(config.storageRoot)
        const headers = [...(await persistence.list())].filter(
          header => !archived.has(String(header.id)),
        )
        const { stat } = await import('node:fs/promises')
        const ranked = await Promise.all(
          headers.map(async (header) => {
            let lastActive = header.createdAt
            if (config.persistenceRoot !== undefined) {
              try {
                const st = await stat(
                  sessionLogPath(
                    config.persistenceRoot,
                    header.cwd,
                    String(header.id),
                  ),
                )
                if (st.mtimeMs > lastActive) lastActive = st.mtimeMs
              } catch {
                /* missing/unreadable artifact: keep createdAt */
              }
            }
            return { header, lastActive }
          }),
        )
        ranked.sort((a, b) => b.lastActive - a.lastActive)
        const sessions: Array<Record<string, unknown>> = []
        for (const { header, lastActive } of ranked.slice(0, limit)) {
          const firstPrompt =
            config.persistenceRoot === undefined
              ? await firstUserPrompt(persistence, header)
              : ((await firstUserPromptFromLog(
                config.persistenceRoot,
                header,
              )) ?? (await firstUserPrompt(persistence, header)))
          if (firstPrompt === undefined) continue
          // The automatic session title (fallback then LLM-generated, written
          // as session/title events by the host's session-title service) is
          // the picker's row label — same as the web UI. Fall back to the raw
          // first prompt when the title events are outside the scan budget.
          const autoTitle =
            config.persistenceRoot === undefined
              ? undefined
              : await sessionTitleFromLog(config.persistenceRoot, header)
          const title = autoTitle ?? firstPrompt
          const iso = (ms: number): string => new Date(ms).toISOString()
          sessions.push({
            sessionId: String(header.id),
            cwd: header.cwd ?? '',
            createdAt: iso(header.createdAt),
            updatedAt: iso(lastActive),
            summary: title,
            firstPrompt,
            hostname: hostname(),
            source: 'local',
            title,
            // kind=chat routes the picker straight to session/load: for
            // non-chat entries the pager first looks the session up in ITS
            // local store and shows "Session not found locally" without ever
            // asking the agent. DSH sessions live in DSH persistence, so the
            // conversation lane (agent-backed restore) is the correct path.
            _meta: { 'x.ai/session': { kind: 'chat' } },
          })
        }
        return {
          sessions,
          nextCursor: null,
          // All-scope: the picker treats the catalog as directory-wide and
          // renders the correct empty notice; without this the pager assumes
          // a cwd-scoped browse. `meta` mirrors the grok-shell spelling.
          _meta: { 'x.ai/listScope': 'all' },
          meta: { listScope: 'all' },
        }
      }
      if (method === 'x.ai/commands/list') {
        // The pager refreshes its slash-command registry from the agent; DSH's
        // command registry stays host-side for now, so an empty catalog keeps
        // the pager's builtins authoritative without an error round-trip.
        return { commands: [] }
      }
      // Informational grok extensions (bundle status, billing, prompt history,
      // marketplace, session info): empty results keep the pager's auxiliary
      // surfaces quiet; anything else fails with method-not-found.
      if (method.startsWith('x.ai/')) {
        return {}
      }
      throw RequestError.methodNotFound(method)
    },

    extNotification(
      method: string,
      params: Record<string, unknown>,
    ): Promise<void> {
      // Extension notifications (the pager's `_x.ai/log` telemetry, etc.) are
      // one-way and require no acknowledgement.
      void method
      void params
      return Promise.resolve()
    },
  }

  /**
   * Re-align a resumed session before writing when another frontend (the Web
   * UI) appended to the shared log since this server's last flush: dispose the
   * stale hold, resume fresh from disk — self-healing an interleaved log on
   * the way — and replay the merged transcript to the pager. Without this,
   * grok's in-memory seq counter would re-carry seqs the log already holds
   * and interleave the artifact. No-op for freshly created sessions (no
   * anchor) and when the artifact is unchanged.
   */
  const alignWithSharedLog = async (
    record: SessionRecord,
    sessionId: SessionId,
  ): Promise<void> => {
    if (
      record.logIdentity === undefined ||
      record.adopted === true ||
      config.persistenceRoot === undefined
    )
      return
    const { stat } = await import('node:fs/promises')
    let current: { size: number; mtimeMs: number } | undefined
    try {
      const st = await stat(
        sessionLogPath(
          config.persistenceRoot,
          record.agent.session.header.cwd,
          String(sessionId),
        ),
      )
      current = { size: st.size, mtimeMs: st.mtimeMs }
    } catch {
      current = undefined
    }
    if (
      current === undefined ||
      (current.size === record.logIdentity.size &&
        current.mtimeMs === record.logIdentity.mtimeMs)
    ) {
      return
    }
    logger.warn(
      `grok-server: session ${sessionId} was modified by another frontend — re-aligning before write`,
    )
    const staleDispose = record.dispose
    await staleDispose()
    const handle = await resumeWithRepair(sessionId)
    record.agent = handle.agent
    record.dispose = () => {
      return handle.dispose()
    }
    // The fresh agent has its own scope: reinstall the shadow ask tool and
    // re-register the session on this connection's question route.
    installShadow(record)
    if (questions !== undefined)
      questions.register(String(sessionId), connectionRef())
    // Anchor to the fresh artifact; fall back to the observed identity when a
    // transient stat fails, so the next prompt does not re-align in a loop.
    record.logIdentity = (await logIdentityOf(handle.agent.session)) ?? current
    await replaySession(sessionId, record.agent.session.events)
  }

  /** Replay a session's event log as isReplay notifications. */
  async function replaySession(
    id: SessionId,
    events: readonly SessionEvent[],
  ): Promise<void> {
    const replayCalls = new Map<string, ToolCallRecord>()
    let usage = usageBySession.get(id)
    if (usage === undefined) {
      usage = createUsageState()
      usageBySession.set(id, usage)
    }
    for (const event of events) {
      // Fold the durable history so a resumed session's stats and context
      // bar reflect the whole log (the live listener only sees new events).
      // A changed view also emits its usage_update so the bars are correct
      // immediately after the replay, not after the next live event.
      const view = foldUsageWithView(usage, event)
      if (view !== null) {
        notify(buildUsageUpdateNotification(id, view, event, true))
      }
      for (const update of translateEvent(
        id,
        event,
        replayCalls,
        true,
        view ?? undefined,
      ))
        notify(update)
    }
  }

  const connection = new AgentSideConnection(() => agent, channel.stream)
  conn = connection
  const connectionRef = (): AgentSideConnection => connection
  void connection.closed
    .catch((error: unknown) => {
      logger.warn(
        `grok-server: connection closed with an error: ${String(error)}`,
      )
    })
    .then(() => {
      return quiesce()
    })
    .catch((error: unknown) => {
      logger.warn(`grok-server: connection teardown failed: ${String(error)}`)
    })

  let quiescing: Promise<void> | undefined
  const quiesce = (): Promise<void> => {
    if (quiescing !== undefined) return quiescing
    closed = true
    disposeEvents()
    disposeClaimed()
    disposeFlush()
    disposeApproval()
    const records = [...sessions.values()]
    sessions.clear()
    if (questions !== undefined) {
      for (const record of records)
        questions.unregister(String(record.agent.session.id))
    }
    for (const record of records) {
      record.disposeShadow?.()
      record.disposeModelSelection?.()
      // Adopted agents are owned by the web host (or another connection);
      // cancelling them would abort a turn the user started elsewhere. The
      // record's OWN inflight (a prompt this connection queued) is still
      // settled: that prompt belongs to the disconnecting client.
      if (record.adopted === true) {
        settlePrompt(record, 'cancelled')
        continue
      }
      record.agent.cancel({ kind: 'user' })
      settlePrompt(record, 'cancelled')
    }
    quiescing = (async () => {
      const disposals = await Promise.allSettled(
        records.map(record => record.dispose()),
      )
      const failures: unknown[] = []
      for (const result of disposals) {
        if (result.status === 'rejected')
          failures.push(result.reason as unknown)
      }
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `grok connection agent teardown failed for ${failures.length} session(s)`,
        )
      }
    })()
    return quiescing
  }

  return { connection, dispose: quiesce }
}

/**
 * Build per-agent options from plugin config without assigning absent optional fields.
 * A remembered model may be route-encoded (`provider@model` — see
 * `MODEL_ROUTE_SEPARATOR`): a model id existing under several provider
 * routes must pin the exact route, otherwise the configured default provider
 * would shadow the user's choice. Legacy plain ids keep the old behavior.
 * @param config - ACP provider/model configuration.
 * @param remembered - the last model chosen in the pager, if any.
 * @returns the configured fields only.
 */
function agentOptions(
  config: GrokServerConfig,
  remembered?: string,
): { provider?: string; model?: string } {
  const rememberedModel = remembered ?? config.model
  if (rememberedModel === undefined) return {}
  const at = rememberedModel.indexOf(MODEL_ROUTE_SEPARATOR)
  if (at > 0) {
    return {
      provider: rememberedModel.slice(0, at),
      model: rememberedModel.slice(at + 1),
    }
  }
  return {
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...{ model: rememberedModel },
  }
}

/**
 * Reject session features outside the supported contract. `mcpServers` are
 * accepted and ignored: the grok client forwards its own config.toml MCP
 * servers (with secrets) on every session/new, and DSH owns its MCP surface —
 * the client's servers must not be spawned by the harness.
 */
function validateSessionParams(params: NewSessionRequest): void {
  if (!isAbsolute(params.cwd))
    throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (
    params.additionalDirectories !== undefined &&
    params.additionalDirectories.length > 0
  ) {
    throw invalidParams('additionalDirectories is not supported')
  }
}

/**
 * Wire separator between provider and model id for models that exist under
 * MORE THAN ONE provider route. The grok pager's model catalog keys entries
 * by model id (an IndexMap), so a duplicate id silently collapses to one
 * row; encoding the route into the id (`provider@model`) keeps every
 * provider's copy visible and selectable. `@` cannot appear in any current
 * adapter's model ids; the decode (resolveModelRoute) falls back to catalog
 * search for legacy unencoded ids.
 */
const MODEL_ROUTE_SEPARATOR = '@'

/**
 * Build the pager's model-picker state from the DSH provider catalog
 * (adapter-declared models across every registered provider). The wire shape
 * must match the pager's `SessionModelState`/`ModelInfo` serde exactly —
 * `currentModelId`/`availableModels`/`modelId` — plus per-model reasoning
 * effort metadata (`supportsReasoningEffort` + `reasoningEfforts`), so the
 * picker and `/model <id> <effort>` work.
 *
 * Models whose id exists under MULTIPLE provider routes get a route-encoded
 * wire id (`provider@model`) and a provider-suffixed display name
 * (`model (provider)`) — the pager keys its catalog by model id, so an
 * unencoded duplicate would collapse to one row (verified against the pager
 * source: `IndexMap<ModelId, ModelInfo>`). Unique models keep their plain
 * id/name so `/model <id>` keeps working unchanged. The encoded id round-
 * trips through session/set_model via `resolveModelRoute`.
 * @param ctx - the host context (llm service).
 * @param config - plugin config (preferred default model/effort).
 * @param remembered - the last model chosen in the pager (persisted across
 *   restarts); when present it becomes the advertised current model.
 * @returns the SessionModelState meta payload.
 */
async function modelState(
  ctx: Context,
  config: GrokServerConfig,
  remembered?: string,
): Promise<{
  currentModelId: string
  availableModels: Array<{
    modelId: string
    name: string
    description?: string
    _meta: Record<string, unknown>
  }>
}> {
  const effort = config.effort ?? 'max'
  // One row per (provider, model) catalog entry; `occurrences` counts how
  // many provider routes advertise each bare model id.
  const rows: Array<{
    provider: string
    modelId: string
    name: string
    contextWindow?: number
  }> = []
  const occurrences = new Map<string, number>()
  for (const provider of ctx.llm.listProviders()) {
    try {
      const listed = await ctx.llm.listModels(provider.id)
      for (const model of listed) {
        rows.push({
          provider: provider.id,
          modelId: model.id,
          name: model.name ?? model.id,
          // The pager's context bar reads `totalContextTokens` from the model
          // meta as its denominator; resolve the adapter-declared window.
          ...((await contextWindowFor(ctx, provider.id, model.id)) ?? {}),
        })
        occurrences.set(model.id, (occurrences.get(model.id) ?? 0) + 1)
      }
    } catch {
      // An adapter's catalog failure must not block initialization.
    }
  }
  const models: Array<{
    modelId: string
    name: string
    description?: string
    contextWindow?: number
  }> = rows.map((row) => {
    const duplicated = (occurrences.get(row.modelId) ?? 0) > 1
    return {
      // Duplicate ids must be distinguishable to the pager's id-keyed map.
      modelId: duplicated
        ? `${row.provider}${MODEL_ROUTE_SEPARATOR}${row.modelId}`
        : row.modelId,
      // The display name doubles as the /model completion insert text and
      // the exact-match query, so a duplicate carries its provider.
      name: duplicated ? `${row.name} (${row.provider})` : row.name,
      ...(duplicated ? { description: `provider: ${row.provider}` } : {}),
      ...(row.contextWindow === undefined
        ? {}
        : { contextWindow: row.contextWindow }),
    }
  })
  // The advertised current model prefers the LAST model the user picked in
  // the pager (persisted across restarts), so every new window opens on the
  // previous session's choice instead of the configured default. The
  // remembered id may be route-encoded (`provider@model`, matching the
  // available rows) or a legacy plain id; a plain id that exists under
  // several routes resolves to the config provider's copy so it is always
  // one of the available entries.
  let selected = ''
  const rememberedModel = remembered
  if (rememberedModel !== undefined) {
    if (models.some(m => m.modelId === rememberedModel)) {
      selected = rememberedModel
    } else if ((occurrences.get(rememberedModel) ?? 0) > 1) {
      const preferred = config.provider ?? rows.find(r => r.modelId === rememberedModel)?.provider
      const encoded = `${preferred ?? ''}${MODEL_ROUTE_SEPARATOR}${rememberedModel}`
      selected = models.some(m => m.modelId === encoded)
        ? encoded
        : (models[0]?.modelId ?? 'deepseek-v4-flash')
    } else {
      // Plain id that is not in the catalog anymore (model removed): fall
      // through to the configured default below.
      selected = ''
    }
  }
  if (selected === '') {
    const target = config.model ?? models[0]?.modelId ?? 'deepseek-v4-flash'
    const duplicatedTarget = (occurrences.get(target) ?? 0) > 1
    if (duplicatedTarget) {
      const preferred = config.provider ?? rows.find(r => r.modelId === target)?.provider
      selected = `${preferred ?? ''}${MODEL_ROUTE_SEPARATOR}${target}`
    } else {
      selected = models.some(m => m.modelId === target) ? target : (models[0]?.modelId ?? 'deepseek-v4-flash')
    }
  }
  return {
    currentModelId: selected,
    availableModels: models.map(model => ({
      ...model,
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: effort,
        // Context bar denominator; absent when the adapter knows no window.
        ...(model.contextWindow === undefined
          ? {}
          : { totalContextTokens: model.contextWindow }),
        reasoningEfforts: [
          {
            id: 'off',
            value: 'off',
            label: 'Off',
            description: 'No thinking',
            default: effort === 'off',
          },
          {
            id: 'high',
            value: 'high',
            label: 'High',
            description: 'Standard reasoning',
            default: effort === 'high',
          },
          {
            id: 'max',
            value: 'max',
            label: 'Max',
            description: 'Maximum reasoning',
            default: effort === 'max',
          },
        ],
      },
    })),
  }
}

/**
 * Resolve the adapter-declared context window for one exact route.
 * @param ctx - the host context (llm service).
 * @param provider - the owning provider route.
 * @param model - the model id.
 * @returns `{ contextWindow }` when the adapter knows the window, else `null`.
 */
async function contextWindowFor(
  ctx: Context,
  provider: string,
  model: string,
): Promise<{ contextWindow: number } | null> {
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model)
    return resolved.context === undefined
      ? null
      : { contextWindow: resolved.context.contextWindow }
  } catch {
    // A capability lookup failure must not block the model picker.
    return null
  }
}

/**
 * Resolve one model id to an exact (provider, model) route. A route-encoded
 * id (`provider@model`, as emitted by {@link modelState} for models that
 * exist under multiple provider routes) decodes directly; a legacy plain id
 * falls back to scanning every provider catalog — the first route that
 * declares it wins, matching the pre-encoding behavior.
 * @param ctx - the host context (llm service).
 * @param modelId - the model id as sent by the pager.
 * @returns the exact route, or undefined when no provider declares it.
 */
async function resolveModelRoute(
  ctx: Context,
  modelId: string,
): Promise<{ provider: string; model: string } | undefined> {
  const at = modelId.indexOf(MODEL_ROUTE_SEPARATOR)
  if (at > 0) {
    const provider = modelId.slice(0, at)
    const model = modelId.slice(at + 1)
    if (ctx.llm.listProviders().some(p => p.id === provider)) {
      return { provider, model }
    }
  }
  for (const info of ctx.llm.listProviders()) {
    const provider = info.id
    try {
      const listed = await ctx.llm.listModels(provider)
      if (listed.some(model => model.id === modelId)) {
        return { provider, model: modelId }
      }
    } catch {
      // Catalog failures are advisory; try the next provider.
    }
  }
  return undefined
}

/**
 * Map the pager's reasoning-effort value onto the harness vocabulary. The
 * pager's menu has seven levels (`none`…`max`); DSH adapters accept
 * `off`/`high`/`max` today. Levels below `high` fold to `off`, `xhigh` folds
 * to `high`, and `max` stays `max`; absent values leave the adapter default.
 * @param value - the pager's `_meta.reasoningEffort` value, when present.
 * @returns the harness effort id, or undefined to keep the adapter default.
 */
function mapGrokEffort(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  switch (value) {
    case 'none':
    case 'minimal':
    case 'low':
    case 'medium':
      return 'off'
    case 'high':
    case 'xhigh':
      return 'high'
    case 'max':
      return 'max'
    default:
      return undefined
  }
}

/** Fire-and-forget persistence of the remembered model. */
function persistLastModel(path: string, model: string): void {
  void writeFile(path, model, 'utf8').catch(() => {
    /* best-effort memory */
  })
}

/** Extract the first direct user prompt text of a persisted session. */
async function firstUserPrompt(
  persistence: {
    inspect(
      id: SessionId,
      signal?: AbortSignal,
    ): Promise<{ events: SessionEvent[] }>
  },
  header: SessionHeader,
): Promise<string | undefined> {
  try {
    const { events } = await persistence.inspect(header.id)
    for (const event of events) {
      if (event.type !== 'user/message') continue
      const source = event.data.source
      if (source.kind !== 'user') continue
      const text = event.data.content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )
        .map(block => block.text)
        .join('')
        .trim()
      if (text.length > 0) return text
    }
  } catch {
    // An unreadable log must not fail the whole catalog.
  }
  return undefined
}
