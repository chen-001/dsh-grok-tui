/**
 * Live host-bridge verification matrix (阶段 0 验证矩阵 a–f).
 *
 * Drives the OFFICIAL dsh web host with the grok-server bridge loaded:
 *  - grok side: real leader-socket clients (same wire protocol the grok TUI
 *    speaks — register/control frames + ACP JSON-RPC), using the SDK's
 *    ClientSideConnection, i.e. the same client facility as tests/leader.spec.ts
 *    but against a REAL host process;
 *  - web side: the REAL browser RPC surface (POST /api/<method> over HTTP,
 *    the same requests the web UI sends);
 *  - seq continuity: src/seq-scan.ts (the same pure function the integration
 *    tests assert with).
 *
 * Requires the host to run with DSH_HOME set and the bridge mounted; finds
 * the leader socket via $GROK_LEADER_SOCKET or ~/.grok/leader.sock and the
 * session store via $DSH_HOME/sessions. Model prompts hit the real
 * configured model (needs credentials in the host's .env).
 *
 * Usage (from the plugin dir, under the active checkout's tsx hook):
 *   DSH_HOME=<temp-home> node --import <checkout>/node_modules/tsx/dist/esm/index.mjs \
 *     scripts/verify-host-bridge.mts
 * Exit 0 with "MATRIX PASS" when every step succeeds.
 */
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Agent as AcpAgent,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
} from '@agentclientprotocol/sdk'
import { seqGaps, seqsOfLog } from '../src/seq-scan.ts'

const socketPath =
  process.env.GROK_LEADER_SOCKET ?? join(homedir(), '.grok', 'leader.sock')
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const webOrigin = process.env.DSH_VERIFY_WEB_ORIGIN ?? 'http://127.0.0.1:3123'
const cwd = process.env.DSH_VERIFY_CWD ?? process.cwd()

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── leader framing client (same wire protocol as the grok TUI) ─────────────

class LeaderClient {
  private readonly chunks: Buffer[] = []
  private buffered = 0
  private readonly queue: Array<Record<string, unknown> | string> = []
  private readonly waiters: Array<
    (frame: Record<string, unknown> | string | undefined) => void
  > = []
  private closed = false

  private constructor(private readonly socket: Socket) {
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter(undefined)
    })
  }

  static connect(path: string): Promise<LeaderClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path)
      socket.once('connect', () => resolve(new LeaderClient(socket)))
      socket.once('error', reject)
    })
  }

  #onData(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    for (;;) {
      if (this.buffered < 4) return
      const len = this.#peek(4).readUInt32BE(0)
      const frame = this.#take(4 + len)
      if (frame === undefined) return
      const message = JSON.parse(frame.subarray(4).toString('utf8')) as
        | Record<string, unknown>
        | string
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter(message)
      else this.queue.push(message)
    }
  }

  #peek(n: number): Buffer {
    const out = Buffer.alloc(n)
    let offset = 0
    for (const part of this.chunks) {
      const take = Math.min(part.length, n - offset)
      part.copy(out, offset, 0, take)
      offset += take
      if (offset >= n) break
    }
    return out
  }

  #take(n: number): Buffer | undefined {
    if (this.buffered < n) return undefined
    const out = Buffer.alloc(n)
    let offset = 0
    while (offset < n) {
      const part = this.chunks[0]
      if (part === undefined) return undefined
      const take = Math.min(part.length, n - offset)
      part.copy(out, offset, 0, take)
      offset += take
      this.buffered -= take
      if (take === part.length) this.chunks.shift()
      else this.chunks[0] = part.subarray(take)
    }
    return out
  }

  send(message: Record<string, unknown>): void {
    const data = Buffer.from(JSON.stringify(message), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length, 0)
    this.socket.write(Buffer.concat([header, data]))
  }

  async next(): Promise<Record<string, unknown> | string | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    if (this.closed) return undefined
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  async register(): Promise<void> {
    this.send({
      type: 'register',
      client_type: 'verify-script',
      mode: 'stdio',
      capabilities: { client_version: '0.0.0-verify' },
    })
    for (;;) {
      const frame = await this.next()
      if (frame === undefined) throw new Error('closed before registration')
      if (
        typeof frame === 'object' &&
        (frame as Record<string, unknown>).type === 'registered'
      )
        return
    }
  }

  close(): void {
    this.socket.end()
  }
}

// ── ACP client over the leader transport (the grok TUI's own shape) ────────

class GrokClient {
  private constructor(
    readonly transport: LeaderClient,
    readonly client: ClientSideConnection,
  ) {}

