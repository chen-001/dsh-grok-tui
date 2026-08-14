/**
 * M4 tests: session/load replay, model state advertisement, session/set_model
 * routing, and the replay-mode event translation.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from '@rstest/core'
import {
  type ToolCallRecord,
  translateEvent,
} from '../src/translate/events.ts'
import {
  AcpTestClient,
  type GrokHarness,
  makeGrokHarness,
  recordingClient,
  textResponse,
} from './helpers.ts'

let socketPath = ''
let dispose: (() => Promise<void>) | undefined
let harness: GrokHarness | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  harness = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

function replayEvent<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

describe('replay translation', () => {
  it('echoes user messages only in replay mode', () => {
    const calls = new Map<string, ToolCallRecord>()
    const live = translateEvent(
      SessionId('s'),
      replayEvent(
        'user/message',
        {
          role: 'user',
          id: 'm1' as never,
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
        },
        1,
      ),
      calls,
    )
    expect(live).toHaveLength(0)

    const replayed = translateEvent(
      SessionId('s'),
      replayEvent(
        'user/message',
        {
          role: 'user',
          id: 'm1' as never,
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'hi' }],
        },
        1,
      ),
      calls,
      true,
    )
    expect(replayed[0]?.update).toMatchObject({
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'hi' },
    })
    expect(replayed[0]?._meta?.isReplay).toBe(true)
  })

  it('synthesizes committed assistant text during replay', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SessionId('s'),
      replayEvent(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'm2' as never,
            source: {
              kind: 'model',
              provider: 'mock',
              model: 'mock',
              content: [],
            },
            content: [{ type: 'text', text: 'answer' }],
          },
        },
        2,
      ),
      calls,
      true,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'answer' },
    })
    expect(updates[0]?._meta?.isReplay).toBe(true)
  })

  it('does not synthesize committed text outside replay', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SessionId('s'),
      replayEvent(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'm2' as never,
            source: {
              kind: 'model',
              provider: 'mock',
              model: 'mock',
              content: [],
            },
            content: [{ type: 'text', text: 'answer' }],
          },
        },
        2,
      ),
      calls,
    )
    expect(updates).toHaveLength(0)
  })
})

describe('session/load', () => {
  it('loads an owned session and replays its transcript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('hello from history')],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'remember this' }],
    })

    const before = harness.notifications.length
    const loaded = await client.client.loadSession({
      sessionId,
      cwd: dir,
      mcpServers: [],
    })
    expect(loaded).toBeDefined()

    // The replay re-delivers the history: user echo + committed answer.
    // (The post-load available_commands_update catalog push is not part of
    // the transcript stream and carries no isReplay marker.)
    const replayed = harness.notifications.slice(before)
    const chunks = replayed.filter(
      update => update.update.sessionUpdate === 'agent_message_chunk',
    )
    const userEchoes = replayed.filter(
      update => update.update.sessionUpdate === 'user_message_chunk',
    )
    expect(chunks.length).toBeGreaterThan(0)
    expect(userEchoes.length).toBeGreaterThan(0)
    expect(
      replayed
        .filter(
          update =>
            update.update.sessionUpdate !== 'available_commands_update',
        )
        .every(notification => notification._meta?.isReplay === true),
    ).toBe(true)
    client.transport.close()
  })

  it('rejects an unknown session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({ socketPath, script: [] })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    await expect(
      client.client.loadSession({
        sessionId: 'ffffffff-0000-0000-0000-000000000000',
        cwd: dir,
        mcpServers: [],
      }),
    ).rejects.toThrow()
    client.transport.close()
  })
})

describe('model surface', () => {
  it('advertises the provider catalog in the model state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [],
      contextWindow: 128000,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    const response = await client.client.initialize({ protocolVersion: 1 })
    const meta = response._meta as {
      modelState?: {
        currentModelId: string
        availableModels: Array<{
          modelId: string
          name: string
          _meta?: Record<string, unknown>
        }>
      }
    }
    expect(
      meta.modelState?.availableModels.some(
        model => model.modelId === 'mock',
      ),
    ).toBe(true)
    expect(meta.modelState?.currentModelId).toBe('mock')
    // Effort metadata rides each model so the picker's effort step works.
    const mock = meta.modelState?.availableModels.find(
      model => model.modelId === 'mock',
    )
    expect(mock?._meta?.supportsReasoningEffort).toBe(true)
    expect(Array.isArray(mock?._meta?.reasoningEfforts)).toBe(true)
    // The adapter-declared context window feeds the pager's context bar.
    expect(mock?._meta?.totalContextTokens).toBe(128000)
    client.transport.close()
  })

  it('omits totalContextTokens when the adapter reports no window', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({ socketPath, script: [] })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    const response = await client.client.initialize({ protocolVersion: 1 })
    const meta = response._meta as {
      modelState?: {
        availableModels: Array<{
          modelId: string
          _meta?: Record<string, unknown>
        }>
      }
    }
    const mock = meta.modelState?.availableModels.find(
      model => model.modelId === 'mock',
    )
    expect(mock?._meta?.totalContextTokens).toBeUndefined()
    client.transport.close()
  })

  it('routes session/set_model to the owning session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })

    await expect(
      client.client.extMethod('session/set_model', {
        sessionId,
        modelId: 'mock',
      }),
    ).resolves.toBeDefined()
    client.transport.close()
  })

  it('maps the pager reasoning effort onto the harness vocabulary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })

    // max stays max; xhigh folds to high; none folds to off.
    await expect(
      client.client.extMethod('session/set_model', {
        sessionId,
        modelId: 'mock',
        _meta: { reasoningEffort: 'max' },
      }),
    ).resolves.toBeDefined()
    await expect(
      client.client.extMethod('session/set_model', {
        sessionId,
        modelId: 'mock',
        _meta: { reasoningEffort: 'xhigh' },
      }),
    ).resolves.toBeDefined()
    await expect(
      client.client.extMethod('session/set_model', {
        sessionId,
        modelId: 'mock',
        _meta: { reasoningEffort: 'none' },
      }),
    ).resolves.toBeDefined()
    client.transport.close()
  })

  it('declares MCP initialization complete on session/new and session/load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })

    // DSH owns no MCP servers: the pager's "Starting session…" seed
    // indicator must be cleared immediately, not left to its 30s expiry.
    // Wire form carries the leading underscore the pager's SDK requires.
    const mcp = harness.extNotifications.find(
      entry => entry.method === '_x.ai/mcp_initialized',
    )
    expect(mcp).toBeDefined()
    expect(mcp?.params.sessionId).toBe(sessionId)

    await client.client.loadSession({ sessionId, cwd: dir, mcpServers: [] })
    const afterLoad = harness.extNotifications.filter(
      entry => entry.method === '_x.ai/mcp_initialized',
    )
    expect(afterLoad.length).toBeGreaterThanOrEqual(2)
    client.transport.close()
  })

  it('rejects an unknown model id on session/set_model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-m4-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({ socketPath, script: [] })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })

    await expect(
      client.client.extMethod('session/set_model', {
        sessionId,
        modelId: 'no-such-model',
      }),
    ).rejects.toThrow(/not found in any provider catalog/)
    client.transport.close()
  })
})

describe('model memory', () => {
  it('starts new sessions on the last model chosen via set_model and persists it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-mem-'))
    socketPath = join(dir, 'leader.sock')
    const lastModelFile = join(dir, 'last-model')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('a'), textResponse('b')],
      models: ['mock', 'mock2'],
      lastModelFile,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })

    // First session starts on the configured default.
    const first = await client.client.newSession({ cwd: dir, mcpServers: [] })
    await client.client.prompt({
      sessionId: first.sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    })
    expect(harness.adapter.requests[0]?.model).toBe('mock')

    // Switching models remembers the choice for the next session.
    await client.client.extMethod('session/set_model', {
      sessionId: first.sessionId,
      modelId: 'mock2',
    })
    const second = await client.client.newSession({ cwd: dir, mcpServers: [] })
    await client.client.prompt({
      sessionId: second.sessionId,
      prompt: [{ type: 'text', text: 'two' }],
    })
    expect(harness.adapter.requests[1]?.model).toBe('mock2')

    // The choice is persisted for server restarts, route-encoded
    // (provider@model) so a model id shared across provider routes still
    // routes to the same provider on the next session.
    const { readFile } = await import('node:fs/promises')
    await expect(readFile(lastModelFile, 'utf8')).resolves.toBe('mock@mock2')
    client.transport.close()
  })
})

describe('x.ai/session/list (resume picker)', () => {
  it('lists persisted sessions with first-prompt summaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-list-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
    })
    dispose = harness.dispose
    // JSONL persistence so sessions materialize for the catalog.
    const { default: SessionPersistenceJsonl } = await import(
      '@deepseek-ai/dsh-session-persistence-jsonl',
    )
    await harness.ctx.plugin(SessionPersistenceJsonl, {
      root: join(dir, 'sessions'),
      compression: 'none',
    })

    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'list me something' }],
    })
    // The JSONL coordinator drains asynchronously; settle before listing.
    await new Promise(resolve => setTimeout(resolve, 300))

    const response = (await client.client.extMethod('x.ai/session/list', {
      cwd: dir,
      limit: 30,
    })) as {
      sessions?: Array<{
        sessionId: string
        firstPrompt: string
        cwd: string
        createdAt: string
      }>
      _meta?: { 'x.ai/listScope'?: string }
    }
    expect(response._meta?.['x.ai/listScope']).toBe('all')
    expect(response.sessions?.some(row => row.sessionId === sessionId)).toBe(
      true,
    )
    const row = response.sessions?.find(row => row.sessionId === sessionId)
    expect(row?.firstPrompt).toBe('list me something')
    expect(row?.cwd).toBe(dir)
    expect(new Date(row?.createdAt ?? '').getTime()).toBeGreaterThan(0)
    client.transport.close()
  })

  it('serves an empty catalog without persistence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-list-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({ socketPath, script: [] })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const response = await client.client.extMethod('x.ai/session/list', {
      cwd: dir,
      limit: 30,
    })
    expect(response).toEqual({ sessions: [] })
    client.transport.close()
  })

  it('hides sessions archived in the web UI from the resume catalog', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-list-'))
    const storages = join(dir, 'storages')
    await mkdir(storages, { recursive: true })
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok'), textResponse('ok')],
      storageRoot: storages,
    })
    dispose = harness.dispose
    // JSONL persistence so sessions materialize for the catalog.
    const { default: SessionPersistenceJsonl } = await import(
      '@deepseek-ai/dsh-session-persistence-jsonl',
    )
    await harness.ctx.plugin(SessionPersistenceJsonl, {
      root: join(dir, 'sessions'),
      compression: 'none',
    })

    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId: keptId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: keptId,
      prompt: [{ type: 'text', text: 'keep me' }],
    })
    const { sessionId: archivedId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: archivedId,
      prompt: [{ type: 'text', text: 'archive me' }],
    })
    await new Promise(resolve => setTimeout(resolve, 300))

    // The web host's workspace registry wrote this unit; archive one session.
    await writeFile(
      join(storages, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: [archivedId],
        },
        tables: {},
      }),
    )

    const response = (await client.client.extMethod('x.ai/session/list', {
      cwd: dir,
      limit: 30,
    })) as {
      sessions?: Array<{ sessionId: string }>
    }
    expect(response.sessions?.some(row => row.sessionId === keptId)).toBe(
      true,
    )
    expect(response.sessions?.some(row => row.sessionId === archivedId)).toBe(
      false,
    )
    client.transport.close()
  })
})
