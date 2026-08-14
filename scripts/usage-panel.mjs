#!/usr/bin/env node
/**
 * usage-panel — live dsh usage meter for a tmux side pane.
 *
 * Renders the per-session usage view that the dsh-grok-tui bridge mirrors to
 * ~/.dsh/grok-usage.json (see src/acp-server.ts usageStatusFile): cache hit
 * rate, input/output tokens, total tokens, provider calls, tool wall time,
 * TTFT (mean time to first token) and TPS (average output tokens per second).
 * Polls the status file and redraws on change — no pager patch needed, works
 * with the STOCK grok binary.
 *
 * The status file always holds the MOST RECENTLY ACTIVE session (the bridge
 * overwrites it on every usage notification, stamping the sessionId), so the
 * panel follows the active session; a session switch is marked in the footer.
 *
 * Usage: node usage-panel.mjs [status-file] [interval-ms]
 *   q / Ctrl+C to exit.
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function joinHome(...parts) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return [home, ...parts].join('/')
}

export function fmtTokens(n) {
  if (n < 1_000) return `${n}`
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  return `${(n / 1e6).toFixed(3)}M`
}

export function fmtDuration(ms) {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '–'
  if (ms < 1_000) return `${ms}ms`
  const s = ms / 1_000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`
}

export function fmtTps(tps) {
  if (tps === undefined || tps === null || !Number.isFinite(tps)) return '–'
  return `${tps.toFixed(1)}/s`
}

/**
 * Render the panel body for one status-file view. `switched` marks a footer
 * that the tracked session changed since the previous render (the panel
 * follows the active session).
 */
export function renderView(view, switched = false) {
  const u = view.usage ?? {}
  const billed = (u.cacheReadTokens ?? 0) + (u.inputTokens ?? 0)
  const cachePct =
    billed > 0 ? ((100 * (u.cacheReadTokens ?? 0)) / billed).toFixed(1) : '–'
  const lines = [
    '╭─ dsh usage ───────────────────────╮',
    `│ cache hit   ${String(cachePct).padStart(6)}%  (${fmtTokens(u.cacheReadTokens ?? 0)} read) │`,
    `│ input       ${fmtTokens(u.inputTokens ?? 0).padStart(9)} tokens      │`,
    `│ output      ${fmtTokens(u.outputTokens ?? 0).padStart(9)} tokens      │`,
    `│ total       ${fmtTokens(u.pressureTokens ?? 0).padStart(9)} tokens      │`,
    `│ api calls   ${String(u.apiCalls ?? 0).padStart(9)}            │`,
    `│ tool time   ${fmtDuration(u.toolDurationMs).padStart(9)}             │`,
    `│ ttft        ${fmtDuration(u.ttftMs).padStart(9)}             │`,
    `│ tps         ${fmtTps(u.tps).padStart(9)}             │`,
    '╰───────────────────────────────────╯',
  ]
  const id = String(view.sessionId ?? '').slice(0, 8)
  const footer = switched
    ? `session ${id}… (switched) — q to close`
    : `session ${id}… — q to close`
  return `${lines.join('\n')}\n${footer}`
}

function main() {
  const file = process.argv[2] ?? joinHome('.dsh/grok-usage.json')
  const interval = Number(process.argv[3] ?? 500)

  let lastKey = ''
  let lastSessionId 
  let lastErrorShown = false

  const readView = () => {
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
        lastSessionId = undefined
        out.write('\x1b[2J\x1b[Hwaiting for dsh usage… (no turn yet)\n')
      }
      return
    }
    if (view.key === lastKey) return
    lastKey = view.key
    // First render has no previous session to switch from.
    const switched =
      lastSessionId !== undefined && view.sessionId !== lastSessionId
    lastSessionId = view.sessionId
    out.write(`\x1b[2J\x1b[H${renderView(view, switched)}\n`)
  }, interval)
}

// Only run the polling loop when executed directly (node usage-panel.mjs);
// importing the module (tests) must not start timers or touch stdin.
const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) main()
