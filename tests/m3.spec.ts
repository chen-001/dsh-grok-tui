/**
 * M3 tests: the approval bridge (approval/request → pager permission dialog)
 * and the question bridge (DSH ask_user_question → x.ai/ask_user_question).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionsService, {
  UserQuestionError,
} from '@deepseek-ai/dsh-user-questions'
import { afterEach, describe, expect, it } from '@rstest/core'
import { Context } from 'cordis'
import { QuestionRouter } from '../src/bridge/question.ts'
import * as GrokServer from '../src/index.ts'
import {
  AcpTestClient,
  type GrokHarness,
  makeGrokHarness,
  recordingClient,
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

async function connectHarness(): Promise<AcpTestClient> {
  if (socketPath === '') {
    socketPath = join(await mkdtemp(join(tmpdir(), 'grok-m3-')), 'leader.sock')
  }
  harness = await makeGrokHarness({ socketPath, script: [] })
  dispose = harness.dispose
  await harness.ctx.plugin(ApprovalService)
  const client = await AcpTestClient.connect(
    socketPath,
    recordingClient(harness),
  )
  await client.client.initialize({ protocolVersion: 1 })
  return client
}

async function ownedRequest(
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const client = await connectHarness()
  const { sessionId } = await client.client.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  })
  const agent = harness.ctx.agents.get(
    SessionId(sessionId),
  ) as unknown as Agent
  agent.session.append('turn/start', {
    turn: 1,
    trigger: { kind: 'message', source: { kind: 'user' } },
  })
  return {
    client,
    agent,
    toolName: 'bash',
    callId: CallId('call-9'),
    ...overrides,
  }
}

describe('approval bridge', () => {
  it('maps the two advertised one-shot choices', async () => {
    const { client, agent } = (await ownedRequest()) as {
      client: AcpTestClient
      agent: Agent
    }
    // biome-ignore lint/style/noNonNullAssertion: harness is owned by this test
    harness!.onPermission = () => ({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })
    await expect(
      harness?.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: CallId('call-9'),
      }),
    ).resolves.toBe('allowed-once')
    expect(harness?.permissionRequests[0]).toMatchObject({
      sessionId: agent.session.id,
      toolCall: { toolCallId: 'call-9' },
      options: [
        { optionId: 'allow-once', kind: 'allow_once' },
        { optionId: 'reject-once', kind: 'reject_once' },
      ],
    })

    // biome-ignore lint/style/noNonNullAssertion: harness is owned by this test
    harness!.onPermission = () => ({
      outcome: { outcome: 'selected', optionId: 'reject-once' },
    })
    await expect(
      harness?.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: CallId('call-9'),
      }),
    ).resolves.toBe('rejected')
    client.transport.close()
  })

  it('maps cancellation and unknown choices without granting access', async () => {
    const { client, agent } = (await ownedRequest()) as {
      client: AcpTestClient
      agent: Agent
    }
    await expect(
      harness?.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: CallId('call-9'),
      }),
    ).resolves.toBe('cancelled')
    // biome-ignore lint/style/noNonNullAssertion: harness is owned by this test
    harness!.onPermission = () => ({
      outcome: { outcome: 'selected', optionId: 'unknown-grant' },
    })
    await expect(
      harness?.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: CallId('call-9'),
      }),
    ).resolves.toBe('rejected')
    client.transport.close()
  })

  it('fails closed when the client errors the permission request', async () => {
    const { client, agent } = (await ownedRequest()) as {
      client: AcpTestClient
      agent: Agent
    }
    // biome-ignore lint/style/noNonNullAssertion: harness is owned by this test
    harness!.onPermission = () => {
      throw new Error('client gone')
    }
    await expect(
      harness?.ctx.approval.request({
        agent,
        toolName: 'bash',
        callId: CallId('call-9'),
      }),
    ).resolves.toBe('unavailable')
    client.transport.close()
  })

  it('delegates a same-id foreign agent and call-less requests', async () => {
    const { client, agent } = (await ownedRequest()) as {
      client: AcpTestClient
      agent: Agent
    }
    const foreign = {
      session: {
        id: agent.session.id,
        events: [{ type: 'turn/start' }],
        append: () => {
          return {}
        },
      },
    } as unknown as Agent
    await expect(
      harness?.ctx.approval.request({
        agent: foreign,
        toolName: 'bash',
        callId: CallId('call'),
      }),
    ).resolves.toBe('unavailable')
    await expect(
      harness?.ctx.approval.request({ agent, toolName: 'bash' }),
    ).resolves.toBe('unavailable')
    expect(harness?.permissionRequests).toHaveLength(0)
    client.transport.close()
  })
})

describe('question bridge', () => {
  it('routes questions to the connection owning the session', async () => {
    const router = new QuestionRouter()
    const seen: Array<{ method: string; params: Record<string, unknown> }> = []
    const fakeConn = {
      extMethod: async (method: string, params: Record<string, unknown>) => {
        seen.push({ method, params })
        return {
          outcome: 'accepted',
          answers: { 'proceed?': ['Yes'], 'anything else?': ['Other'] },
          annotations: { 'anything else?': { notes: 'typed text' } },
        }
      },
    }
    router.register('sess-1', fakeConn as never)

    const answer = await router.ask({
      questions: [
        {
          id: 'q1',
          question: 'proceed?',
          options: [{ label: 'Yes' }, { label: 'No' }],
          header: 'h1',
        },
        {
          id: 'q2',
          question: 'anything else?',
          options: [{ label: 'Other' }],
          header: 'h2',
        },
      ],
      agent: { session: { id: 'sess-1' } } as never,
    })
    expect(answer.answers).toEqual([
      { id: 'q1', selected: ['Yes'] },
      { id: 'q2', selected: ['Other'], custom: 'typed text' },
    ])
    // ACP wire form: agent→client extension requests carry a leading underscore.
    expect(seen[0]?.method).toBe('_x.ai/ask_user_question')
    const payload = seen[0]?.params as {
      sessionId: string
      mode: string
      questions: Array<{ question: string }>
    }
    expect(payload.sessionId).toBe('sess-1')
    expect(payload.mode).toBe('default')
    expect(payload.questions.map(question => question.question)).toEqual([
      'proceed?',
      'anything else?',
    ])
  })

  it('uses plan mode when a question declares a plan review', async () => {
    const router = new QuestionRouter()
    const seen: Array<{ params: Record<string, unknown> }> = []
    router.register('sess-1', {
      extMethod: async (_method: string, params: Record<string, unknown>) => {
        seen.push({ params })
        return { outcome: 'accepted', answers: {} }
      },
    } as never)

    await router.ask({
      questions: [
        {
          id: 'q1',
          question: 'approve?',
          options: [{ label: 'Approve' }, { label: 'Decline' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
          detail: '# plan',
        },
      ],
      agent: { session: { id: 'sess-1' } } as never,
    })
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: seen is asserted non-empty
    expect((seen[0]?.params as { mode: string }).mode).toBe('plan')
  })

  it('fails with a typed error when the user dismisses the question', async () => {
    const router = new QuestionRouter()
    router.register('sess-1', {
      extMethod: async () => {
        return { outcome: 'cancelled' }
      },
    } as never)

    await expect(
      router.ask({
        questions: [{ id: 'q1', question: 'q' }],
        agent: { session: { id: 'sess-1' } } as never,
      }),
    ).rejects.toThrow(UserQuestionError)
  })

  it('fails with a typed error when no client owns the session', async () => {
    const router = new QuestionRouter()
    await expect(
      router.ask({
        questions: [{ id: 'q1', question: 'q' }],
        agent: { session: { id: 'sess-unknown' } } as never,
      }),
    ).rejects.toThrow(/no grok client/)
  })

  it('forgets sessions on unregister', async () => {
    const router = new QuestionRouter()
    router.register('sess-1', {
      extMethod: async () => {
        return { outcome: 'accepted', answers: {} }
      },
    } as never)
    router.unregister('sess-1')
    await expect(
      router.ask({
        questions: [{ id: 'q1', question: 'q' }],
        agent: { session: { id: 'sess-1' } } as never,
      }),
    ).rejects.toThrow(/no grok client/)
  })
})

describe('question wiring through the provider seam', () => {
  it('registers a provider when the user-interaction service is present', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-q-'))
    socketPath = join(dir, 'leader.sock')
    const ctx = new Context()
    const { mountAgentLoopTestDependencies } = await import(
      '@deepseek-ai/dsh-agent-loop-testkit',
    )
    const AgentLoop = (await import('@deepseek-ai/dsh-agent-loop')).default
    await mountAgentLoopTestDependencies(ctx, {
      systemPrompt: { persona: '' },
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new (await import('./helpers.ts')).MockAdapter([])
    ctx.llm.registerAdapter(['mock'], adapter)
    // The service must exist before the plugin applies (single-provider seam).
    await ctx.plugin(UserQuestionsService)
    await ctx.plugin({
      name: 'grok-server-provider-test',
      inject: [...GrokServer.inject],
      apply: (inner: Context) => {
        GrokServer.apply(inner, { socketPath })
      },
    })
    // The plugin's router provider answers with a typed no-client error.
    await expect(
      ctx.userQuestions.ask({
        questions: [{ id: 'q1', question: 'q' }],
      }),
    ).rejects.toThrow(/no grok client/)
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
})
