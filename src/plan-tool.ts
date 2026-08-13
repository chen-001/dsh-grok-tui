/**
 * Plan-mode entry tool for the grok TUI: `plan_mode` switches the calling
 * agent's session into plan mode through the `planMode` service. The
 * plan-mode plugin itself owns the mode state, the `plan:policy` prompt
 * section, the `/plan` command, and the `exit_plan_mode` review tool; this
 * plugin only supplies the missing activation surface for a TUI that has no
 * mode-switch button. Exiting stays on the official path: the model submits
 * the plan via `exit_plan_mode`, which routes the review through the
 * user-interaction seam to the pager's plan-review dialog.
 * @module dsh-grok-tui/plan-tool
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  defineTool,
  type GenericCallView,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools'
import type { Context } from 'cordis'

export const name = 'grok-plan-tool'
export const inject = ['tools', 'planMode']

/** Structural shape of the plan-mode service (duck-typed like userQuestions). */
interface PlanModeLike {
  set(
    agent: Agent,
    active: boolean,
  ): 'committed' | 'queued' | 'cancelled' | 'noop'
}

const description =
  'Switch this session into plan mode: the model stops implementing and instead investigates, ' +
  "then submits a complete plan for the user's approval. Once in plan mode, stay there until the user approves: " +
  'present the final plan through exit_plan_mode (the only and final tool call of that response) and wait for the ' +
  "user's review in the approval dialog. Calling plan_mode again while already in plan mode is a no-op. " +
  'Plan mode is for planning only — do not edit files, run mutating commands, or otherwise carry out changes until ' +
  'the plan is approved and plan mode exits.'

/**
 * Register the `plan_mode` tool.
 * @param ctx - context carrying the tool registry and the plan-mode service.
 */
export function apply(ctx: Context): void {
  const planMode = ctx.get('planMode') as PlanModeLike | undefined
  ctx.tools.register(
    defineTool({
      name: 'plan_mode',
      description,
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', const: 'plan', required: true },
          },
        },
        render: () => [
          {
            type: 'text',
            text: 'Plan mode active — investigate, then submit the plan through exit_plan_mode.',
          },
        ],
      },
      execute: async (_args: unknown, exec: ToolRunContext) => {
        const agent = exec.agent
        if (agent === undefined) {
          throw new Error(
            'plan_mode requires a calling agent (no session to switch)',
          )
        }
        if (planMode === undefined) {
          throw new Error(
            'plan_mode is unavailable: the plan-mode service is not mounted in this composition',
          )
        }
        planMode.set(agent, true)
        return { mode: 'plan' as const }
      },
      presentCall: (): GenericCallView => ({
        card: 'generic',
        title: 'Plan mode',
        kind: 'other',
        content: [
          { type: 'text', text: 'Switching this session into plan mode.' },
        ],
      }),
      presentResult: (_args, result) => ({
        card: 'generic',
        title: 'Plan mode',
        content: result.content,
      }),
    }),
  )
}
