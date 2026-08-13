/**
 * Shared fixtures: a raw leader-protocol test client over a Unix socket plus
 * the scripted LLM adapter and bridge harness (adapted from
 * `@deepseek-ai/dsh-acp`'s tests, which mount the REAL agent loop with a mock
 * provider so no API key is needed).
 */

import { connect, type Socket } from 'node:net'
import {
  type Agent as AcpAgent,
  type Client,
  ClientSideConnection,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
} from '@agentclientprotocol/sdk'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Context } from 'cordis'
import * as GrokServer from '../src/index.ts'

/** Scripted adapter for protocol tests (identical to dsh-acp's). */
export class MockAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: (StreamChunk[] | 'hang')[],
    private readonly modelIds: string[] = ['mock'],
    private readonly contextWindow?: number,
    /** The provider route this adapter serves (default 'mock'). */
    private readonly providerId = 'mock',
  ) {
    super()
  }

  override providerInfo(provider: string) {
    if (provider !== this.providerId)
      throw new Error(`MockAdapter: unknown provider ${provider}`)
    return { id: this.providerId, name: 'Mock' }
  }

  override listModels(provider: string) {
    return Promise.resolve(
      provider === this.providerId
        ? this.modelIds.map(id => ({
          provider: this.providerId,
          id,
          name: id,
        }))
        : [],
    )
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...(this.contextWindow === undefined
        ? {}
        : { context: { contextWindow: this.contextWindow } }),
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('MockAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('aborted'))
          },
          { once: true },
        )
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** Scripted text response ending in a clean stop. */
export function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...Array.from(text, (char): StreamChunk => {
      return { type: 'text-delta', index: 0, text: char }
    }),
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Scripted response that fails after publishing an uncommitted partial chunk. */
export function errorResponse(message: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial' },
    {
      type: 'finish',
      reason: { kind: 'error', failure: { message, code: 'PROVIDER_ERROR' } },
    },
  ]
}

/** One raw client-side frame; control messages are objects, acp is a JSON string. */
type TestFrame =
  | { kind: 'control'; message: Record<string, unknown> }
  | { kind: 'acp'; payload: string }

/**
 * Minimal leader-protocol client for tests: length-prefixed JSON frames over
 * a Unix socket, with a queue of parsed server frames.
 */
export class LeaderTestClient {
  private readonly socket: Socket
  private readonly chunks: Buffer[] = []
  private buffered = 0
  private readonly queue: TestFrame[] = []
  private readonly waiters: Array<(frame: TestFrame | undefined) => void> = []
  private closed = false

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', chunk => this.#onData(chunk))
    socket.on('error', () => {
      /* teardown is driven by close */
    })
    socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter(undefined)
    })
  }

  static connect(socketPath: string): Promise<LeaderTestClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(socketPath)
      socket.once('connect', () => resolve(new LeaderTestClient(socket)))
      socket.once('error', reject)
    })
  }

  #onData(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    for (;;) {
      if (this.buffered < 4) return
      const header = this.#peek(4)
      const len = header.readUInt32BE(0)
      const frame = this.#take(4 + len)
      if (frame === undefined) return
      const message = JSON.parse(frame.subarray(4).toString('utf8')) as Record<
        string,
        unknown
      >
      const parsed: TestFrame =
        message.type === 'acp'
          ? { kind: 'acp', payload: String(message.payload) }
          : { kind: 'control', message }
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter(parsed)
      else this.queue.push(parsed)
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
      const take = Math.min(part.length, n - offset)
      part.copy(out, offset, 0, take)
      offset += take
      this.buffered -= take
      if (take === part.length) this.chunks.shift()
      else this.chunks[0] = part.subarray(take)
    }
    return out
  }

  sendControl(message: Record<string, unknown>): void {
    this.#sendFrame(JSON.stringify(message))
  }

  sendAcp(payload: string): void {
    this.sendControl({ type: 'acp', payload })
  }

  #sendFrame(json: string): void {
    const data = Buffer.from(json, 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length, 0)
    this.socket.write(Buffer.concat([header, data]))
  }

  async nextFrame(): Promise<TestFrame | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    if (this.closed) return undefined
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** Register with the server and wait for the registration confirmation. */
  async register(): Promise<Record<string, unknown>> {
    this.sendControl({
      type: 'register',
      client_type: 'test-client',
      mode: 'stdio',
      capabilities: { client_version: '0.0.0-test' },
    })
    for (;;) {
      const frame = await this.nextFrame()
      if (frame === undefined)
        throw new Error('connection closed before registration')
      if (frame.kind === 'control' && frame.message.type === 'registered')
        return frame.message
    }
  }

  close(): void {
    this.socket.end()
  }
}

/**
 * ACP-facing test client: bridges the leader socket into the SDK's
 * `ClientSideConnection` (register + control frames handled inline, acp
 * frames parsed as JSON-RPC objects).
 */
export class AcpTestClient {
  readonly client: ClientSideConnection

  private constructor(
    readonly transport: LeaderTestClient,
    makeClient: (agent: AcpAgent) => Client,
  ) {
    let controller: ReadableStreamDefaultController<never> | undefined
    const stream: Stream = {
      readable: new ReadableStream({
        start(inner) {
          controller = inner
        },
      }),
      writable: new WritableStream({
        write: (message: never) => {
          transport.sendAcp(JSON.stringify(message))
        },
      }),
    }
    this.client = new ClientSideConnection(makeClient, stream)
    void (async () => {
      for (;;) {
        const frame = await transport.nextFrame()
        if (frame === undefined) {
          controller?.close()
          return
        }
        if (frame.kind === 'control') continue // registered/pong handled by callers
        try {
          controller?.enqueue(JSON.parse(frame.payload))
        } catch {
          /* drop */
        }
      }
    })()
  }

