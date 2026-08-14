/**
 * 阶段 1 approval/request 分流测试: grok 桥的应答者（prepend）与 web 应答者
 * 在官方 host 形态下共存——'approval/request' 是 waterfall，先返回结果的
 * listener 认领请求:
 * - grok 专属会话: grok 的应答者先认领（prepend），pager 弹权限对话框，
 *   web 应答者不被调用;
 * - web 专属会话: grok 应答者 next() 转发，web 应答者认领;
 * - 共享（adopted）会话: grok 应答者先认领（同一 host 内首答者胜的文档化语义）。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import { AcpTestClient, makeHostBridgeHarness, recordingClient } from './helpers.ts'

let socketPath = ''
let dispose: (() => Promise<void>) | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

/** Open a live turn on a session so approval.request() can audit it. */
function openTurn(session: { append(type: string, data: unknown): void }): void {
  session.append('turn/start', { turn: 1 })
}

describe('approval answerer coexistence in the official host', () => {
  it('routes grok-session approvals to the pager (prepend) and web-session approvals to the web answerer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-approval-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeHostBridgeHarness({
      socketPath,
      persistenceRoot: join(dir, 'sessions'),
      script: [],
    })
    dispose = harness.dispose
    const ApprovalService = (
      await import('@deepseek-ai/dsh-user-approval')
    ).default
    await harness.ctx.plugin(ApprovalService, { policy: 'ask' })
    // The web answerer (what the api-proxy registers at host boot). In the
    // real host it is registered BEFORE grok's listener; grok prepends so
    // grok-owned sessions still claim first.
    const webClaims: string[] = []
    harness.ctx.on('approval/request', (req, _next) => {
      webClaims.push(String(req.agent.session.id))
      return Promise.resolve('rejected' as const)
    })
    // The pager answers permission dialogs with allow-once.
    harness.onPermission = () => ({
      outcome: { outcome: 'selected' as const, optionId: 'allow-once' },
    })

    const cwd = join(dir, 'ws')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(cwd, { recursive: true })

    // grok-owned session: approval must claim via the pager, not the web.
    const grok = await AcpTestClient.connect(socketPath, recordingClient(harness))
    await grok.client.initialize({ protocolVersion: 1 })
    const created = await grok.client.newSession({ cwd, mcpServers: [] })
    const grokSessionId = created.sessionId as never
    const grokAgent = harness.ctx.agents.get(grokSessionId)
    expect(grokAgent).toBeDefined()
    openTurn(grokAgent?.session)
    const grokOutcome = await harness.ctx.approval.request({
      // biome-ignore lint/style/noNonNullAssertion: guarded by expect above
      agent: grokAgent!,
      toolName: 'bash',
      callId: 'call-grok-1' as never,
    })
    expect(grokOutcome).toBe('allowed-once')
    expect(harness.permissionRequests).toHaveLength(1)
    expect(webClaims).toEqual([])

    // web-owned session (never opened by grok): the grok listener forwards
    // with next() and the web answerer claims.
    const webHandle = await harness.ctx.agents.create({
      sessionId: 'approval-web-0000-0000-0000-000000000001' as never,
      agentOptions: { provider: 'mock', model: 'mock' },
      meta: { cwd },
    })
    openTurn(webHandle.agent.session)
    const webOutcome = await harness.ctx.approval.request({
      agent: webHandle.agent,
      toolName: 'bash',
    })
    expect(webOutcome).toBe('rejected')
    expect(webClaims).toEqual([String(webHandle.agent.session.id)])
    expect(harness.permissionRequests).toHaveLength(1) // pager not asked again

    // SHARED session (grok resumes the web-held one): the prepended grok
    // answerer claims first — the documented first-answerer-wins semantics.
    await grok.client.loadSession({
      sessionId: webHandle.agent.session.id as never,
      cwd,
      mcpServers: [],
    })
    openTurn(webHandle.agent.session)
    const sharedOutcome = await harness.ctx.approval.request({
      agent: webHandle.agent,
      toolName: 'bash',
      callId: 'call-shared-1' as never,
    })
    expect(sharedOutcome).toBe('allowed-once')
    expect(harness.permissionRequests).toHaveLength(2)
    grok.transport.close()
  })
})
