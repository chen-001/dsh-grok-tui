/**
 * Scoped shadow of the official `ask_user_question` tool for grok-owned
 * agents (阶段 1 交互通道分流).
 *
 * Inside the official host the web's api-proxy owns the single
 * user-interaction provider slot (its browser dialog), so the GLOBAL
 * ask_user_question tool always reaches the browser — even for sessions the
 * grok TUI holds. This module registers a per-agent SHADOW of the same tool
 * on the agent's own scope (`agent.ctx.tools.register`): scoped tools
 * shadow globals for that agent, so a grok session's ask goes over the ACP
 * `x.ai/ask_user_question` extension method to the TUI instead, while web
 * sessions keep the global tool and the browser dialog. Both coexist in one
 * host; the model-visible face (name, description, parameter schema, output
 * schema) is a VERBATIM copy of the official tool so the model cannot tell
 * the difference.
 *
 * Lifecycle: registration binds to the agent's scoped context, so the
 * agent's own teardown removes it automatically; the returned disposer is
 * kept for the bridge's explicit teardown and for re-installation after
 * alignWithSharedLog swaps in a fresh agent. For a session SHARED with the
 * web (adopted live agent) the shadow also serves web-triggered asks — the
 * shared agent cannot tell which frontend called — which is the documented
 * first-answerer-wins semantics of shared sessions.
 *
 * plan review decision (阶段 1): `exit_plan_mode` is NOT shadowed — its
 * implementation is coupled to plan-mode's private pending-intent state,
 * which a plugin cannot replicate faithfully, so grok sessions' plan review
 * falls through the global tool to the web dialog (TODO: revisit with a
 * plan-mode seam). Ordinary asks carrying a plan-review intent DO ride the
 * shadow: QuestionRouter already renders them as the pager's plan dialog.
 * @module dsh-grok-tui/bridge/shadow-ask
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'
import type { QuestionRouter } from './question.ts'

/** The official tool's description — kept identical for the model-visible face. */
const ASK_DESCRIPTION =
  'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
  + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

/** The official tool's parameter schema (verbatim copy from dsh-tool-ask-user). */
export const askUserQuestionParameters = {
  questions: {
    type: 'array',
    required: true,
    description: 'Questions to ask the user before continuing.',
    items: {
      type: 'object',
      additionalProperties: true,
      properties: {
        id: { type: 'string', required: true, description: 'Stable id for this question; echoed in the answer.' },
        question: { type: 'string', required: true, description: 'The specific question to ask the user.' },
        header: {
          type: 'string',
          description: 'Optional short heading for the question, such as "Confirm" or "Choose Mode".',
        },
        options: {
          type: 'array',
          description: 'Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              label: { type: 'string', required: true, description: 'Short user-facing option label.' },
              description: { type: 'string', description: 'One sentence explaining the tradeoff or impact.' },
            },
          },
        },
        multi_select: {
          type: 'boolean',
          description: 'Whether the user may select more than one option. Defaults to false.',
        },
      },
    },
  },
} as const

/** The official tool's output schema (verbatim copy from dsh-tool-ask-user). */
export const askUserQuestionOutputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answers: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          selected: { type: 'array', required: true, items: { type: 'string' } },
          custom: { type: 'string' },
        },
      },
    },
  },
} as const

/**
 * Register the scoped shadow of ask_user_question on one agent's scope.
 * The execute path mirrors the official tool's mapping exactly, except the
 * question goes through the grok question router (ACP x.ai/ask_user_question
 * to the TUI) instead of `ctx.userQuestions.ask` (browser).
 * @param agentCtx - the agent's scoped context (`record.agent.ctx`).
 * @param questions - the session→connection question router.
 * @returns the exact disposer (also auto-disposed with the agent's scope).
 */
export function installShadowAsk(
  agentCtx: Context,
  questions: QuestionRouter,
): () => void {
  return agentCtx.tools.register(
    defineTool({
      name: 'ask_user_question',
      description: ASK_DESCRIPTION,
      parameters: askUserQuestionParameters,
      output: {
        schema: askUserQuestionOutputSchema,
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        const result = await questions.ask({
          questions: args.questions.map(question => ({
            id: question.id,
            question: question.question,
            ...(question.header === undefined
              ? {}
              : { header: question.header }),
            ...(question.options !== undefined
              ? { options: question.options }
              : {}),
            ...(question.multi_select !== undefined
              ? { multiSelect: question.multi_select }
              : {}),
          })),
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec.signal,
        })
        return {
          answers: result.answers.map(answer => ({
            id: answer.id,
            selected: [...answer.selected],
            ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
          })),
        }
      },
    }),
  )
}
