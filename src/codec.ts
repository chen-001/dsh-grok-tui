/**
 * Pure translation between the harness lifecycle and the ACP wire, ported
 * from `@deepseek-ai/dsh-acp`'s codec (identical semantics; kept local so
 * this package stays self-contained).
 * @module dsh-grok-tui/codec
 */

import type {
  ContentBlock as AcpContentBlock,
  StopReason,
} from '@agentclientprotocol/sdk'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'

/**
 * Map a harness turn ending to ACP's terminal reason vocabulary.
 * @param reason - harness turn outcome.
 * @returns the closest legal ACP stop reason.
 */
export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
    case 'interrupted':
      return 'cancelled'
    case 'error':
      return 'end_turn'
    // TurnEndReason is merge-extensible; future variants still need a legal wire value.
    default:
      return 'end_turn'
  }
}

/**
 * Flatten an ACP prompt's baseline blocks to text. Text blocks concatenate
 * verbatim; resource links become explicit textual references.
 * @param prompt - supported ACP prompt blocks.
 * @returns text in wire order, with resource links rendered as bracketed references.
 */
export function acpPromptToText(prompt: readonly AcpContentBlock[]): string {
  return prompt
    .flatMap((block): string[] => {
      switch (block.type) {
        case 'text':
          return [block.text]
        case 'resource_link':
          return [
            `\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`,
          ]
        default:
          return []
      }
    })
    .join('')
}

/**
 * Whether a prompt carries content beyond the ACP baseline (image, audio,
 * embedded resource). This server advertises baseline prompts only, so richer
 * blocks are rejected rather than silently dropped.
 * @param prompt - ACP prompt blocks to inspect.
 * @returns `true` when any block is neither `text` nor `resource_link`.
 */
export function promptHasUnsupportedContent(
  prompt: readonly AcpContentBlock[],
): boolean {
  return prompt.some(
    block => block.type !== 'text' && block.type !== 'resource_link',
  )
}
