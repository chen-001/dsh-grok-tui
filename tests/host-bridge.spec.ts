/**
 * Host-bridge integration tests (阶段 0 矩阵 c/e 的自动化固化): one process
 * plays the OFFICIAL host — real agent loop, JSONL persistence on an
 * independent temporary root, and the grok server plugin in host mode
 * (`userInteractionProvider: false`) — while "web" clients drive the SAME
 * `ctx.agents` path the web api-proxy's ensureSession uses and grok clients
 * drive the real leader-socket protocol.
 *
 * The core assertion: web and grok alternate ≥5 rounds on ONE session and
 * the session log stays perfectly seq-contiguous (the strict loader's rule),
 * because in one process there is exactly one live agent per session (the
 * grok bridge adopts it) and one seq counter. Also covers the adopt
 * lifecycle (grok teardown never disposes or cancels the web's agent) and
 * the concurrent-prompt pair (queued, both settle).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { sessionLogPath } from '../src/first-prompt.ts'
import { seqGaps, seqsOfLog } from '../src/seq-scan.ts'
import { waitForSessionLog } from '../src/session-store.ts'
import {
  AcpTestClient,
  makeHostBridgeHarness,
  recordingClient,
  textResponse,
  type GrokHarness,
} from './helpers.ts'

let socketPath = ''
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

/** One web-side prompt: the api-proxy's ensureSession + followup + idle path. */
async function webPrompt(
  harness: GrokHarness,
  agent: {
    followup(message: unknown): void
    whenIdle(): Promise<unknown>
    session: { id: never }
  },
  text: string,
): Promise<void> {
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  await harness.ctx.sessions.flush(agent.session)
}

describe('official host bridge', () => {
  it('adopts the web-held live agent and keeps the shared log seq-contiguous across alternating rounds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-host-bridge-'))
    socketPath = join(dir, 'leader.sock')
    const sessionsRoot = join(dir, 'sessions')
    // 5 alternating rounds (web+grok) + 1 concurrent pair + 1 post-teardown
    // web prompt = 13 model responses.
    const harness = await makeHostBridgeHarness({
      socketPath,
      persistenceRoot: sessionsRoot,
      script: Array.from({ length: 13 }, () => textResponse('ok')),
    })
    dispose = harness.dispose

    const cwd = join(dir, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cwd, { recursive: true })

    // Web side: create the session through ctx.agents (ensureSession path).
    const sessionId = 'host-bridge-0000-0000-0000-000000000001' as never
    const webHandle = await harness.ctx.agents.create({
      sessionId,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd },
    })
    const webAgent = webHandle.agent

    // Grok side: resume the web-held session — must ADOPT the live agent.
    const grok = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await grok.client.initialize({ protocolVersion: 1 })
    await grok.client.loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    })
    // Adoption: the registry still returns the SAME agent object the web
    // created; a second live Session on the id is impossible in-process.
    expect(harness.ctx.agents.get(sessionId as never)).toBe(webAgent)

    // Alternating rounds: web prompt, then grok prompt, ×5.
    for (let round = 0; round < 5; round++) {
      await webPrompt(harness, webHandle.agent, `web round ${round}`)
      const stop = await grok.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: `grok round ${round}` }],
      })
      expect(stop.stopReason).toBeDefined()
    }
    await harness.ctx.sessions.flush(webAgent.session)

    // The shared log is perfectly seq-contiguous (zero gaps).
    await waitForSessionLog(sessionsRoot, String(sessionId), 5000)
    const logPath = sessionLogPath(
      sessionsRoot,
      cwd,
      String(sessionId),
    )
    const gaps = seqGaps(await seqsOfLog(logPath))
    expect(gaps).toEqual([])

    // Concurrent pair on the shared agent: both settle, log stays contiguous.
    const webPromise = (async () => {
      webHandle.agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: 'concurrent web' }],
          source: { kind: 'user' },
        }),
      )
      await webHandle.agent.whenIdle()
    })()
    const grokPromise = grok.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'concurrent grok' }],
    })
    const [grokStop] = await Promise.all([grokPromise, webPromise])
    expect(grokStop.stopReason).toBeDefined()
    await harness.ctx.sessions.flush(webAgent.session)
    expect(seqGaps(await seqsOfLog(logPath))).toEqual([])

    // Grok teardown must not dispose or cancel the adopted web agent.
    grok.transport.close()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(harness.ctx.agents.get(sessionId as never)).toBe(webAgent)
    await webPrompt(harness, webHandle.agent, 'after grok teardown')
    expect(seqGaps(await seqsOfLog(logPath))).toEqual([])
  })

  it('serves a grok-created session to a later web ensureSession as the same live agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-host-bridge2-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeHostBridgeHarness({
      socketPath,
      persistenceRoot: join(dir, 'sessions'),
      script: Array.from({ length: 2 }, () => textResponse('ok')),
    })
    dispose = harness.dispose

    const cwd = join(dir, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cwd, { recursive: true })

    // Grok creates the session first (as the pager would).
    const grok = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await grok.client.initialize({ protocolVersion: 1 })
    const created = await grok.client.newSession({ cwd, mcpServers: [] })
    const sessionId = created.sessionId as never
    const stop = await grok.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'first grok message' }],
    })
    expect(stop.stopReason).toBeDefined()
    const grokAgent = harness.ctx.agents.get(sessionId)
    expect(grokAgent).toBeDefined()

    // Web ensureSession for the same id: it resolves the LIVE agent from the
    // registry first (never create/resume a competing one — the singleton
    // contract), so the web and the grok window share one agent.
    const webAgent = harness.ctx.agents.get(sessionId)
    expect(webAgent).toBe(grokAgent)
    await webPrompt(harness, webAgent as never, 'web after grok')

    await harness.ctx.sessions.flush(webAgent.session)
    const logPath = sessionLogPath(
      join(dir, 'sessions'),
      cwd,
      String(sessionId),
    )
    expect(seqGaps(await seqsOfLog(logPath))).toEqual([])
    grok.transport.close()
  })
})
