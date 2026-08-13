/**
 * 模型目录与路由测试（多 provider 重名修复）:
 *
 * 背景: grok pager 的模型目录按 modelId 做 key（IndexMap），跨 provider 重名的
 * 模型（如 deepseek-v4-flash 同时存在于 deepseek-official 与 opencode-go）会
 * 折叠成一行。修复: 重名模型在 modelState 中编码为 `provider@model`、显示名
 * 加 provider 后缀；session/set_model 经 resolveModelRoute 解码回确切路由；
 * lastModel 记忆持久化为编码形式，新会话路由到同一 provider。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import {
  AcpTestClient,
  MockAdapter,
  makeGrokHarness,
  recordingClient,
  textResponse,
} from './helpers.ts'

let socketPath = ''
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

interface ModelState {
  currentModelId?: string
  availableModels?: Array<{
    modelId?: string
    name?: string
    description?: string
    _meta?: Record<string, unknown>
  }>
}

/** A harness whose 'mock' and 'mock-b' providers both declare `shared`. */
async function duplicatedCatalogHarness(options: {
  script?: Parameters<typeof textResponse>[0][]
  lastModelFile?: string
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'grok-models-'))
  socketPath = join(dir, 'leader.sock')
  const harness = await makeGrokHarness({
    socketPath,
    model: 'shared',
    models: ['shared', 'only-a'],
    script: options.script ?? [],
    ...(options.lastModelFile === undefined
      ? {}
      : { lastModelFile: options.lastModelFile }),
  })
  dispose = harness.dispose
  const adapterB = new MockAdapter(
    options.script ?? [],
    ['shared', 'only-b'],
    undefined,
    'mock-b',
  )
  harness.ctx.llm.registerAdapter(['mock-b'], adapterB)
  return { harness, adapterB }
}

