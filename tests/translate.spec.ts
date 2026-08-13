/**
 * Unit tests for the pure translation layer: DSH tool mapping and
 * session-event → ACP notification translation.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from '@rstest/core'
import {
  buildUsageUpdateNotification,
  type ToolCallRecord,
  translateEvent,
} from '../src/translate/events.ts'
import {
  extractToolOutput,
  shapeToolInput,
  toGrokToolName,
  toolKindOf,
  toolOutputFor,
  toolTitle,
} from '../src/translate/tools.ts'

const SID = SessionId('sess-1')

/** Build a minimal synthetic session event for translator tests. */
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

describe('tool name and kind mapping', () => {
  it('maps DSH tool names to grok display names', () => {
    expect(toGrokToolName('web_fetch')).toBe('webfetch')
    expect(toGrokToolName('web_search')).toBe('websearch')
    expect(toGrokToolName('todo_write')).toBe('todowrite')
    expect(toGrokToolName('str_replace_editor')).toBe('edit')
    expect(toGrokToolName('subagent')).toBe('task')
    expect(toGrokToolName('ask_user_question')).toBe('question')
    expect(toGrokToolName('bash')).toBe('bash')
  })

  it('maps tool kinds the pager renders by', () => {
    expect(toolKindOf('bash')).toBe('execute')
    expect(toolKindOf('str_replace_editor')).toBe('edit')
    expect(toolKindOf('read')).toBe('read')
    expect(toolKindOf('grep')).toBe('search')
    expect(toolKindOf('web_fetch')).toBe('fetch')
    expect(toolKindOf('web_search')).toBe('search')
    expect(toolKindOf('todo_write')).toBe('other')
  })
})

describe('tool input and title shaping', () => {
  it('camelCases snake_case argument keys', () => {
    expect(shapeToolInput({ file_path: '/a/b.ts', replace_all: true })).toEqual(
      { filePath: '/a/b.ts', replaceAll: true },
    )
  })

  it('titles bash with the command and edit with the path', () => {
    expect(toolTitle('bash', { command: 'ls -la' })).toBe('ls -la')
    expect(toolTitle('edit', { filePath: '/x/y.ts' })).toBe('/x/y.ts')
  })

  it('titles web search with the grok prefix convention', () => {
    expect(toolTitle('websearch', { query: 'rust async' })).toBe(
      'Web search: rust async',
    )
  })

  it('counts todos and questions in their titles', () => {
    expect(
      toolTitle('todowrite', {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'pending' },
        ],
      }),
    ).toBe('1 todos')
    expect(toolTitle('question', { questions: [{}, {}] })).toBe(
      'Asked 2 questions',
    )
  })
})

describe('tool output construction', () => {
  it('wraps bash output in the grok Bash shape with an exit code', () => {
    const output = toolOutputFor(
      'bash',
      { command: 'ls' },
      'file1\nfile2',
      undefined,
    )
    expect(output.type).toBe('Bash')
    expect((output as { command: string }).command).toBe('ls')
    expect((output as { exit_code: number }).exit_code).toBe(0)
    expect((output as { output: number[] }).output).toEqual([
      ...Buffer.from('file1\nfile2'),
    ])
  })

  it('marks a failed bash run with a nonzero exit code', () => {
    const output = toolOutputFor('bash', { command: 'false' }, '', undefined)
    expect((output as { exit_code: number }).exit_code).toBe(1)
  })

  it('wraps read output with line counts', () => {
    const output = toolOutputFor(
      'read',
      { filePath: '/x/y.ts' },
      'line1\nline2',
      undefined,
    )
    expect(output.type).toBe('ReadFile')
    const content = (output as { FileContent: { total_lines: number } })
      .FileContent
    expect(content.total_lines).toBe(2)
  })

  it('falls back to the generic Text shape for unknown tools', () => {
    const output = toolOutputFor('mystery_tool', {}, 'plain text', undefined)
    expect(output).toEqual({ type: 'Text', text: 'plain text' })
  })
})

