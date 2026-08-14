/**
 * DSH command bridge tests (F1): slash-line parsing, pager-builtin conflict
 * filtering, the AvailableCommand wire shape, the `x.ai/commands/list` pull,
 * the `available_commands_update` push, and prompt interception (a slash
 * prompt executes the command instead of reaching the model).
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it } from '@rstest/core'
import {
  filterPagerConflicts,
  isPagerBuiltin,
  parseSlashLine,
  toAvailableCommands,
} from '../src/commands-bridge.ts'
import {
  AcpTestClient,
  type GrokHarness,
  type MockCommands,
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

/** A mock `ctx.commands` registry: one real DSH command + one pager collision. */
function makeCommands(): MockCommands {
  return {
    descriptors: [
      {
        name: 'goal',
        description: 'Create a same-session goal',
        input: { hint: '<objective>' },
      },
      { name: 'plan', description: 'collides with a pager builtin' },
    ],
    executed: [],
    list(_agent: unknown) {
      return this.descriptors
    },
    async execute(_agent: unknown, line: string) {
      this.executed.push(line)
      return { result: { kind: 'success' as const, text: `ran: ${line}` } }
    },
  }
}

/** Collect the committed text from agent_message_chunk updates. */
function committedText(updates: SessionNotification['update'][]): string {
  return updates
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => {
      const content = (update as { content?: { type?: string; text?: string } })
        .content
      return content?.type === 'text' ? (content.text ?? '') : ''
    })
    .join('')
}

describe('slash line parsing', () => {
  it('parses a bare command line', () => {
    expect(parseSlashLine('/goal')).toEqual({ name: 'goal', rawInput: '' })
  })

  it('parses a command with trailing input', () => {
    expect(parseSlashLine('/goal 完成目标')).toEqual({
      name: 'goal',
      rawInput: ' 完成目标',
    })
    expect(parseSlashLine('/goal\targ')).toEqual({
      name: 'goal',
      rawInput: '\targ',
    })
  })

  it('rejects non-command lines', () => {
    expect(parseSlashLine('hello /goal')).toBeUndefined()
    expect(parseSlashLine('/Goal')).toBeUndefined()
    expect(parseSlashLine('')).toBeUndefined()
    expect(parseSlashLine('12abc')).toBeUndefined()
  })
})

describe('pager builtin conflict filter', () => {
  it('recognizes pager builtin names', () => {
    expect(isPagerBuiltin('plan')).toBe(true)
    expect(isPagerBuiltin('resume')).toBe(true)
    expect(isPagerBuiltin('model')).toBe(true)
    expect(isPagerBuiltin('goal')).toBe(false)
  })

  it('filters conflicting descriptors out of the catalog', () => {
    const filtered = filterPagerConflicts([
      { name: 'goal', description: 'g' },
      { name: 'plan', description: 'p' },
      { name: 'tasks', description: 't' },
    ])
    expect(filtered.map((cmd) => cmd.name)).toEqual(['goal'])
  })

  it('maps descriptors to the AvailableCommand wire shape', () => {
    const wire = toAvailableCommands([
      {
        name: 'goal',
        description: 'Create a same-session goal',
        input: { hint: '<objective>' },
      },
      { name: 'bare', description: 'no input hint' },
    ])
    expect(wire).toEqual([
      {
        name: 'goal',
        description: 'Create a same-session goal',
        input: { type: 'unstructured', hint: '<objective>' },
      },
      { name: 'bare', description: 'no input hint', input: null },
    ])
  })
})

