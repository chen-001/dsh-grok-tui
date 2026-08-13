/**
 * Per-session usage fold: cumulative token accounting, provider-request count,
 * and tool wall time derived from the durable session log. The fold is a pure
 * function of (state, event) so the live listener and the session/load replay
 * share one code path; a per-session `consumedSeq` highwater makes the shared
 * fold idempotent across the two callers.
 *
 * The wire shape mirrors what the web UI shows per session (cache-hit share of
 * billed input, input/output tokens, tool duration, provider-call count) plus
 * the current context pressure, which feeds the pager's built-in context bar.
 * @module dsh-grok-tui/usage
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Durable per-session usage accumulator. */
export interface SessionUsageState {
  /** Highest folded log sequence; replay and live listeners share it. */
  consumedSeq: number
  /** Cumulative uncached input tokens across every provider request. */
  inputTokens: number
  /** Cumulative output tokens (reasoning included). */
  outputTokens: number
  /** Cumulative cache-read tokens. */
  cacheReadTokens: number
  /** Cumulative cache-write tokens. */
  cacheWriteTokens: number
  /** Provider requests: agent-loop steps plus compaction calls. */
  apiCalls: number
  /** Summed tool wall time (tool/result − tool/call) in milliseconds. */
  toolDurationMs: number
  /** Provider-reported prompt size of the newest request (context used). */
  pressureTokens: number
  /** (turn, step) whose usage was already folded from a usage chunk. */
  lastUsageKey: { turn: number; step: number } | undefined
  /** tool/call start times keyed by callId, drained on tool/result. */
  toolStarts: Map<string, number>
  /**
   * Whole-conversation averages (user-facing view): mean time to first token
   * across completed turns, and mean decode throughput = cumulative output
   * tokens ÷ cumulative decode wall time.
   */
  ttftSumMs: number
  completedTurns: number
  totalDecodeMs: number
  /** turn/start time of the in-flight turn (cleared at turn/end). */
  turnStartMs: number | undefined
  /** First step/start time of the in-flight turn (TTFT anchor, web-style). */
  turnFirstStepStartMs: number | undefined
  /** Output-token counter at turn/start (delta yields the turn's own output). */
  turnStartOutputTokens: number
  /** Time of the first token delta (non-empty text/reasoning/tool) of the turn. */
  firstChunkMs: number | undefined
  /**
   * Decode window of the in-flight step: first token delta → assistant/message
   * (the same boundaries the web UI uses — assistant-timing.ts isTokenDelta +
   * settledAssistantTiming); summed per step so thinking time, TTFT and
   * tool-call gaps are excluded from the TPS denominator.
   */
  decodeStep: number | undefined
  decodeStepFirstMs: number | undefined
  decodeStepLastDeltaMs: number | undefined
  /** Summed decode wall time (ms) across the in-flight turn's steps. */
  turnDecodeMs: number
}

/** Create an empty usage accumulator for one session. */
export function createUsageState(): SessionUsageState {
  return {
    consumedSeq: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    apiCalls: 0,
    toolDurationMs: 0,
    pressureTokens: 0,
    lastUsageKey: undefined,
    toolStarts: new Map(),
    ttftSumMs: 0,
    completedTurns: 0,
    totalDecodeMs: 0,
    turnStartMs: undefined,
    turnFirstStepStartMs: undefined,
    turnStartOutputTokens: 0,
    firstChunkMs: undefined,
    decodeStep: undefined,
    decodeStepFirstMs: undefined,
    decodeStepLastDeltaMs: undefined,
    turnDecodeMs: 0,
  }
}

/** Web-UI-equivalent token-delta predicate (assistant-timing.ts isTokenDelta). */
function isTokenDelta(chunk: {
  type: string
  text?: string
  argumentsDelta?: string
  name?: unknown
}): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return chunk.text !== ''
    case 'tool-call-delta':
      return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default:
      return false
  }
}