describe('event translation', () => {
  it('streams text deltas as agent_message_chunk', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'hello ' },
        },
        3,
      ),
      calls,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello ' },
    })
  })

  it('streams reasoning deltas as agent_thought_chunk', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' },
        },
        3,
      ),
      calls,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking…' },
    })
  })

  it('ignores non-text chunks', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'block-start', index: 0, blockType: 'text' },
        },
        3,
      ),
      calls,
    )
    expect(updates).toHaveLength(0)
  })

  it('translates tool calls into typed cards with shaped input', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'tool/call',
        {
          turn: 1,
          step: 1,
          callId: 'call-1' as never,
          name: 'bash',
          arguments: JSON.stringify({ command: 'ls', file_path: 'x' }),
        },
        4,
      ),
      calls,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'ls',
      kind: 'execute',
      rawInput: { command: 'ls', filePath: 'x' },
    })
    expect(calls.get('call-1')?.displayName).toBe('bash')
  })

  it('translates tool results into updates with grok output', () => {
    const calls = new Map<string, ToolCallRecord>([
      ['call-1', { displayName: 'bash', input: { command: 'ls' } }],
    ])
    const updates = translateEvent(
      SID,
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'user',
            id: 'm-1' as never,
            source: { kind: 'tool', callId: 'call-1' as never },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1' as never,
                content: [{ type: 'text', text: 'out' }],
              },
            ],
          },
        },
        5,
      ),
      calls,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
    })
    const rawOutput = (updates[0]?.update as { rawOutput: { type: string } })
      .rawOutput
    expect(rawOutput.type).toBe('Bash')
  })

  it('marks failed tool results with status failed', () => {
    const calls = new Map<string, ToolCallRecord>([
      ['call-1', { displayName: 'read', input: { filePath: '/x' } }],
    ])
    const updates = translateEvent(
      SID,
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'user',
            id: 'm-1' as never,
            source: { kind: 'tool', callId: 'call-1' as never },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call-1' as never,
                content: [{ type: 'text', text: 'boom' }],
              },
            ],
          },
          error: { name: 'Error', code: 'E1' },
        },
        5,
      ),
      calls,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'tool_call_update',
      status: 'failed',
    })
  })

  it('turns todo writes into plan updates', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'todo/write',
        {
          todos: [
            { content: 'first', status: 'in_progress' },
            { content: 'second', status: 'pending' },
          ],
        },
        6,
      ),
      calls,
    )
    expect(updates[0]?.update).toMatchObject({
      sessionUpdate: 'plan',
      entries: [
        { content: 'first', status: 'in_progress', priority: 'medium' },
        { content: 'second', status: 'pending', priority: 'medium' },
      ],
    })
  })

  it('stamps the event id meta from the session log sequence', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'x' },
        },
        42,
      ),
      calls,
    )
    expect(updates[0]?._meta?.eventId).toBe('sess-1-42')
  })

  it('stamps context pressure and cumulative dsh usage when provided', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'hi' },
        },
        7,
      ),
      calls,
      false,
      {
        inputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 9800,
        cacheWriteTokens: 0,
        apiCalls: 2,
        toolDurationMs: 450,
        pressureTokens: 11000,
      },
    )
    expect(updates[0]?._meta?.totalTokens).toBe(11000)
    expect(updates[0]?._meta?.dshUsage).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9800,
      cacheWriteTokens: 0,
      apiCalls: 2,
      toolDurationMs: 450,
      pressureTokens: 11000,
    })
  })

  it('omits the usage meta before any usage was folded', () => {
    const calls = new Map<string, ToolCallRecord>()
    const updates = translateEvent(
      SID,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'hi' },
        },
        7,
      ),
      calls,
    )
    expect(updates[0]?._meta?.totalTokens).toBeUndefined()
    expect(updates[0]?._meta?.dshUsage).toBeUndefined()
  })

  it('builds the standard usage_update notification with the usage meta', () => {
    const notification = buildUsageUpdateNotification(
      SID,
      {
        inputTokens: 5,
        outputTokens: 6,
        cacheReadTokens: 30,
        cacheWriteTokens: 0,
        apiCalls: 1,
        toolDurationMs: 0,
        pressureTokens: 35,
      },
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 6 } },
        },
        9,
      ),
      false,
    )
    expect(notification.update).toMatchObject({
      sessionUpdate: 'usage_update',
      used: 35,
    })
    expect(notification._meta?.eventId).toBe('sess-1-9')
    expect(notification._meta?.totalTokens).toBe(35)
    expect(notification._meta?.dshUsage).toMatchObject({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadTokens: 30,
      apiCalls: 1,
    })
  })
})

describe('tool output text extraction', () => {
  it('unwraps nested tool result blocks', () => {
    const content = [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ]
    expect(extractToolOutput(content)).toBe('hello\nworld')
  })
})