describe('DSH command bridge (F1)', () => {
  async function connectWithCommands(script: (StreamChunk[] | 'hang')[] = []) {
    const dir = await mkdtemp(join(tmpdir(), 'grok-cmd-'))
    socketPath = join(dir, 'leader.sock')
    const commands = makeCommands()
    harness = await makeGrokHarness({
      socketPath,
      script,
      commands,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    return { client, commands }
  }

  it('advertises DSH commands after session/new, filtered of pager builtins', async () => {
    const { client, commands } = await connectWithCommands()
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const update = harness?.notifications.find(
      (notification) =>
        notification.sessionId === sessionId &&
        notification.update.sessionUpdate === 'available_commands_update',
    )
    expect(update).toBeDefined()
    const available = (
      // biome-ignore lint/correctness/noUnsafeOptionalChaining: guarded by expect above
      update?.update as { availableCommands?: Array<{ name: string }> }
    ).availableCommands
    // goal survives; the colliding 'plan' builtin does not.
    expect(available?.map((cmd) => cmd.name)).toEqual(['goal'])
    expect(commands.executed).toHaveLength(0)
    client.transport.close()
  })

  it('serves x.ai/commands/list with the filtered catalog', async () => {
    const { client } = await connectWithCommands()
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const response = (await client.client.extMethod('x.ai/commands/list', {
      sessionId,
    })) as { commands?: Array<{ name: string; input: unknown }> }
    expect(response.commands?.map((cmd) => cmd.name)).toEqual(['goal'])
    expect(response.commands?.[0]?.input).toEqual({
      type: 'unstructured',
      hint: '<objective>',
    })

    // Pre-session pull (no sessionId) has no agent to scope against.
    const pre = (await client.client.extMethod('x.ai/commands/list', {})) as {
      commands: unknown[]
    }
    expect(pre.commands).toEqual([])
    client.transport.close()
  })

  it('executes a DSH command prompt without touching the model', async () => {
    const { client, commands } = await connectWithCommands([
      textResponse('should never be requested'),
    ])
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/goal 完成目标' }],
    })
    expect(response.stopReason).toBe('end_turn')
    // The command ran through the registry; the model was never called.
    expect(commands.executed).toEqual(['/goal 完成目标'])
    expect(harness?.adapter.requests).toHaveLength(0)
    expect(committedText(harness?.updates ?? [])).toContain(
      'ran: /goal 完成目标',
    )
    client.transport.close()
  })

  it('passes ordinary prompts to the model untouched', async () => {
    const { client, commands } = await connectWithCommands([
      textResponse('model reply'),
    ])
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '帮我看看这个目录' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(commands.executed).toHaveLength(0)
    expect(harness?.adapter.requests).toHaveLength(1)
    client.transport.close()
  })

  it('never intercepts pager builtin names even when they collide', async () => {
    const { client, commands } = await connectWithCommands([
      textResponse('model reply'),
    ])
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    // 'plan' is a pager builtin; the DSH-side collision must not hijack it.
    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/plan 做个计划' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(commands.executed).toHaveLength(0)
    expect(harness?.adapter.requests).toHaveLength(1)
    client.transport.close()
  })

  it('unknown slash words stay ordinary prompts', async () => {
    const { client, commands } = await connectWithCommands([
      textResponse('model reply'),
    ])
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/nosuchcmd 参数' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(commands.executed).toHaveLength(0)
    expect(harness?.adapter.requests).toHaveLength(1)
    client.transport.close()
  })

  it('without a commands service the catalog is empty and prompts flow through', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-cmd-'))
    socketPath = join(dir, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('model reply')],
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const list = (await client.client.extMethod('x.ai/commands/list', {
      sessionId,
    })) as { commands: unknown[] }
    expect(list.commands).toEqual([])

    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/goal 完成目标' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(harness?.adapter.requests).toHaveLength(1)
    client.transport.close()
  })

  it('a failed command surfaces its error text without touching the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-cmd-'))
    socketPath = join(dir, 'leader.sock')
    const commands: MockCommands = {
      descriptors: [
        { name: 'goal', description: 'Create a same-session goal' },
      ],
      executed: [],
      list() {
        return this.descriptors
      },
      async execute(_agent: unknown, line: string) {
        this.executed.push(line)
        return { result: { kind: 'error', text: 'goal already active' } }
      },
    }
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('should never be requested')],
      commands,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )
    await client.client.initialize({ protocolVersion: 1 })
    const { sessionId } = await client.client.newSession({
      cwd: '/tmp',
      mcpServers: [],
    })

    const response = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: '/goal 换一个' }],
    })
    expect(response.stopReason).toBe('end_turn')
    expect(commands.executed).toEqual(['/goal 换一个'])
    expect(harness?.adapter.requests).toHaveLength(0)
    expect(committedText(harness?.updates ?? [])).toContain(
      'goal already active',
    )
    client.transport.close()
  })
})
