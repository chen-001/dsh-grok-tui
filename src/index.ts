/**
 * Grok leader-server plugin for DSH: makes the grok-build TUI
 * (`xai-grok-pager-bin`) a pure frontend for the harness. The plugin owns a
 * Unix socket speaking the grok leader wire protocol (register/ping/control
 * frames + ACP JSON-RPC payloads) and maps ACP methods onto `ctx.agents`.
 * Every kernel concern — system prompt, tools, model routing, persistence,
 * permissions — stays in DSH; grok-shell code never runs.
 * @module dsh-grok-tui
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// Type-only: activates Context merges for injected services
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Context } from 'cordis'
import Schema from 'schemastery'
import {
  createAcpAgent,
  type GrokServerConfig,
  type LastModelRef,
} from './acp-server.ts'
import { QuestionRouter } from './bridge/question.ts'
import { createLeaderServer, type LeaderConnection } from './leader.ts'
import {
  type SessionHealthWatch,
  startSessionHealthWatch,
} from './session-health.ts'
import { acpChannel } from './stream.ts'
import type { ClientMessage } from './types.ts'
import { LEADER_PROTOCOL_VERSION } from './types.ts'

export const name = 'grok-server'
export const inject = ['agents', 'llm']

/** Plugin config: optional socket override plus the initial agent target. */
export interface GrokServerPluginConfig extends GrokServerConfig {
  /** Leader socket path; defaults to $GROK_LEADER_SOCKET or ~/.grok/leader.sock. */
  socketPath?: string
}

export const Config: Schema<GrokServerPluginConfig> = Schema.object({
  socketPath: Schema.string(),
  provider: Schema.string(),
  model: Schema.string(),
  effort: Schema.string(),
  lastModelFile: Schema.string(),
  persistenceRoot: Schema.string(),
  storageRoot: Schema.string(),
  webPort: Schema.number(),
  userInteractionProvider: Schema.boolean(),
  healthWatch: Schema.boolean(),
  healthCheckIntervalMs: Schema.number(),
})

const SERVER_VERSION = 'dsh-grok-tui-0.1.0'

/**
 * Mount the grok leader server.
 * @param ctx - Cordis context carrying the agent factory and session events.
 * @param config - Optional socket path and initial provider/model target.
 */
