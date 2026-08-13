/**
 * Unit tests for the per-session usage fold: cumulative tokens, provider-call
 * count, tool wall time, and the context-pressure projection.
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from '@rstest/core'
import {
  createUsageState,
  foldUsage,
  foldUsageWithView,
  toUsageView,
} from '../src/usage.ts'

/** Build a minimal synthetic session event. */
function event<T extends SessionEvent['type']>(
  type: T,
  data: Extract<SessionEvent, { type: T }>['data'],
  seq: number,
  time = 1_700_000_000_000 + seq,
): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

describe('usage fold', () => {
  it('counts each provider request', () => {
    const state = createUsageState()
    foldUsage(state, event('step/start', { turn: 1, step: 1 }, 1))
    foldUsage(state, event('step/end', { turn: 1, step: 1 }, 2))
    foldUsage(state, event('step/start', { turn: 1, step: 2 }, 3))
    foldUsage(state, event('compact/start', { turn: 1 }, 4))
    expect(toUsageView(state).apiCalls).toBe(3)
  })

  it('accumulates usage chunks and projects the newest pressure', () => {
    const state = createUsageState()
    foldUsage(
      state,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: {
            type: 'usage',
            usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 30 },
          },
        },
        5,
      ),
    )
    foldUsage(
      state,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 2,
          chunk: {
            type: 'usage',
            usage: { inputTokens: 40, outputTokens: 3, cacheWriteTokens: 7 },
          },
        },
        9,
      ),
    )
    const view = toUsageView(state)
    expect(view.inputTokens).toBe(50)
    expect(view.outputTokens).toBe(5)
    expect(view.cacheReadTokens).toBe(30)
    expect(view.cacheWriteTokens).toBe(7)
    expect(view.pressureTokens).toBe(47)
  })

  it('folds assistant/message usage only when no chunk reported it', () => {
    const state = createUsageState()
    foldUsage(
      state,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
        },
        1,
      ),
    )
    foldUsage(
      state,
      event(
        'assistant/message',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'm-1' as never,
            source: { kind: 'assistant' },
            content: [{ type: 'text', text: 'hi' }],
          },
          usage: { inputTokens: 10, outputTokens: 2 },
        },
        2,
      ),
    )
    expect(toUsageView(state).inputTokens).toBe(10)

    // A step without a usage chunk folds from the message.
    foldUsage(state, event('step/start', { turn: 2, step: 1 }, 3))
    foldUsage(
      state,
      event(
        'assistant/message',
        {
          turn: 2,
          step: 1,
          message: {
            role: 'assistant',
            id: 'm-2' as never,
            source: { kind: 'assistant' },
            content: [{ type: 'text', text: 'again' }],
          },
          usage: { inputTokens: 5, outputTokens: 1 },
        },
        4,
      ),
    )
    const view = toUsageView(state)
    expect(view.inputTokens).toBe(15)
    expect(view.outputTokens).toBe(3)
  })

  it('sums tool wall time between call and result', () => {
    const state = createUsageState()
    foldUsage(
      state,
      event(
        'tool/call',
        {
          turn: 1,
          step: 1,
          callId: 'c-1' as never,
          name: 'bash',
          arguments: '{}',
        },
        5,
        1_000,
      ),
    )
    foldUsage(
      state,
      event(
        'tool/result',
        {
          turn: 1,
          step: 1,
          message: {
            role: 'user',
            id: 'r-1' as never,
            source: { kind: 'tool', callId: 'c-1' as never },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c-1' as never,
                content: [{ type: 'text', text: 'out' }],
              },
            ],
          },
        },
        6,
        1_450,
      ),
    )
    expect(toUsageView(state).toolDurationMs).toBe(450)
  })

  it('never folds an event twice across replay and live paths', () => {
    const state = createUsageState()
    const step = event('step/start', { turn: 1, step: 1 }, 1)
    foldUsage(state, step)
    foldUsage(state, step)
    foldUsage(
      state,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 2 } },
        },
        2,
      ),
    )
    expect(toUsageView(state).apiCalls).toBe(1)
    expect(toUsageView(state).inputTokens).toBe(4)
  })

  it('reports a view only when the fold changed it', () => {
    const state = createUsageState()
    // step/start changes the view (apiCalls 0 → 1).
    const stepView = foldUsageWithView(
      state,
      event('step/start', { turn: 1, step: 1 }, 1),
    )
    expect(stepView?.apiCalls).toBe(1)
    // A text delta changes nothing → null (no usage_update needed).
    expect(
      foldUsageWithView(
        state,
        event(
          'assistant/chunk',
          {
            turn: 1,
            step: 1,
            chunk: { type: 'text-delta', index: 0, text: 'hi' },
          },
          2,
        ),
      ),
    ).toBeNull()
    // The usage chunk changes tokens and pressure.
    const usageView = foldUsageWithView(
      state,
      event(
        'assistant/chunk',
        {
          turn: 1,
          step: 1,
          chunk: {
            type: 'usage',
            usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 30 },
          },
        },
        3,
      ),
    )
    expect(usageView?.inputTokens).toBe(5)
    expect(usageView?.pressureTokens).toBe(35)
    // Folding the same event again (replay/live overlap) is a no-op → null.
    expect(
      foldUsageWithView(
        state,
        event(
          'assistant/chunk',
          {
            turn: 1,
            step: 1,
            chunk: {
              type: 'usage',
              usage: { inputTokens: 5, outputTokens: 6, cacheReadTokens: 30 },
            },
          },
          3,
        ),
      ),
    ).toBeNull()
  })
})
