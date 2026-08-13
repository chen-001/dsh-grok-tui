#!/usr/bin/env node
/**
 * usage-panel — live dsh usage meter for a tmux side pane.
 *
 * Renders the per-session usage view that the dsh-grok-tui bridge mirrors to
 * ~/.dsh/grok-usage.json (see src/acp-server.ts usageStatusFile): cache hit
 * rate, input/output tokens, total tokens, provider calls and tool wall time.
 * Polls the status file and redraws on change — no pager patch needed, works
 * with the STOCK grok binary.
 *
 * Usage: node usage-panel.mjs [status-file] [interval-ms]
 *   q / Ctrl+C to exit.
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? joinHome('.dsh/grok-usage.json')
const interval = Number(process.argv[3] ?? 500)

function joinHome(...parts) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return [home, ...parts].join('/')
}

function fmtTokens(n) {
  if (n < 1_000) return `${n}`
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  return `${(n / 1e6).toFixed(3)}M`
}

function fmtDuration(ms) {
  if (ms < 1_000) return `${ms}ms`
  const s = ms / 1_000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

let lastKey = ''
let lastErrorShown = false

function readView() {
  try {
    const raw = readFileSync(file, 'utf8').trim()
    if (!raw) return null
    const parsed = JSON.parse(raw)
    lastErrorShown = false
    return {
      key: `${parsed.sessionId}:${parsed.updatedAt}`,
      sessionId: parsed.sessionId,
      usage: parsed.usage,
    }
  } catch {
    if (!lastErrorShown) {
      lastErrorShown = true
      lastKey = ''
    }
    return null
  }
}

function render(view) {
  const u = view.usage
  const billed = u.cacheReadTokens + u.inputTokens
  const cachePct =
    billed > 0 ? ((100 * u.cacheReadTokens) / billed).toFixed(1) : '–'
  const lines = [
    '╭─ dsh usage ─────────────────────╮',
    `│ cache hit   ${String(cachePct).padStart(6)}%  (${fmtTokens(u.cacheReadTokens)} read) │`,
    `│ input       ${fmtTokens(u.inputTokens).padStart(9)} tokens      │`,
    `│ output      ${fmtTokens(u.outputTokens).padStart(9)} tokens      │`,
    `│ total       ${fmtTokens(u.pressureTokens).padStart(9)} tokens      │`,
    `│ api calls   ${String(u.apiCalls).padStart(9)}            │`,
    `│ tool time   ${fmtDuration(u.toolDurationMs).padStart(9)}          │`,
    `╰─────────────────────────────────╯`,
  ]
  return lines.join('\n')
}

const out = process.stdout
if (out.isTTY) {
  // Alt screen so the pane restores cleanly on exit.
  out.write('\x1b[?1049h')
}
try {
  process.stdin.setRawMode?.(true)
} catch {
  /* non-tty stdin: poll-only */
}
process.stdin.on('data', (chunk) => {
  if (chunk.toString().toLowerCase().includes('q') || chunk[0] === 3) {
    cleanup()
  }
})
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('SIGHUP', cleanup)

function cleanup() {
  if (out.isTTY) out.write('\x1b[?1049l')
  process.exit(0)
}

setInterval(() => {
  const view = readView()
  if (view === null) {
    if (lastKey !== '') {
      lastKey = ''
      out.write('\x1b[2J\x1b[Hwaiting for dsh usage… (no turn yet)\n')
    }
    return
  }
  if (view.key === lastKey) return
  lastKey = view.key
  out.write(`\x1b[2J\x1b[H${render(view)}\n`)
  out.write(`session ${String(view.sessionId).slice(0, 8)}… — q to close\n`)
}, interval)
