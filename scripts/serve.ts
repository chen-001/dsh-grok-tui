/**
 * M5 end-to-end server: mounts the REAL harness agent loop, REAL bash tool,
 * and the approval seam (ask policy) with a scripted mock provider (no API
 * key needed), then serves the grok leader protocol on a Unix socket. The
 * scripted provider requests one bash tool call, so the full surface —
 * streaming text, tool cards, permission dialog — can be exercised with the
 * real grok TUI:
 *
 *   GROK_LEADER_SOCKET=/tmp/dsh-grok.sock node --import tsx scripts/serve.ts
 *   GROK_LEADER_SOCKET=/tmp/dsh-grok.sock grok --leader
 */

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BashEnv from '@deepseek-ai/dsh-bash-env'
import BashSandbox from '@deepseek-ai/dsh-bash-sandbox'
import {
  type GenerateOptions,
  LlmAdapter,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SandboxLocal from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { Context } from 'cordis'
import * as GrokServer from '../src/index.ts'

/**
 * Scripted provider: first call announces a bash invocation (the loop runs
 * the REAL bash tool, gated by the ask-policy approval dialog), the follow-up
 * call closes the turn.
 */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  override providerInfo(provider: string) {
    if (provider !== 'mock')
      throw new Error(`ScriptedAdapter: unknown provider ${provider}`)
    return { id: 'mock', name: 'Mock' }
  }

  override listModels(provider: string) {
    return Promise.resolve(
      provider === 'mock'
        ? [{ provider: 'mock', id: 'mock', name: 'Mock' }]
        : [],
    )
  }

  async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.calls === 1) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Let me check the shell.' }
      // Escalating outside the workspace (with justification) forces the ask
      // policy to request approval through the pager's permission dialog.
      const command =
        'echo approved > ~/grok-e2e-approved.txt && cat ~/grok-e2e-approved.txt'
      const args = JSON.stringify({
        command,
        description: 'e2e demo',
        sandbox_permissions: 'danger-full-access',
        justification: 'e2e demo: writing outside the workspace with consent',
      })
      yield {
        type: 'tool-call-delta',
        index: 1,
        id: 'call-bash-1' as never,
        name: 'bash',
        argumentsDelta: args,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Let me check the shell.' },
      }
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id: 'call-bash-1' as never,
          name: 'bash',
          arguments: args,
        },
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const text =
      'The bash tool ran under the DeepSeek Harness loop; its output rendered above as a tool card.'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const char of text) yield { type: 'text-delta', index: 0, text: char }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: text.length },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const socketPath = process.env.GROK_LEADER_SOCKET ?? '/tmp/dsh-grok.sock'
const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, {
  systemPrompt: {
    persona:
      'You are DeepSeek Harness running under the grok-build TUI. Working directory: {{cwd}}.',
  },
})
await ctx.plugin(AgentLoop, { agents: [] })
ctx.llm.registerAdapter(['mock'], new ScriptedAdapter())
// Real tool stack: subprocess groups + bwrap sandbox (workspace-write asks
// before widening) + the bash tool + ask-policy approvals, so the pager's
// permission dialog and tool cards render real activity.
await ctx.plugin(SubprocessLocal)
await ctx.plugin(SandboxLocal)
await ctx.plugin(SandboxPolicyService, {
  mode: 'workspace-write',
  workspaceRoot: process.cwd(),
})
await ctx.plugin(BashSandbox, { timeoutMs: 60000 })
// bash-env is required: dsh-tool-bash injects `bashEnv` and silently stays
// unactivated without it (Cordis waits for injected services).
await ctx.plugin({
  name: 'bash-env-serve',
  inject: [...BashEnv.inject],
  apply: (inner: Context) => {
    BashEnv.apply(inner, {})
  },
})
await ctx.plugin({
  name: 'tool-bash-serve',
  inject: [...ToolBash.inject],
  apply: (inner: Context) => {
    ToolBash.apply(inner, {})
  },
})
await ctx.plugin(ApprovalService, { policy: 'ask' })
await ctx.plugin({
  name: 'grok-server-serve',
  inject: [...GrokServer.inject],
  apply: (inner: Context) => {
    inner.on(
      'session/event',
      (_session, event: { type: string; data: unknown }) => {
        if (event.type === 'tool/call' || event.type === 'tool/result') {
          console.log(
            'EVENT',
            event.type,
            JSON.stringify(event.data).slice(0, 300),
          )
        }
      },
    )
    GrokServer.apply(inner, {
      socketPath,
      provider: 'mock',
      model: 'mock',
      // The bridge defaults to host mode (no provider registration) since
      // v0.5.0; this demo owns the slot and opts in.
      userInteractionProvider: true,
    })
  },
})
console.log(
  `dsh-grok-tui ready at ${socketPath}; connect the grok TUI with GROK_LEADER_SOCKET=${socketPath} grok --leader`,
)

process.on('SIGINT', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
process.on('SIGTERM', () => {
  void ctx.fiber.dispose().then(() => process.exit(0))
})
