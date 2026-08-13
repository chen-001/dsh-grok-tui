/**
 * Question bridge: routes DSH `ask_user_question` requests to the grok pager
 * over the ACP `x.ai/ask_user_question` extension method and maps the pager's
 * typed response back to the harness answer shape. The provider is registered
 * once per context (the user-interaction seam allows exactly one provider);
 * per-session connections register their sessions here so a question lands on
 * the client that owns the session.
 * @module dsh-grok-tui/bridge/question
 */

import { randomUUID } from 'node:crypto'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import {
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
  UserQuestionError,
} from '@deepseek-ai/dsh-user-questions'

/** The pager's wire payload for the ask ext-method (camelCase). */
interface GrokAskPayload {
  sessionId: string
  toolCallId: string
  questions: Array<{
    question: string
    options: Array<{ label: string; description: string }>
    multiSelect?: boolean
    id?: string
  }>
  mode: 'default' | 'plan'
}

/** The pager's typed ext-method response (internally tagged on outcome). */
interface GrokAskResponse {
  outcome?: string
  answers?: Record<string, string[]>
  annotations?: Record<string, { notes?: string }>
}

/**
 * Map one DSH question item to the pager's shape. `detail` has no pager
 * counterpart and is dropped; `header` rides the pager's opaque `id` slot
 * (the pager never keys answers by it — see `mapAnswers` — but accepts the
 * field for wire compatibility).
 * @param item - the DSH question item.
 * @returns the pager question payload.
 */
function toGrokQuestion(
  item: AskUserQuestionItem,
): GrokAskPayload['questions'][number] {
  return {
    question: item.question,
    options: (item.options ?? []).map(option => ({
      label: option.label,
      description: option.description ?? '',
    })),
    ...(item.multiSelect === true ? { multiSelect: true } : {}),
    ...(item.header !== undefined ? { id: item.header } : {}),
  }
}

/**
 * Map the pager's accepted answers onto the harness answer shape: the pager
 * keys `answers` and `annotations` by the question text itself (its
 * `QuestionViewState::build_accepted_response` inserts `q.question`), so the
 * lookup uses the question string — never the harness id. Labels that match
 * offered options become `selected`; the freeform "Other" label's typed text
 * (annotations notes) or any unmatched label text becomes `custom`.
 * @param questions - the original DSH questions (order defines answer order).
 * @param answers - pager answers keyed by question text.
 * @param annotations - optional freeform notes keyed by question text.
 * @returns the harness answer items.
 */
function mapAnswers(
  questions: readonly AskUserQuestionItem[],
  answers: Record<string, string[]>,
  annotations?: Record<string, { notes?: string }>,
): AskUserQuestionAnswer {
  return {
    answers: questions.map((question) => {
      // Wire key is the question text (pager behavior); identical question
      // texts in one ask would collide on the pager side too.
      const key = question.question
      const labels = answers[key] ?? []
      const optionLabels = new Set(
        (question.options ?? []).map(option => option.label),
      )
      const selected = labels.filter(label => optionLabels.has(label))
      const notes = annotations?.[key]?.notes
      const custom =
        notes !== undefined && notes !== ''
          ? notes
          : labels.filter(label => !optionLabels.has(label)).join(', ')
      const item: AskUserQuestionAnswer['answers'][number] = {
        id: question.id,
        selected,
      }
      if (custom !== '') item.custom = custom
      return item
    }),
  }
}

/**
 * Session → connection router shared by every connection and the single
 * user-interaction provider.
 */
export class QuestionRouter {
  private readonly sessions = new Map<string, AgentSideConnection>()

  /** Register one session on its owning connection. */
  register(sessionId: string, conn: AgentSideConnection): void {
    this.sessions.set(sessionId, conn)
  }

  /** Forget a session (connection teardown). */
  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * Ask the pager that owns the request's session.
   * @param request - the harness question request.
   * @returns the mapped answer, or a typed error when no client owns the
   * session or the user dismissed the question.
   */
  async ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const sessionId =
      request.agent === undefined
        ? undefined
        : String(request.agent.session.id)
    const conn =
      sessionId === undefined ? undefined : this.sessions.get(sessionId)
    if (conn === undefined || sessionId === undefined) {
      throw new UserQuestionError(
        'no grok client is attached to this session',
        'NO_CLIENT',
      )
    }
    if (request.signal?.aborted) {
      throw new UserQuestionError(
        'ask_user_question was aborted before the user answered',
        'ASK_ABORTED',
      )
    }
    const payload: GrokAskPayload = {
      sessionId,
      toolCallId: randomUUID(),
      questions: request.questions.map(toGrokQuestion),
      mode: request.questions.some(
        question => question.intent?.kind === 'plan-review',
      )
        ? 'plan'
        : 'default',
    }
    let response: Record<string, unknown>
    try {
      // Leading underscore: agent→client extension requests carry it on the
      // wire; the pager's Rust SDK strips it before routing to handlers.
      response = await conn.extMethod(
        '_x.ai/ask_user_question',
        payload as unknown as Record<string, unknown>,
      )
    } catch (error: unknown) {
      throw new UserQuestionError(
        `the grok client failed the question: ${String(error)}`,
        'CLIENT_FAILED',
      )
    }
    const typed = response as GrokAskResponse
    switch (typed.outcome) {
      case 'accepted':
        return mapAnswers(
          request.questions,
          typed.answers ?? {},
          typed.annotations,
        )
      case 'chat_about_this':
      case 'skip_interview':
        throw new UserQuestionError(
          `the user chose "${typed.outcome}" instead of answering`,
          'USER_DISMISSED',
        )
      case 'cancelled':
        throw new UserQuestionError(
          'the user dismissed this question',
          'USER_DISMISSED',
        )
      default:
        throw new UserQuestionError(
          `unexpected grok question outcome: ${String(typed.outcome)}`,
          'CLIENT_FAILED',
        )
    }
  }
}