export function apply(ctx: Context, config: GrokServerPluginConfig): void {
  const logger = ctx.logger
  // The bridge's default socket lives under $XDG_RUNTIME_DIR when set
  // (Linux multi-user: /run/user/<uid>, private + 0700), else /tmp — in both
  // cases NOT the official grok CLI's default (~/.grok/leader.sock): the
  // original grok TUI spawns its own leader process on that path when run
  // standalone, and grok-dsh's host detection would otherwise mistake that
  // foreign leader for this bridge and connect the TUI to the ORIGINAL grok
  // backend. grok-dsh.sh probes this path (GROK_HOST_SOCKET) and verifies
  // the leader identity by handshake before connecting. Staying out of the
  // DSH home also avoids dsh's chokidar file watchers crashing on unix
  // sockets on macOS (fs.watch UNKNOWN errno -102).
  const socketPath =
    config.socketPath ??
    process.env.GROK_LEADER_SOCKET ??
    join(process.env.XDG_RUNTIME_DIR?.trim() || '/tmp', 'grok-leader.sock')
  const connections = new Set<{ dispose: () => Promise<void> }>()
  // Raw leader connections, for the planned-shutdown broadcast: clients must
  // hear "the host is exiting on purpose" so they disconnect instead of
  // taking over the socket (a takeover would strand a foreign leader on this
  // path and block the next `dsh web` start).
  const leaderConns = new Set<LeaderConnection>()
  const questions = new QuestionRouter()
  let nextClientId = 1

  // The last model chosen in the TUI, shared across connections and
  // persisted so a server restart remembers it (new windows start on it).
  const lastModel: LastModelRef = { current: readLastModel(config) }

  // One user-interaction provider per context (the seam rejects a second):
  // questions ride the owning connection's ACP ext-method channel. In the
  // OFFICIAL HOST (the only deployment since v0.5.0) this registration must
  // be SKIPPED entirely: the web's api-proxy owns the single provider slot
  // (its browser question dialog), and whichever UI registers second fails
  // the whole plugin tree with DUPLICATE_PROVIDER. The host is selected by
  // config (userInteractionProvider: false in grok-server.yml) because it
  // cannot be auto-detected: grok-server activates before the api-proxy
  // registers, so `ctx.get('apiProxy')` is still undefined at apply time.
  // Since phase 1, grok sessions' asks ride per-agent scoped shadow tools
  // over the ACP x.ai/ask_user_question channel (src/bridge/shadow-ask.ts),
  // so host-mode questions no longer depend on this provider; the
  // registration below is kept only for non-host compositions that opt in
  // explicitly (userInteractionProvider: true).
  const userQuestions = ctx.get('userQuestions') as
    | {
      registerProvider(provider: {
        ask(request: unknown): Promise<unknown>
      }): () => void
    }
    | undefined
  const registerAsProvider = config.userInteractionProvider ?? false
  let disposeProvider: (() => void) | undefined
  if (userQuestions !== undefined && registerAsProvider) {
    try {
      disposeProvider = userQuestions.registerProvider({
        ask: (request: unknown) => {
          return questions.ask(
            request as Parameters<QuestionRouter['ask']>[0],
          )
        },
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (detail.includes('DUPLICATE_PROVIDER')) {
        // An unexpected second UI claimed the slot (e.g. a profile mounting
        // another question surface). Grok sessions still get their asks via
        // the scoped shadow tools, so this is not a service outage — but it
        // must not be silent.
        logger.warn(
          'grok-server: user-questions provider slot is already taken by ' +
            'another UI — grok questions keep riding the scoped shadow ask ' +
            'tools; the provider registration was skipped',
        )
      } else {
        throw error
      }
    }
  } else if (userQuestions !== undefined && !registerAsProvider) {
    // Official-host mode: the api-proxy serves the browser dialog; grok
    // sessions' asks ride the scoped shadow tools instead (see
    // src/bridge/shadow-ask.ts).
    logger.info(
      'grok-server: official-host mode (userInteractionProvider: false) — ' +
        'grok questions ride the scoped shadow ask tools; the web dialog ' +
        'serves web sessions',
    )
  }

  const server = createLeaderServer(socketPath, (connection) => {
    void handleConnection(connection)
  })

  logger.info(
    `grok-server: listening at ${server.path}; run the grok TUI with ` +
      `GROK_LEADER_SOCKET=${server.path} grok --leader`,
  )

  /** Answer one leader control command; unsupported commands error cleanly. */
  function handleControl(
    conn: LeaderConnection,
    msg: Extract<ClientMessage, { type: 'control' }>,
  ): void {
    const { request_id: requestId, command } = msg
    if (command?.type === 'get_leader_info') {
      conn.send({
        type: 'control_result',
        request_id: requestId,
        result: {
          Ok: {
            pid: process.pid,
            socket_path: socketPath,
            lock_path: `${socketPath}.lock`,
            ws_url_suffix: '-dsh-grok-tui',
            leader_protocol_version: LEADER_PROTOCOL_VERSION,
            leader_binary_version: SERVER_VERSION,
            profiling_supported: false,
            profiling_compiled_in: false,
            cpu_profile_active: false,
            profile_formats: [],
          },
        },
      })
      return
    }
    conn.send({
      type: 'control_result',
      request_id: requestId,
      result: {
        Err: {
          code: 'internal_error',
          message: `control not supported by ${SERVER_VERSION}: ${command?.type ?? '?'}`,
        },
      },
    })
  }

  /** Serve one accepted client until disconnect, then quiesce its agents. */
  async function handleConnection(conn: LeaderConnection): Promise<void> {
    leaderConns.add(conn)
    const channel = acpChannel(conn)
    const acp = createAcpAgent(
      ctx,
      config,
      channel,
      logger,
      questions,
      lastModel,
    )
    connections.add(acp)
    try {
      for (;;) {
        const message = await conn.next()
        if (message === undefined) break
        switch (message.type) {
          case 'register':
            conn.clientId = nextClientId++
            conn.send({
              type: 'registered',
              client_id: conn.clientId,
              ready: true,
              leader_protocol_version: LEADER_PROTOCOL_VERSION,
              leader_binary_version: SERVER_VERSION,
              leader_capabilities: { control_v1: true },
            })
            logger.info(
              `grok-server: client ${conn.clientId} registered (${message.client_type})`,
            )
            break
          case 'acp':
            channel.push(message.payload)
            break
          case 'ping':
            conn.send({ type: 'pong' })
            break
          case 'control':
            handleControl(conn, message)
            break
          case 'disconnect':
            conn.close()
            break
        }
      }
    } finally {
      leaderConns.delete(conn)
      channel.close()
      await acp.dispose()
      connections.delete(acp)
      logger.info('grok-server: client disconnected')
    }
  }

  ctx.effect(
    () => () => {
      // Announce the PLANNED shutdown before closing connections: clients
      // (grok TUIs, detached agent-leaders that inherited GROK_LEADER_SOCKET)
      // must treat the socket as vacated, not crashed-and-reclaimable, so no
      // foreign leader strands itself here while the host is away.
      for (const conn of leaderConns) {
        conn.send({ type: 'shutting_down', reason: 'manual', delay_ms: 0 })
        conn.close()
      }
      server.dispose()
      disposeProvider?.()
      for (const connection of connections) void connection.dispose()
    },
    'grok-server.server',
  )

  // Proactive self-healing of the SHARED session store: the DSH Web UI reads
  // history through its own strict loader, which this plugin cannot intercept,
  // so interleaved logs (two frontends appending with independent seq
  // counters) must be repaired before the Web UI reads them. The watch scans
  // the shared root and repairs stable interleaved artifacts.
  //
  // Inside the official host (the only deployment since v0.5.0) this watch is
  // DISABLED by default (healthWatch: false in grok-server.yml): one process
  // owns one seq counter per session (the coordinator rejects
  // out-of-continuation appends and the session store is a per-id singleton),
  // so no NEW interleaving can arise — the watch would only heal the retired
  // two-daemon era's legacy logs. Scanning a large store costs ~1s per few MB
  // of artifacts (zstd thread pool); a 355MB store took ~118s per pass, and
  // with the 15s interval the unguarded timer stacked concurrent passes into
  // ~487% CPU, starving the host event loop and freezing grok prompts.
  // Legacy interleaved logs are still repaired ON DEMAND by resumeWithRepair
  // when a session is opened. Compositions that want the proactive watch opt
  // in explicitly (healthWatch: true).
  let healthWatch: SessionHealthWatch | undefined
  if (
    config.persistenceRoot !== undefined &&
    (config.healthWatch ?? false)
  ) {
    healthWatch = startSessionHealthWatch({
      root: config.persistenceRoot,
      ...(config.healthCheckIntervalMs === undefined
        ? {}
        : { intervalMs: config.healthCheckIntervalMs }),
      logger: ctx.logger,
    })
    ctx.effect(
      () => () => {
        healthWatch?.dispose()
      },
      'grok-server.health-watch',
    )
  }
}

/** Load the remembered model from the lastModelFile, when configured. */
function readLastModel(config: GrokServerConfig): string | undefined {
  if (config.lastModelFile === undefined) return undefined
  try {
    const value = readFileSync(config.lastModelFile, 'utf8').trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}
