/**
 * Event translation: DSH session events → ACP session/update notifications,
 * matching what the grok pager consumes. Text/reasoning deltas stream live
 * (token-level); tool calls render as typed tool_call cards; todo writes
 * become plan updates (the pager's todo pane is fed by Plan updates); the
 * tool/result output is wrapped in the grok `ToolOutput` union for the
 * pager's per-tool renderers.
 * @module dsh-grok-tui/translate/events
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { DshUsageView } from '../usage.ts'
import {
  extractToolOutput,
  shapeToolInput,
  toGrokToolName,
  toolKindOf,
  toolOutputFor,
  toolTitle,
} from './tools.ts'

/** Per-session call state needed to render a result (args ride the call event). */
export interface ToolCallRecord {
  displayName: string
  input: Record<string, unknown>
}

function safeJsonParse(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : { value: parsed }
  } catch {
    return {}
  }
}

/**
 * Build one session/update notification with the pager's optional meta.
 * `usage` stamps the pager's context bar (`totalTokens` = current context
 * pressure) and the dsh-specific stats surface (`dshUsage` = cumulative
 * tokens / API calls / tool wall time).
 */
function notification(
  sessionId: SessionId,
  update: SessionNotification['update'],
  event: SessionEvent,
  replay: boolean,
  usage?: DshUsageView,
): SessionNotification {
  return {
    sessionId,
    update,
    _meta: {
      // The pager dedups replayed vs live events by eventId; the sequence is
      // DSH's contiguous log seq (replay-safe, monotonic per session).
      eventId: `${String(sessionId)}-${event.seq}`,
      agentTimestampMs: event.time,
      // Historical replay from session/load: the pager renders these into the
      // restored transcript instead of treating them as live activity.
      isReplay: replay,
      // Context bar numerator; absent until the first provider usage report.
      ...(usage === undefined || usage.pressureTokens === 0
        ? {}
        : { totalTokens: usage.pressureTokens }),
      // Cumulative dsh-specific stats; absent until any usage was folded.
      ...(usage === undefined || usage.apiCalls === 0
        ? {}
        : { dshUsage: usage }),
    },
  }
}

/**
 * Build the standard ACP `usage_update` notification (context window + cost
 * update for a session). The pager ignores its body but applies the `_meta`
 * fields, so this is the vehicle that refreshes the context bar and dsh
 * stats immediately after a usage change with no other wire surface.
 * @param sessionId - the owning session.
 * @param usage - the current usage view (always stamped, even pre-first-call).
 * @param event - the event that changed the view (carries seq/time for meta).
 * @param replay - whether this is a session/load replay.
 * @returns the notification to send.
 */
export function buildUsageUpdateNotification(
  sessionId: SessionId,
  usage: DshUsageView,
  event: SessionEvent,
  replay: boolean,
): SessionNotification {
  return notification(
    sessionId,
    {
      sessionUpdate: 'usage_update',
      // `size` is unused by the pager (the body is ignored); the context bar
      // denominator comes from the model's `totalContextTokens` meta instead.
      used: usage.pressureTokens,
      size: 0,
    },
    event,
    replay,
    usage,
  )
}

/**
 * Translate one DSH session event into ACP notifications for the pager.
 * @param sessionId - the owning session.
 * @param event - the durable session event.
 * @param calls - per-call input records (keyed by callId), mutated on tool/call.
 * @param usage - current per-session usage view, stamped into `_meta` when present.
 * @returns the notifications to send; empty when the event has no pager surface.
 */
export function translateEvent(
  sessionId: SessionId,
  event: SessionEvent,
  calls: Map<string, ToolCallRecord>,
  replay = false,
  usage?: DshUsageView,
): SessionNotification[] {
  switch (event.type) {
    case 'assistant/chunk': {
      const chunk = event.data.chunk
      if (chunk.type === 'text-delta' && chunk.text.length > 0) {
        return [
          notification(
            sessionId,
            {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: chunk.text },
            },
            event,
            replay,
            usage,
          ),
        ]
      }
      if (chunk.type === 'reasoning-delta' && chunk.text.length > 0) {
        return [
          notification(
            sessionId,
            {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: chunk.text },
            },
            event,
            replay,
            usage,
          ),
        ]
      }
      return []
    }
    case 'user/message': {
      // Live prompts are echoed by the pager itself; only a replay (session/load)
      // carries the historical user messages back to the client.
      if (!replay) return []
      const text = event.data.content
        .filter(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )
        .map(block => block.text)
        .join('')
      if (text.length === 0) return []
      return [
        notification(
          sessionId,
          {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text },
          },
          event,
          true,
          usage,
        ),
      ]
    }
    case 'assistant/message': {
      // Compacted or foreign logs may lack chunk events; a replay synthesizes
      // committed text from the assembled message.
      if (!replay) return []
      return event.data.message.content
        .filter(block => block.type === 'text')
        .flatMap((block) => {
          const text = (block as { text: string }).text
          if (text.length === 0) return []
          return [
            notification(
              sessionId,
              {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text },
              },
              event,
              true,
              usage,
            ),
          ]
        })
    }
    case 'tool/call': {
      const displayName = toGrokToolName(event.data.name)
      const input = shapeToolInput(safeJsonParse(event.data.arguments))
      calls.set(String(event.data.callId), { displayName, input })
      return [
        notification(
          sessionId,
          {
            sessionUpdate: 'tool_call',
            toolCallId: String(event.data.callId),
            title: toolTitle(displayName, input),
            kind: toolKindOf(event.data.name),
            rawInput: input,
          },
          event,
          replay,
          usage,
        ),
      ]
    }
    case 'tool/result': {
      const callId = String(event.data.message.source.callId)
      const record = calls.get(callId)
      const output = extractToolOutput(event.data.message.content)
      const rawOutput =
        record === undefined
          ? { type: 'Text', text: output }
          : toolOutputFor(
            record.displayName,
            record.input,
            output,
            event.data.meta,
          )
      const update: SessionNotification['update'] = {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        rawOutput,
        ...(event.data.error !== undefined ? { status: 'failed' } : {}),
      }
      return [notification(sessionId, update, event, replay, usage)]
    }
    case 'todo/write': {
      return [
        notification(
          sessionId,
          {
            sessionUpdate: 'plan',
            entries: event.data.todos.map(todo => ({
              content: todo.content,
              status: todo.status,
              priority: 'medium',
            })),
          },
          event,
          replay,
          usage,
        ),
      ]
    }
    default: {
      // The host's session-title service appends `session/title` events
      // (fallback first, then the LLM provider title, then any user rename).
      // Push the latest title onto the wire as the standard ACP
      // `session_info_update` so ACP-native clients can relabel the session;
      // the grok pager consumes the companion `x.ai/session_notification`
      // (SessionSummaryGenerated) sent by the server for the same event.
      // `session/title` is a plugin-merged event type (dsh-session-title),
      // so the SessionEvent union does not carry it — narrow structurally.
      const titleEvent = event as {
        type?: unknown
        data?: { title?: unknown }
      }
      if (
        titleEvent.type === 'session/title' &&
        typeof titleEvent.data?.title === 'string' &&
        titleEvent.data.title.trim().length > 0
      ) {
        return [
          notification(
            sessionId,
            {
              sessionUpdate: 'session_info_update',
              title: titleEvent.data.title,
            },
            event,
            replay,
            usage,
          ),
        ]
      }
      return []
    }
  }
}