  static async connect(
    socketPath: string,
    makeClient: (agent: AcpAgent) => Client,
  ): Promise<AcpTestClient> {
    const transport = await LeaderTestClient.connect(socketPath)
    await transport.register()
    return new AcpTestClient(transport, makeClient)
  }
}

export interface GrokHarness {
  ctx: Context
  adapter: MockAdapter
  updates: SessionNotification['update'][]
  /** Full notifications (update + _meta), for replay-marker assertions. */
  notifications: SessionNotification[]
  /** Agent→client extension notifications (e.g. x.ai/mcp_initialized). */
  extNotifications: Array<{ method: string; params: Record<string, unknown> }>
  permissionRequests: RequestPermissionRequest[]
  onPermission: (
    request: RequestPermissionRequest,
  ) => RequestPermissionResponse
  loopFiber: Awaited<ReturnType<Context['plugin']>>
  dispose: () => Promise<void>
}

/** Mount the real agent loop + mock adapter + the grok server plugin. */
export async function makeGrokHarness(options: {
  socketPath: string
  script?: (StreamChunk[] | 'hang')[]
  models?: string[]
  /** Initial model id for created agents (default 'mock'). */
  model?: string
  lastModelFile?: string
  storageRoot?: string
  /** Port of a fake/real web host API gateway the attach goes through. */
  webPort?: number
  contextWindow?: number
}): Promise<GrokHarness> {
  const adapter = new MockAdapter(
    options.script ?? [],
    options.models,
    options.contextWindow,
  )
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  const updates: SessionNotification['update'][] = []
  const notifications: SessionNotification[] = []
  const extNotifications: Array<{
    method: string
    params: Record<string, unknown>
  }> = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: GrokHarness = {
    ctx,
    adapter,
    updates,
    notifications,
    extNotifications,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    loopFiber,
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }

  await ctx.plugin({
    name: 'grok-server-test',
    inject: [...GrokServer.inject],
    apply: (inner: Context) => {
      GrokServer.apply(inner, {
        socketPath: options.socketPath,
        provider: 'mock',
        model: options.model ?? 'mock',
        ...(options.lastModelFile === undefined
          ? {}
          : { lastModelFile: options.lastModelFile }),
        ...(options.storageRoot === undefined
          ? {}
          : { storageRoot: options.storageRoot }),
        ...(options.webPort === undefined ? {} : { webPort: options.webPort }),
      })
    },
  })
  harness.updates = updates
  return harness
}

/** A client that records updates and routes permission answers through the harness hook. */
export function recordingClient(
  harness: GrokHarness,
): (agent: AcpAgent) => Client {
  return (_agent: AcpAgent): Client => ({
    sessionUpdate(params: SessionNotification): Promise<void> {
      harness.updates.push(params.update)
      harness.notifications.push(params)
      return Promise.resolve()
    },
    extNotification(
      method: string,
      params: Record<string, unknown>,
    ): Promise<void> {
      harness.extNotifications.push({ method, params })
      return Promise.resolve()
    },
    requestPermission(
      params: RequestPermissionRequest,
    ): Promise<RequestPermissionResponse> {
      harness.permissionRequests.push(params)
      return Promise.resolve(harness.onPermission(params))
    },
  })
}

/**
 * Host-bridge harness: the OFFICIAL host shape in one process — real agent
 * loop + JSONL persistence (independent temporary root) + the grok server
 * plugin in host mode (`userInteractionProvider: false`). "Web" clients are
 * driven through `ctx.agents` directly, exactly the path the web api-proxy's
 * ensureSession uses (create/resume + followup + whenIdle), so a web-held
 * session is LIVE in this process and the grok bridge must adopt its agent.
 */
export async function makeHostBridgeHarness(options: {
  socketPath: string
  persistenceRoot: string
  storageRoot?: string
  script?: (StreamChunk[] | 'hang')[]
  models?: string[]
  contextWindow?: number
}): Promise<GrokHarness> {
  const adapter = new MockAdapter(
    options.script ?? [],
    options.models,
    options.contextWindow,
  )
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const { default: SessionPersistenceJsonl } = await import(
    '@deepseek-ai/dsh-session-persistence-jsonl',
  )
  await ctx.plugin(SessionPersistenceJsonl, {
    root: options.persistenceRoot,
    compression: 'zstd',
  })

  const updates: SessionNotification['update'][] = []
  const notifications: SessionNotification[] = []
  const extNotifications: Array<{
    method: string
    params: Record<string, unknown>
  }> = []
  const permissionRequests: RequestPermissionRequest[] = []
  const harness: GrokHarness = {
    ctx,
    adapter,
    updates,
    notifications,
    extNotifications,
    permissionRequests,
    onPermission: () => ({ outcome: { outcome: 'cancelled' } }),
    loopFiber,
    dispose: async () => {
      await ctx.fiber.dispose()
    },
  }

  await ctx.plugin({
    name: 'grok-server-test',
    inject: [...GrokServer.inject],
    apply: (inner: Context) => {
      GrokServer.apply(inner, {
        socketPath: options.socketPath,
        provider: 'mock',
        model: 'mock',
        persistenceRoot: options.persistenceRoot,
        ...(options.storageRoot === undefined
          ? {}
          : { storageRoot: options.storageRoot }),
        // Official-host mode: the api-proxy owns the user-interaction slot.
        userInteractionProvider: false,
      })
    },
  })
  return harness
}