describe('model catalog with duplicate ids across providers', () => {
  it('keeps every provider copy visible with unique wire ids and provider-suffixed names', async () => {
    const { harness } = await duplicatedCatalogHarness()
    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    const init = await client.client.initialize({ protocolVersion: 1 })
    const state = (init._meta as { modelState?: ModelState }).modelState ?? {}

    const rows = (state.availableModels ?? []).map(m => ({
      modelId: m.modelId,
      name: m.name,
      description: m.description,
    }))
    // The duplicated model appears TWICE with distinguishable ids/names.
    const sharedRows = rows.filter(row => row.name?.startsWith('shared'))
    expect(sharedRows).toHaveLength(2)
    expect(new Set(sharedRows.map(r => r.modelId)).size).toBe(2)
    expect(sharedRows.map(r => r.modelId).sort()).toEqual([
      'mock-b@shared',
      'mock@shared',
    ])
    expect(sharedRows.map(r => r.name).sort()).toEqual([
      'shared (mock)',
      'shared (mock-b)',
    ])
    for (const row of sharedRows) {
      expect(row.description).toBe(`provider: ${row.modelId?.split('@')[0]}`)
    }
    // Unique models keep their plain ids and names.
    expect(rows).toContainEqual({ modelId: 'only-a', name: 'only-a', description: undefined })
    expect(rows).toContainEqual({ modelId: 'only-b', name: 'only-b', description: undefined })
    // The advertised current id exists in the catalog and prefers the
    // configured provider's copy.
    expect(state.currentModelId).toBe('mock@shared')
    client.transport.close()
  })

  it('routes session/set_model to the exact provider of an encoded id', async () => {
    const { harness, adapterB } = await duplicatedCatalogHarness({
      script: [textResponse('ok'), textResponse('ok'), textResponse('ok')],
    })
    const adapterA = harness.adapter
    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await client.client.initialize({ protocolVersion: 1 })
    const cwd = await mkdtemp(join(tmpdir(), 'grok-models-cwd-'))
    const created = await client.client.newSession({ cwd, mcpServers: [] })

    // Default route (config provider): adapter A serves the request.
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'first' }],
    })
    expect(adapterA.requests.at(-1)?.provider).toBe('mock')

    // Encoded id routes to adapter B's copy of the duplicated model.
    await client.client.extMethod('session/set_model', {
      sessionId: String(created.sessionId),
      modelId: 'mock-b@shared',
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'second' }],
    })
    expect(adapterB.requests.at(-1)?.provider).toBe('mock-b')
    expect(adapterB.requests.at(-1)?.model).toBe('shared')
    expect(adapterA.requests.at(-1)?.provider).toBe('mock') // A not re-used

    // A legacy plain id still resolves by catalog search (first declarer).
    await client.client.extMethod('session/set_model', {
      sessionId: String(created.sessionId),
      modelId: 'shared',
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'third' }],
    })
    expect(adapterA.requests.at(-1)?.provider).toBe('mock')
    client.transport.close()
  })

  it('honors the MOST RECENT switch when set_model is called repeatedly (no listener stacking)', async () => {
    // Regression: session/set_model used to pass a FRESH selection object and
    // reinstall installModelSelection on every switch, stacking `agent/request`
    // waterfall listeners. The outermost (first-installed) listener kept its
    // STALE first choice and shadowed every later selection — so a switch
    // away from the first model silently reverted. This must return to the
    // first provider after switching away and back.
    const { harness, adapterB } = await duplicatedCatalogHarness({
      script: [textResponse('a'), textResponse('b'), textResponse('c'), textResponse('d')],
    })
    const adapterA = harness.adapter
    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await client.client.initialize({ protocolVersion: 1 })
    const cwd = await mkdtemp(join(tmpdir(), 'grok-models-stack-'))
    const created = await client.client.newSession({ cwd, mcpServers: [] })

    // Switch to mock-b, then back to mock (adapter A), then to mock-b again.
    await client.client.extMethod('session/set_model', {
      sessionId: String(created.sessionId),
      modelId: 'mock-b@shared',
    })
    await client.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'p1' }] })
    await client.client.extMethod('session/set_model', {
      sessionId: String(created.sessionId),
      modelId: 'shared',
    })
    await client.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'p2' }] })
    // The second switch must actually route back to adapter A.
    expect(adapterA.requests.at(-1)?.provider).toBe('mock')
    expect(adapterB.requests.length).toBe(1)

    await client.client.extMethod('session/set_model', {
      sessionId: String(created.sessionId),
      modelId: 'mock-b@shared',
    })
    await client.client.prompt({ sessionId: created.sessionId, prompt: [{ type: 'text', text: 'p3' }] })
    // And the third switch back to mock-b must take effect too.
    expect(adapterB.requests.at(-1)?.provider).toBe('mock-b')
    expect(adapterB.requests.length).toBe(2)
    client.transport.close()
  })

  it('remembers the route-encoded choice so a new session uses the same provider', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-models-mem-'))
    socketPath = join(dir, 'leader.sock')
    const lastModelFile = join(dir, 'last-model')
    // The pager previously selected opencode's copy (encoded route).
    await writeFile(lastModelFile, 'mock-b@shared', 'utf8')
    const { harness, adapterB } = await duplicatedCatalogHarness({
      lastModelFile,
      script: [textResponse('ok')],
    })
    const adapterA = harness.adapter
    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await client.client.initialize({ protocolVersion: 1 })
    const created = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'routed' }],
    })
    // The remembered route pinned the provider: B served the request.
    expect(adapterB.requests.length).toBeGreaterThan(0)
    expect(adapterB.requests.at(-1)?.provider).toBe('mock-b')
    expect(adapterA.requests.length).toBe(0)
    client.transport.close()
  })

  it('leaves single-provider catalogs untouched (regression)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-models-single-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({
      socketPath,
      model: 'mock',
      models: ['mock', 'mock-fast'],
      script: [],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    const init = await client.client.initialize({ protocolVersion: 1 })
    const state = (init._meta as { modelState?: ModelState }).modelState ?? {}
    expect(state.currentModelId).toBe('mock')
    expect(state.availableModels?.map(m => m.modelId).sort()).toEqual([
      'mock',
      'mock-fast',
    ])
    expect(state.availableModels?.map(m => m.name).sort()).toEqual([
      'mock',
      'mock-fast',
    ])
    expect(
      state.availableModels?.every(m => m.description === undefined),
    ).toBe(true)
    client.transport.close()
  })

  it('advertises the remembered model as current for new windows', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-models-mem2-'))
    socketPath = join(dir, 'leader.sock')
    const lastModelFile = join(dir, 'last-model')
    // The user last picked opencode's copy (route-encoded, as persisted by
    // session/set_model); a NEW window must open on it, not the default.
    await writeFile(lastModelFile, 'mock-b@shared', 'utf8')
    const harness = await makeGrokHarness({
      socketPath,
      model: 'shared',
      models: ['shared', 'only-a'],
      lastModelFile,
      script: [],
    })
    dispose = harness.dispose
    const adapterB = new MockAdapter([], ['shared', 'only-b'], undefined, 'mock-b')
    harness.ctx.llm.registerAdapter(['mock-b'], adapterB)

    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    const init = await client.client.initialize({ protocolVersion: 1 })
    const state = (init._meta as { modelState?: ModelState }).modelState ?? {}
    expect(state.currentModelId).toBe('mock-b@shared')
    client.transport.close()
  })

  it('maps a legacy plain remembered id onto the config provider copy', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-models-mem3-'))
    socketPath = join(dir, 'leader.sock')
    const lastModelFile = join(dir, 'last-model')
    // A pre-0.2.5 memory file holds the plain id; the duplicated model must
    // resolve to a current available entry (config provider's copy).
    await writeFile(lastModelFile, 'shared', 'utf8')
    const harness = await makeGrokHarness({
      socketPath,
      model: 'shared',
      models: ['shared', 'only-a'],
      lastModelFile,
      script: [],
    })
    dispose = harness.dispose
    const adapterB = new MockAdapter([], ['shared', 'only-b'], undefined, 'mock-b')
    harness.ctx.llm.registerAdapter(['mock-b'], adapterB)

    const client = await AcpTestClient.connect(socketPath, recordingClient(harness))
    const init = await client.client.initialize({ protocolVersion: 1 })
    const state = (init._meta as { modelState?: ModelState }).modelState ?? {}
    expect(state.currentModelId).toBe('mock@shared')
    client.transport.close()
  })
})
