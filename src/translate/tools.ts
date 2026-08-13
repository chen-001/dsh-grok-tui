/**
 * Tool translation: DSH tool names/args/results → the grok TUI's rendering
 * conventions (ToolKind categories, camelCase raw-input keys, title prefixes
 * like "Web search:", and the grok `ToolOutput` tagged union for
 * raw_output). Pure functions; the render-side port comes from
 * dsh-opencode-server's OpenCode translation, adjusted to grok's vocabulary.
 * @module dsh-grok-tui/translate/tools
 */

import type { ToolKind } from '@agentclientprotocol/sdk'

/** Map a DSH tool name to the grok TUI display name. */
export function toGrokToolName(name: string): string {
  switch (name) {
    case 'web_fetch':
      return 'webfetch'
    case 'web_search':
      return 'websearch'
    case 'todo_write':
      return 'todowrite'
    case 'str_replace_editor':
      return 'edit'
    case 'subagent':
      return 'task'
    case 'ask_user_question':
      return 'question'
    default:
      return name
  }
}

/** Map a DSH tool name to the ACP ToolKind category the pager renders by. */
export function toolKindOf(name: string): ToolKind {
  switch (name) {
    case 'bash':
      return 'execute'
    case 'str_replace_editor':
    case 'write':
      return 'edit'
    case 'read':
    case 'glob':
      return 'read'
    case 'grep':
      return 'search'
    case 'web_fetch':
      return 'fetch'
    case 'web_search':
      return 'search'
    default:
      return 'other'
  }
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z0-9])/gu, (_match, char: string) =>
    char.toUpperCase(),
  )
}

/**
 * Shape parsed tool arguments for the TUI renderers, which read camelCase
 * keys (`filePath`) where DSH schemas use snake_case (`file_path`).
 * @param input - the parsed tool arguments.
 * @returns the arguments with camelCase display keys.
 */
export function shapeToolInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const shaped: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input))
    shaped[toCamelCase(key)] = value
  return shaped
}

/** The display title of a tool call, matching grok's per-tool titles. */
export function toolTitle(
  displayName: string,
  input: Record<string, unknown>,
): string {
  if (displayName === 'bash') {
    const command = input.command
    return typeof command === 'string' ? command : displayName
  }
  if (displayName === 'edit') {
    const filePath = input.filePath ?? input.path
    return typeof filePath === 'string' ? String(filePath) : displayName
  }
  if (displayName === 'read' || displayName === 'glob') {
    const filePath = input.filePath ?? input.path
    return typeof filePath === 'string' ? String(filePath) : displayName
  }
  if (displayName === 'websearch') {
    const query = input.query
    return typeof query === 'string' ? `Web search: ${query}` : displayName
  }
  if (displayName === 'webfetch') {
    const url = input.url
    return typeof url === 'string' ? `Web fetch: ${url}` : displayName
  }
  if (displayName === 'todowrite') {
    const todos = todoList(input.todos)
    const open = todos.filter(todo => todo.status !== 'completed').length
    return `${open} todos`
  }
  if (displayName === 'question') {
    const count = Array.isArray(input.questions) ? input.questions.length : 0
    return `Asked ${count} question${count === 1 ? '' : 's'}`
  }
  return displayName
}

/** Extract the printable output text of a DSH tool result. */
export function extractToolOutput(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const texts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const block = item as { content?: unknown; text?: unknown }
    if (Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (typeof inner === 'object' && inner !== null) {
          const text = (inner as { text?: unknown }).text
          if (typeof text === 'string') texts.push(text)
        }
      }
    } else if (typeof block.text === 'string') {
      texts.push(block.text)
    }
  }
  return texts.join('\n')
}

/** Narrow a value to a todo item list. */
function todoList(value: unknown): Array<{ content: string; status: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item): Array<{ content: string; status: string }> => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const content = record.content
    const status = record.status
    if (typeof content !== 'string' || typeof status !== 'string') return []
    return [{ content, status }]
  })
}

/** One applied-hunk diff as carried by the fs edit tool's result meta. */
interface MetaDiff {
  path: string
  oldText: string | null
  newText: string
}

/** Narrow the DSH `tool/result` `meta` payload to applied-file diffs. */
function metaDiffs(meta: unknown): MetaDiff[] {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta))
    return []
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs)) return []
  return diffs.flatMap((item): MetaDiff[] => {
    if (typeof item !== 'object' || item === null) return []
    const record = item as Record<string, unknown>
    const { path, oldText, newText } = record
    if (typeof path !== 'string' || typeof newText !== 'string') return []
    if (oldText !== null && typeof oldText !== 'string') return []
    return [{ path, oldText, newText }]
  })
}

/**
 * Build the grok `ToolOutput` tagged-union JSON for a tool result's
 * raw_output, keyed to what the pager's renderers parse. Unknown tools fall
 * back to the generic `Text` variant; malformed inputs fall back to `Text`
 * with the raw output text.
 */
export function toolOutputFor(
  displayName: string,
  input: Record<string, unknown>,
  output: string,
  meta: unknown,
): Record<string, unknown> {
  if (displayName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    const failed = output.trim().length === 0
    return {
      type: 'Bash',
      output: Array.from(Buffer.from(output, 'utf8')),
      output_for_prompt: '',
      exit_code: failed ? 1 : 0,
      command,
      truncated: false,
      timed_out: false,
      current_dir: '',
    }
  }
  if (displayName === 'read') {
    const path =
      typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.path === 'string'
          ? input.path
          : ''
    const lines = output.split('\n')
    return {
      type: 'ReadFile',
      FileContent: {
        content: output,
        absolute_path: path,
        offset: null,
        limit: null,
        total_lines: lines.length,
        raw_output: output,
      },
    }
  }
  if (displayName === 'edit') {
    const diffs = metaDiffs(meta)
    const details = diffs.map(diff => ({
      old_string: diff.oldText ?? '',
      old_line: 1,
      new_string: diff.newText,
      new_line: 1,
      context_before: '',
      context_after: '',
    }))
    const path =
      typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.path === 'string'
          ? input.path
          : ''
    return {
      type: 'SearchReplace',
      EditsApplied: {
        old_string: details[0]?.old_string ?? '',
        new_string: details[0]?.new_string ?? '',
        tool_output_for_prompt: '',
        absolute_path: path,
        edits: { details },
        patch: undefined,
      },
    }
  }
  if (displayName === 'websearch') {
    const query = typeof input.query === 'string' ? input.query : ''
    return { type: 'WebSearch', query, content: output, citations: [] }
  }
  if (displayName === 'todowrite') {
    return { type: 'Todo', todos: todoList(input.todos) }
  }
  return { type: 'Text', text: output }
}
