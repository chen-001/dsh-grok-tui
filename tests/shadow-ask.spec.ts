/**
 * 阶段 1 交互通道分流测试: ask_user_question 的 scoped shadow 工具。
 *
 * - schema 一致性: grok 会话 agent scope 看到的 ask_user_question 与全局官方
 *   工具的参数/输出 schema、描述完全一致（模型可见面不能有差异）。
 * - 执行分流: grok 会话里模型调用 ask_user_question → 经 ACP
 *   x.ai/ask_user_question 扩展方法发给 TUI 客户端 → 客户端应答成为工具结果;
 *   web 会话（另一 agent）调用同一工具 → 走官方 userInteraction provider。
 * - 并存: 同一 host 内两种会话互不干扰。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import type { CallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  AcpTestClient,
  makeHostBridgeHarness,
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

/** Scripted stream: the model calls ask_user_question once, then stops. */
function askChunks(questionText: string): StreamChunk[] {
  const argumentsJson = JSON.stringify({
    questions: [
      {
        id: 'q1',
        question: questionText,
        options: [
          { label: 'Yes', description: 'go on' },
          { label: 'No', description: 'stop' },
        ],
      },
    ],
  })
  const callId = 'call-ask-1' as CallId
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'ask_user_question', argumentsDelta: argumentsJson },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: argumentsJson },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

describe('scoped shadow ask_user_question', () => {
  it('shadows the global tool for grok agents with an identical model-visible schema and routes answers over ACP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-shadow-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeHostBridgeHarness({
      socketPath,
      persistenceRoot: join(dir, 'sessions'),
      script: [askChunks('Shall I continue?'), textResponse('final answer')],
    })
    dispose = harness.dispose
    // The official web surface: user-questions service + the global
    // ask_user_question tool, with a browser-like provider answering.
    const UserInteraction = (
      await import('@deepseek-ai/dsh-user-questions')
    ).default
    await harness.ctx.plugin(UserInteraction)
    const ToolAskUser = await import('@deepseek-ai/dsh-tool-ask-user')
    await harness.ctx.plugin(ToolAskUser)
    const webAnswers: string[] = []
    harness.ctx.get('userQuestions')!.registerProvider({
      ask: async (request) => {
        webAnswers.push(request.questions[0]?.question ?? '')
        return {
          answers: request.questions.map(question => ({
            id: question.id,
            selected: ['Yes'],
          })),
        }
      },
    })

    // A web-side agent (the browser's session) holds the global tool.
    const cwd = join(dir, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cwd, { recursive: true })
    const webHandle = await harness.ctx.agents.create({
      sessionId: 'shadow-web-0000-0000-0000-000000000001' as never,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd },
    })
    const globalDef = harness.ctx.tools.get(
      'ask_user_question',
      webHandle.agent,
    )
    expect(globalDef).toBeDefined()

    // A grok session via the leader socket: its agent scope shadows the tool.
    const extCalls: Array<{ method: string; params: Record<string, unknown> }> = []
    const grok = await AcpTestClient.connect(socketPath, agent => ({
      ...recordingClient(harness)(agent),
      extMethod: async (method, params) => {
        extCalls.push({ method, params })
        return {
          outcome: 'accepted',
          answers: { 'Shall I continue?': ['Yes'] },
        }
      },
    }))
    await grok.client.initialize({ protocolVersion: 1 })
    const created = await grok.client.newSession({ cwd, mcpServers: [] })
    const sessionId = created.sessionId as never
    const grokAgent = harness.ctx.agents.get(sessionId)
    expect(grokAgent).toBeDefined()
    const shadowDef = harness.ctx.tools.get('ask_user_question', grokAgent!)
    expect(shadowDef).toBeDefined()

    // Model-visible face is IDENTICAL to the global tool.
    for (const field of ['name', 'description'] as const) {
      expect(shadowDef?.[field]).toBe(globalDef?.[field])
    }
    expect(shadowDef?.parameters).toEqual(globalDef?.parameters)
    expect(shadowDef?.output?.schema).toEqual(globalDef?.output?.schema)
    // And the shadow is a DIFFERENT definition object (scoped, not global).
    expect(shadowDef).not.toBe(globalDef)

    // The grok prompt's ask_user_question went over ACP to the TUI client.
    const stop = await grok.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'please ask me something' }],
    })
    expect(stop.stopReason).toBeDefined()
    expect(extCalls.length).toBe(1)
    expect(extCalls[0]?.method).toBe('_x.ai/ask_user_question')
    const payload = extCalls[0]?.params as {
      sessionId?: string
      questions?: Array<{ question?: string }>
    }
    expect(payload.sessionId).toBe(String(sessionId))
    expect(payload.questions?.[0]?.question).toBe('Shall I continue?')
    // The web provider never saw the grok session's question.
    expect(webAnswers).toEqual([])

    // The tool result reached the model: the tool/result event carries the
    // shadow's answer payload.
    const events = harness.ctx.sessions.get(sessionId)!.events
    const toolResult = events.find(event => event.type === 'tool/result')
    const resultContent = toolResult?.data.message.content
    expect(JSON.stringify(resultContent)).toContain('Yes')
    grok.transport.close()
  })

  it('keeps the web session on the global tool path while the grok shadow is installed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-shadow2-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeHostBridgeHarness({
      socketPath,
      persistenceRoot: join(dir, 'sessions'),
      script: [askChunks('Web question'), textResponse('ok')],
    })
    dispose = harness.dispose
    const UserInteraction = (
      await import('@deepseek-ai/dsh-user-questions')
    ).default
    await harness.ctx.plugin(UserInteraction)
    const ToolAskUser = await import('@deepseek-ai/dsh-tool-ask-user')
    await harness.ctx.plugin(ToolAskUser)
    const webAnswers: string[] = []
    harness.ctx.get('userQuestions')!.registerProvider({
      ask: async (request) => {
        webAnswers.push(request.questions[0]?.question ?? '')
        return {
          answers: request.questions.map(question => ({
            id: question.id,
            selected: ['Yes'],
          })),
        }
      },
    })

    const cwd = join(dir, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cwd, { recursive: true })

    // A grok session exists (shadow installed)…
    const grok = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await grok.client.initialize({ protocolVersion: 1 })
    await grok.client.newSession({ cwd, mcpServers: [] })

    // …while a WEB session's ask_user_question still reaches the browser
    // provider (its scope has the GLOBAL tool, not the shadow).
    const webHandle = await harness.ctx.agents.create({
      sessionId: 'shadow-web2-0000-0000-0000-000000000001' as never,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd },
    })
    const webDef = harness.ctx.tools.get('ask_user_question', webHandle.agent)
    const webGlobal = harness.ctx.tools.get('ask_user_question')
    expect(webDef).toBe(webGlobal)

    webHandle.agent.followup(
      (await import('@deepseek-ai/dsh-llm')).createUserMessage({
        content: [{ type: 'text', text: 'ask the web user' }],
        source: { kind: 'user' },
      }),
    )
    await webHandle.agent.whenIdle()
    expect(webAnswers).toEqual(['Web question'])
    grok.transport.close()
  })
})