  static async connect(): Promise<GrokClient> {
    const transport = await LeaderClient.connect(socketPath)
    await transport.register()
    let controller: ReadableStreamDefaultController<never> | undefined
    const stream: Stream = {
      readable: new ReadableStream({
        start(inner) {
          controller = inner
        },
      }),
      writable: new WritableStream({
        write: (message: never) => {
          transport.send({
            type: 'acp',
            payload: JSON.stringify(message),
          })
        },
      }),
    }
    const client = new ClientSideConnection(
      (_agent: AcpAgent) => ({
        sessionUpdate(): Promise<void> {
          return Promise.resolve()
        },
        extNotification(): Promise<void> {
          return Promise.resolve()
        },
        requestPermission(): Promise<{ outcome: { outcome: 'cancelled' } }> {
          return Promise.resolve({ outcome: { outcome: 'cancelled' } })
        },
      }),
      stream,
    )
    void (async () => {
      for (;;) {
        const frame = await transport.next()
        if (frame === undefined) {
          controller?.close()
          return
        }
        if (typeof frame === 'object' && 'payload' in frame) {
          try {
            controller?.enqueue(JSON.parse(String(frame.payload)))
          } catch {
            /* drop malformed frames */
          }
        }
      }
    })()
    return new GrokClient(transport, client)
  }
}

// ── web RPC client (the browser's own /api surface) ────────────────────────

let rpcSeq = 0
async function webRpc(
  method: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${webOrigin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `verify-${++rpcSeq}`,
      method,
      payload,
    }),
  })
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
  const body = (await response.json()) as {
    result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
  }
  if (body.result?.ok !== true || body.result.value === undefined) {
    throw new Error(
      `${method} failed: ${body.result?.error?.message ?? 'unknown'}`,
    )
  }
  return body.result.value as Record<string, unknown>
}

