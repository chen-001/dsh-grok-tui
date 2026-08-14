/**
 * DSH command bridge for the grok TUI (F1).
 *
 * The grok pager keeps its OWN slash-command menu (builtins like /resume,
 * /model, /exit) plus commands advertised by the agent through the ACP
 * `AvailableCommand` surface (a `available_commands_update` notification or
 * a `x.ai/commands/list` pull). DSH registers its human-facing slash
 * commands (`/goal`, `/feedback`, …) in the `ctx.commands` registry, which
 * the pager never sees — until now.
 *
 * Two halves:
 *
 * 1. CATALOG — expose DSH's command registry as ACP `AvailableCommand`s:
 *    `x.ai/commands/list` answers from `ctx.commands.list(agent)` and a
 *    `available_commands_update` notification is pushed after every
 *    session/new, session/load and re-align, so the pager's slash menu shows
 *    the DSH commands. DSH commands colliding with pager builtins are
 *    filtered out: the pager's own builtin must keep winning the keystroke.
 *
 * 2. EXECUTION — the pager has no ACP method to RUN an agent command: its
 *    `AcpSlashCommand` produces a `PassThrough` prompt (`/goal …` as plain
 *    text) whenever the user picks an agent-advertised command. The ACP
 *    `prompt` handler therefore intercepts slash lines that resolve to a DSH
 *    command and executes them through `ctx.commands.execute(agent, line,
 *    signal)` instead of sending them to the model (the model has no idea
 *    what `/goal` means). The command's result text is delivered back to the
 *    pager as a single assistant message.
 *
 * The commands service is duck-typed (`ctx.get('commands')`): the host's
 * `@deepseek-ai/dsh-commands` is not a declared peer dependency, and the
 * standalone daemon mounts it in `scripts/serve-real.ts`. Absent service =
 * no menu entries and no interception (prompts flow to the model untouched).
 * @module dsh-grok-tui/commands-bridge
 */

/**
 * Pager builtin command names, extracted from grok-build's
 * `xai-grok-pager/src/slash/commands/*.rs` (`fn name()`), snapshot
 * `393430e`. DSH commands that collide with these are kept off the pager
 * menu and never intercepted: the pager handles those keystrokes locally and
 * would never send them as prompts anyway. If a grok upgrade adds a builtin
 * that collides with a DSH command, the DSH command simply stops being
 * advertised (the filter below) — safe by construction.
 */
export const PAGER_BUILTIN_COMMANDS: ReadonlySet<string> = new Set([
  'always-approve',
  'announcements',
  'auto',
  'btw',
  'cd',
  'compact',
  'compact-mode',
  'config-agents',
  'context',
  'copy',
  'dashboard',
  'debug',
  'delete',
  'docs',
  'doctor',
  'edit-prompt',
  'effort',
  'expand',
  'export',
  'feedback',
  'find',
  'fork',
  'gboom',
  'help',
  'history',
  'home',
  'hooks',
  'import-claude',
  'jump',
  'login',
  'logout',
  'loop',
  'mcps',
  'model',
  'multiline',
  'new',
  'personas',
  'plan',
  'privacy',
  'queue',
  'quit',
  'recap',
  'release-notes',
  'remember',
  'rename',
  'resume',
  'rewind',
  'scroll-debug',
  'session-info',
  'settings',
  'share',
  'tasks',
  'theme',
  'timeline',
  'timestamps',
  'toggle-mouse-reporting',
  'transcript',
  'tutorial',
  'usage',
  'view-plan',
  'vim-mode',
  'voice',
  'workflows',
])

/** DSH command descriptor as consumed by the bridge (duck-typed). */
export interface DshCommandDescriptor {
  /** Lowercase command name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery UI. */
  readonly description: string
  /** Optional free-form input hint advertised to capable clients. */
  readonly input?: { readonly hint?: string }
}

/** The `ctx.commands` surface the bridge consumes (duck-typed). */
export interface CommandsServiceLike {
  list(agent: unknown): readonly DshCommandDescriptor[]
  execute(
    agent: unknown,
    line: string,
    signal: AbortSignal,
  ): Promise<
    | {
        result: { readonly kind: 'success' | 'error'; readonly text?: string }
      }
    | undefined
  >
}

/**
 * Parse one slash line into its command name and trailing input. Mirrors
 * DSH's `parseCommand` (same name pattern); the pager's PassThrough text is
 * always a single line like `/goal` or `/goal <objective>`.
 * @param line - complete candidate command line.
 * @returns `{ name, rawInput }`, or undefined when the line is not a command.
 */
export function parseSlashLine(
  line: string,
): { name: string; rawInput: string } | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, rawInput: line.slice(match[0].length) }
}

/** Whether the pager itself owns this command name. */
export function isPagerBuiltin(name: string): boolean {
  return PAGER_BUILTIN_COMMANDS.has(name)
}

/**
 * Filter DSH command descriptors down to those the pager does not own.
 * @param descriptors - the agent's effective DSH command view.
 * @returns descriptors whose name is not a pager builtin.
 */
export function filterPagerConflicts(
  descriptors: readonly DshCommandDescriptor[],
): DshCommandDescriptor[] {
  return descriptors.filter((descriptor) => !isPagerBuiltin(descriptor.name))
}

/**
 * Map DSH command descriptors to the ACP `AvailableCommand` wire shape the
 * pager's slash registry parses (`name` + `description`, optional
 * `input: { type: 'unstructured', hint }`).
 * @param descriptors - filtered DSH descriptors.
 * @returns the wire `commands` array.
 */
export function toAvailableCommands(
  descriptors: readonly DshCommandDescriptor[],
): Array<{
  name: string
  description: string
  input: { type: 'unstructured'; hint: string } | null
}> {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    input:
      descriptor.input?.hint !== undefined && descriptor.input.hint.length > 0
        ? { type: 'unstructured', hint: descriptor.input.hint }
        : null,
  }))
}