/** Fold one session event into the accumulator (no-op for unrelated events). */
export function foldUsage(state: SessionUsageState, event: SessionEvent): void {
  if (event.seq <= state.consumedSeq) return
  state.consumedSeq = event.seq
  switch (event.type) {
    case 'turn/start':
      state.turnStartMs = event.time
      state.turnFirstStepStartMs = undefined
      state.firstChunkMs = undefined
      state.turnStartOutputTokens = state.outputTokens
      state.turnDecodeMs = 0
      state.decodeStep = undefined
      state.decodeStepFirstMs = undefined
      return
    case 'turn/end': {
      if (state.turnStartMs !== undefined) {
        // Web-style TTFT: first token delta − first step/start (excludes
        // input/queue time before the model call); accumulated for the
        // whole-conversation average.
        const stepStart = state.turnFirstStepStartMs
        if (state.firstChunkMs !== undefined && stepStart !== undefined) {
          state.ttftSumMs += state.firstChunkMs - stepStart
          state.completedTurns += 1
        }
        settleDecodeStep(state, event.time)
        // Web-style decode windows (first token delta → assistant/message,
        // thinking time, TTFT and tool-call gaps excluded); accumulated so
        // the view reports whole-conversation average throughput.
        state.totalDecodeMs += state.turnDecodeMs
      }
      state.turnStartMs = undefined
      state.turnFirstStepStartMs = undefined
      state.firstChunkMs = undefined
      state.turnDecodeMs = 0
      state.decodeStep = undefined
      state.decodeStepFirstMs = undefined
      return
    }
    case 'step/start': {
      state.apiCalls += 1
      if (state.turnFirstStepStartMs === undefined) {
        state.turnFirstStepStartMs = event.time
      }
      return
    }
    case 'compact/start' as never: {
      // The compact plugin extends the session map with `compact/*` markers;
      // the core union this switch narrows over does not declare them.
      state.apiCalls += 1
      return
    }
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (isTokenDelta(chunk)) {
        const step = event.data.step
        if (state.decodeStep !== step) {
          // Step boundary: settle the previous step's window at the last
          // delta we saw (its assistant/message settles it more precisely).
          settleDecodeStep(state, state.decodeStepLastDeltaMs)
          state.decodeStep = step
          state.decodeStepFirstMs = event.time
          state.decodeStepLastDeltaMs = event.time
          if (state.firstChunkMs === undefined) {
            state.firstChunkMs = event.time
          }
        } else {
          state.decodeStepLastDeltaMs = event.time
        }
        return
      }
      if (chunk.type === 'usage') {
        state.lastUsageKey = { turn: event.data.turn, step: event.data.step }
        accumulate(state, chunk.usage)
      }
      return
    }
    case 'assistant/message': {
      // Decode window close: web UI settles decode at the message event.
      settleDecodeStep(state, event.time)
      const usage = event.data.usage
      if (usage === undefined) return
      const key = { turn: event.data.turn, step: event.data.step }
      // The step's usage chunk already folded the same accounting.
      if (
        state.lastUsageKey?.turn === key.turn &&
        state.lastUsageKey.step === key.step
      )
        return
      state.lastUsageKey = key
      accumulate(state, usage)
      return
    }
    case 'tool/call':
      state.toolStarts.set(String(event.data.callId), event.time)
      return
    case 'tool/result': {
      const start = state.toolStarts.get(
        String(event.data.message.source.callId),
      )
      if (start !== undefined)
        state.toolDurationMs += Math.max(0, event.time - start)
      return
    }
    default:
      return
  }
}

/**
 * Fold one event and report whether the projected view changed.
 *
 * The usage chunk itself renders nothing on the wire, so without an explicit
 * push the stats/context bar would only refresh on the NEXT notification
 * (one request late on pure-text turns). Callers send a standard ACP
 * `usage_update` notification when this returns non-null — the pager ignores
 * its body but applies `_meta.totalTokens`/`dshUsage`, so the bar refreshes
 * immediately after every visible accounting change.
 * @param state - the per-session accumulator.
 * @param event - the session event to fold.
 * @returns the new view when it differs from the pre-fold view, else null.
 */
export function foldUsageWithView(
  state: SessionUsageState,
  event: SessionEvent,
): DshUsageView | null {
  const before = toUsageView(state)
  foldUsage(state, event)
  const after = toUsageView(state)
  return usageViewsEqual(before, after) ? null : after
}

/**
 * Fold the in-flight step's decode window into the turn total and clear it:
 * `completedTime − decodeStepFirstMs` (web UI settles decode at the
 * assistant/message event; a step boundary uses its last delta as a
 * lower-quality close). Called on step boundaries, assistant/message and
 * turn/end.
 */
function settleDecodeStep(
  state: SessionUsageState,
  completedTime: number | undefined,
): void {
  const first = state.decodeStepFirstMs
  if (first !== undefined && completedTime !== undefined && completedTime > first) {
    state.turnDecodeMs += completedTime - first
  }
  state.decodeStep = undefined
  state.decodeStepFirstMs = undefined
  state.decodeStepLastDeltaMs = undefined
}

function usageViewsEqual(left: DshUsageView, right: DshUsageView): boolean {
  return (
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.apiCalls === right.apiCalls &&
    left.toolDurationMs === right.toolDurationMs &&
    left.pressureTokens === right.pressureTokens &&
    left.ttftMs === right.ttftMs &&
    left.tps === right.tps
  )
}

function accumulate(
  state: SessionUsageState,
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  },
): void {
  state.inputTokens += usage.inputTokens
  state.outputTokens += usage.outputTokens
  state.cacheReadTokens += usage.cacheReadTokens ?? 0
  state.cacheWriteTokens += usage.cacheWriteTokens ?? 0
  state.pressureTokens =
    usage.inputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
}

/** Wire shape stamped into every notification `_meta.dshUsage`. */
export interface DshUsageView {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  apiCalls: number
  toolDurationMs: number
  /** Provider-reported prompt size of the newest request (context used). */
  pressureTokens: number
  /** Mean time to first token across completed turns, ms. */
  ttftMs: number | undefined
  /** Whole-conversation average output tokens per second (cumulative). */
  tps: number | undefined
}

/** Project the accumulator onto the wire shape. */
export function toUsageView(state: SessionUsageState): DshUsageView {
  return {
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    apiCalls: state.apiCalls,
    toolDurationMs: state.toolDurationMs,
    pressureTokens: state.pressureTokens,
    ttftMs:
      state.completedTurns > 0 ? state.ttftSumMs / state.completedTurns : undefined,
    tps:
      state.totalDecodeMs > 0
        ? (1000 * state.outputTokens) / state.totalDecodeMs
        : undefined,
  }
}