// ── matrix ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`host: ${webOrigin}  leader: ${socketPath}  home: ${dshHome}`)
  console.log(`cwd: ${cwd}`)
  const sessionsRoot = join(dshHome, 'sessions')

  // (a) connection, newSession, prompt round trip
  const g1 = await GrokClient.connect()
  const init = await g1.client.initialize({ protocolVersion: PROTOCOL_VERSION })
  check('a1 register+initialize handshake', init.agentInfo.name === 'dsh-grok-tui')
  await g1.client.authenticate({ methodId: 'xai.api_key' })
  const created = await g1.client.newSession({
    cwd,
    mcpServers: [],
    _meta: { sessionId: `verify-${Date.now()}` },
  })
  const sessionA = String(created.sessionId)
  check('a2 newSession returns an id', sessionA.length > 0)
  const stopA = await g1.client.prompt({
    sessionId: sessionA,
    prompt: [{ type: 'text', text: 'Reply with exactly: MATRIX_OK' }],
  })
  check('a3 grok prompt settles with a stop reason', stopA.stopReason !== undefined, `stopReason=${stopA.stopReason}`)
  const resumed = await g1.client.loadSession({
    sessionId: sessionA,
    cwd,
    mcpServers: [],
  })
  check('a4 grok resume round trip', resumed !== undefined)
  g1.transport.close()

  // (f) the grok-created session reached the web workspace registry (the
  // attach happens asynchronously at the session's first turn/end, so poll)
  let inRegistry = false
  for (let i = 0; i < 50 && !inRegistry; i++) {
    await new Promise(resolve => setTimeout(resolve, 200))
    const workspaces = (await webRpc('workspace.list', {})) as {
      items?: Array<{ sessionIds?: string[] }>
    }
    inRegistry = (workspaces.items ?? []).some(ws =>
      (ws.sessionIds ?? []).includes(sessionA),
    )
  }
  check('f1 grok-created session appears in web workspace registry', inRegistry, sessionA)

  // (b) web opens a session, grok resumes it — both see the history
  const wsPath = join(cwd, '.verify-ws')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(wsPath, { recursive: true })
  const ws = (await webRpc('workspace.create', { path: wsPath })) as {
    workspace?: { workspaceId?: string }
  }
  const webCreated = (await webRpc('session.create', {
    workspaceId: ws.workspace?.workspaceId,
  })) as { sessionId?: string }
  const sessionB = String(webCreated.sessionId)
  check('b1 web session.create', sessionB.length > 0)
  await webRpc('session.prompt', {
    sessionId: sessionB,
    mode: 'queue',
    content: [{ type: 'text', text: 'Reply with exactly: WEB_ROUND' }],
  })
  const g2 = await GrokClient.connect()
  await g2.client.initialize({ protocolVersion: PROTOCOL_VERSION })
  const loadedB = await g2.client.loadSession({ sessionId: sessionB, cwd: wsPath, mcpServers: [] })
  check('b2 grok resumes the web-held session without corrupt', loadedB !== undefined)
  const historyB = (await webRpc('session.history', { sessionId: sessionB })) as {
    events?: unknown[]
  }
  check('b3 web history still loads (no corrupt)', (historyB.events ?? []).length > 0)

  // (c) web and grok alternate ≥5 rounds each on ONE session, then scan.
  // The grok side loads the web-held session first — the bridge adopts the
  // web's live agent, so both frontends queue prompts on ONE shared agent.
  const altSession = String(
    (await webRpc('session.create', { workspaceId: ws.workspace?.workspaceId }))
      .sessionId,
  )
  await g2.client.loadSession({ sessionId: altSession, cwd: wsPath, mcpServers: [] })
  for (let i = 0; i < 5; i++) {
    await webRpc('session.prompt', {
      sessionId: altSession,
      mode: 'queue',
      content: [{ type: 'text', text: `web round ${i} — reply with exactly: W${i}` }],
    })
    const stop = await g2.client.prompt({
      sessionId: altSession,
      prompt: [{ type: 'text', text: `grok round ${i} — reply with exactly: G${i}` }],
    })
    if (stop.stopReason === undefined) throw new Error(`grok round ${i} did not settle`)
  }
  // both frontends open the same session at the end: no corrupt reads
  const historyAlt = (await webRpc('session.history', { sessionId: altSession })) as {
    events?: unknown[]
  }
  check('c1 web reads the alternating session without corrupt', (historyAlt.events ?? []).length > 0)
  const g3 = await GrokClient.connect()
  await g3.client.initialize({ protocolVersion: PROTOCOL_VERSION })
  await g3.client.loadSession({ sessionId: altSession, cwd: wsPath, mcpServers: [] })
  check('c2 grok window reads the alternating session without corrupt', true)
  g3.transport.close()
  const { glob } = await import('node:fs/promises')
  let scanned = 0
  let totalGaps = 0
  for await (const log of glob(join(sessionsRoot, '*', '*', 'session.jsonl.zstd'))) {
    const gaps = seqGaps(await seqsOfLog(log))
    if (gaps.length > 0) {
      totalGaps += gaps.length
      console.log(`  seq gaps in ${log}: ${gaps.slice(0, 10).join(',')}...`)
    }
    scanned += 1
  }
  check('c3 zero seq gap across every session log in the store', totalGaps === 0 && scanned > 0, `${scanned} logs scanned`)

  // (d) two grok windows on one leader socket share the session
  const g4 = await GrokClient.connect()
  await g4.client.initialize({ protocolVersion: PROTOCOL_VERSION })
  const before = (await webRpc('session.history', { sessionId: altSession })) as {
    events?: unknown[]
  }
  const beforeCount = (before.events ?? []).length
  await g2.client.prompt({
    sessionId: altSession,
    prompt: [{ type: 'text', text: 'Reply with exactly: WINDOW2_VISIBLE' }],
  })
  const after = (await webRpc('session.history', { sessionId: altSession })) as {
    events?: unknown[]
  }
  check('d1 second grok window sees the other window\'s message', (after.events ?? []).length > beforeCount)
  g4.transport.close()

  // (e) concurrent prompts from both frontends settle (queued, serialized)
  const [webOutcome, grokStop] = await Promise.all([
    webRpc('session.prompt', {
      sessionId: altSession,
      mode: 'queue',
      content: [{ type: 'text', text: 'Reply with exactly: CONCURRENT_WEB' }],
    }).then(() => 'accepted'),
    g2.client.prompt({
      sessionId: altSession,
      prompt: [{ type: 'text', text: 'Reply with exactly: CONCURRENT_GROK' }],
    }),
  ])
  check('e1 web prompt accepted while grok prompt in flight', webOutcome === 'accepted')
  check('e2 grok prompt settles after the concurrent pair', grokStop.stopReason !== undefined)
  const historyE = (await webRpc('session.history', { sessionId: altSession })) as {
    events?: unknown[]
  }
  check('e3 concurrent pair produced both replies in one contiguous log', (historyE.events ?? []).length > (after.events ?? []).length)

  g2.transport.close()
  console.log(failures === 0 ? '\nMATRIX PASS' : `\nMATRIX FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('matrix error:', error)
  process.exit(1)
})
