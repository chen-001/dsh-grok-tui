/**
 * Live verification of the scoped shadow ask_user_question (阶段 1).
 *
 * Drives the REAL host's grok leader socket: creates a session, prompts the
 * REAL model to call ask_user_question, answers the resulting ACP
 * x.ai/ask_user_question extension method as the TUI would, and asserts the
 * answer became the tool result (the prompt settles). This proves the
 * shadow tool is installed on grok agents inside the official host — a
 * browser-only routing would never produce an ext-method request and the
 * prompt would hang until its timeout.
 *
 * Usage (host running with the bridge):
 *   GROK_LEADER_SOCKET=... node --import <checkout>/node_modules/tsx/dist/esm/index.mjs \
 *     scripts/verify-shadow-live.mts
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  type Agent as AcpAgent,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
} from '@agentclientprotocol/sdk'

const socketPath =
  process.env.GROK_LEADER_SOCKET ?? join(homedir(), '.grok', 'leader.sock')
const cwd = process.env.DSH_VERIFY_CWD ?? process.cwd()

import { connect, type Socket } from 'node:net'

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
      client_type: 'verify-shadow',
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

async function main(): Promise<void> {
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
        transport.send({ type: 'acp', payload: JSON.stringify(message) })
      },
    }),
  }
  const extCalls: Array<{ method: string; params: Record<string, unknown> }> = []
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
      extMethod: async (method, params) => {
        extCalls.push({ method, params })
        // Answer every question with its first option, as the TUI would.
        const payload = params as {
          questions?: Array<{ question?: string; options?: Array<{ label?: string }> }>
        }
        const answers: Record<string, string[]> = {}
        for (const q of payload.questions ?? []) {
          const label = q.options?.[0]?.label ?? 'Yes'
          answers[q.question ?? ''] = [label]
        }
        return { outcome: 'accepted', answers }
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
          /* drop */
        }
      }
    }
  })()

  await client.initialize({ protocolVersion: PROTOCOL_VERSION })
  const created = await client.newSession({
    cwd,
    mcpServers: [],
    _meta: { sessionId: `verify-shadow-${Date.now()}` },
  })
  console.log(`session: ${created.sessionId}`)
  const stop = await client.prompt({
    sessionId: created.sessionId,
    prompt: [
      {
        type: 'text',
        text:
          'Before answering, call the ask_user_question tool with exactly one ' +
          'question "May I proceed?" and options [Yes, No]. Then continue ' +
          'based on the answer.',
      },
    ],
  })
  console.log(`prompt settled: stopReason=${stop.stopReason}`)
  if (extCalls.length === 0) {
    console.error('FAIL: no x.ai/ask_user_question ext-method arrived — the shadow tool is not installed')
    process.exit(1)
  }
  console.log(
    `PASS: ext-method ${extCalls[0]?.method} arrived with ${(extCalls[0]?.params as { questions?: unknown[] })?.questions?.length ?? 0} question(s)`,
  )
  transport.close()
}

main().catch((error: unknown) => {
  console.error('shadow live verification error:', error)
  process.exit(1)
})
