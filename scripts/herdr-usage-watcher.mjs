#!/usr/bin/env node
/**
 * herdr-usage-watcher — mirror the dsh usage view into a herdr agent pane.
 *
 * When grok-dsh runs inside a herdr pane (HERDR_ENV=1), this watcher polls
 * the dsh usage status file (~/.dsh/grok-usage.json, written by
 * src/acp-server.ts) and pushes the metrics into herdr's `pane.report_metadata`
 * IPC as metadata tokens: cache hit %, TTFT, TPS, in/out tokens. herdr's
 * sidebar renders those under the agent entry when the sidebar config
 * declares `Custom("dsh_cache")`-style rows (see README "herdr 适配").
 *
 * Usage: node herdr-usage-watcher.mjs [status-file] [interval-ms]
 * Environment: HERDR_SOCKET_PATH (default ~/.config/herdr/herdr.sock),
 * HERDR_PANE_ID (required — herdr injects it into pane processes).
 */
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'

const statusFile =
  process.argv[2] ?? joinHome('.dsh/grok-usage.json')
const interval = Number(process.argv[3] ?? 500)

const socketPath =
  process.env.HERDR_SOCKET_PATH ?? joinHome('.config/herdr/herdr.sock')
const paneId = process.env.HERDR_PANE_ID

if (!paneId) {
  console.error('herdr-usage-watcher: HERDR_PANE_ID is not set — not in a herdr pane?')
  process.exit(1)
}

function joinHome(...parts) {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
  return [home, ...parts].join('/')
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return null
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  // M-primary display: kilo-level counts render as M too (18.1K → 0.018M);
  // only sub-thousand counts keep the bare number (0.000M would be noise).
  if (n >= 1_000) return `${(n / 1e6).toFixed(3)}M`
  return `${n}`
}

function fmtSeconds(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null
  if (ms < 1_000) return `${ms}ms`
  return `${(ms / 1_000).toFixed(1)}s`
}

let lastSignature = ''

function currentSignature() {
  try {
    const raw = readFileSync(statusFile, 'utf8').trim()
    if (!raw) return 'empty'
    const parsed = JSON.parse(raw)
    return `${parsed.updatedAt}:${JSON.stringify(parsed.usage)}`
  } catch {
    return 'empty'
  }
}

/** Send one JSON-RPC request to the herdr server socket (fire and forget). */
function report(tokens) {
  const request = {
    id: `dsh-grok-tui:${Date.now()}`,
    method: 'pane.report_metadata',
    params: {
      pane_id: paneId,
      source: 'dsh-grok-tui',
      agent: 'grok',
      tokens,
      ttl_ms: 60_000,
    },
  }
  const socket = createConnection(socketPath)
  socket.on('connect', () => {
    socket.end(`${JSON.stringify(request)}\n`)
  })
  socket.on('error', () => {
    /* herdr may be absent; retry on the next poll */
  })
}

function buildTokens(usage) {
  const billed = usage.cacheReadTokens + usage.inputTokens
  const tokens = {}
  if (billed > 0) {
    tokens.dsh_cache = `${((100 * usage.cacheReadTokens) / billed).toFixed(1)}%`
  }
  const ttft = fmtSeconds(usage.ttftMs)
  if (ttft) tokens.dsh_ttft = ttft
  if (Number.isFinite(usage.tps) && usage.tps > 0) {
    tokens.dsh_tps = `${usage.tps.toFixed(1)}/s`
  }
  const inTokens = fmtTokens(usage.inputTokens)
  if (inTokens) tokens.dsh_in = inTokens
  const outTokens = fmtTokens(usage.outputTokens)
  if (outTokens) tokens.dsh_out = outTokens
  return tokens
}

const CLEAR_TOKENS = {
  'dsh_cache': null,
  'dsh_ttft': null,
  'dsh_tps': null,
  'dsh_in': null,
  'dsh_out': null,
}

/** How often to re-send the current tokens even when nothing changed. */
const RENEW_INTERVAL_MS = 30_000

let lastReportAt = 0

function reportIfChanged() {
  const signature = currentSignature()
  const now = Date.now()
  // Renew: herdr expires metadata tokens after their TTL (60s); re-send the
  // current view on a shorter cadence so the metrics persist for the whole
  // grok-dsh session, not just while usage keeps changing.
  if (signature === lastSignature && now - lastReportAt < RENEW_INTERVAL_MS) {
    return
  }
  lastSignature = signature
  lastReportAt = now
  if (signature === 'empty') {
    report(CLEAR_TOKENS)
    return
  }
  const parsed = JSON.parse(readFileSync(statusFile, 'utf8'))
  report(buildTokens(parsed.usage ?? {}))
}

setInterval(reportIfChanged, interval)

// grok-dsh stops the watcher with SIGTERM when the TUI closes: clear the
// pane's metrics before exiting so no stale numbers linger in the sidebar.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    report(CLEAR_TOKENS)
    setTimeout(() => process.exit(0), 300)
  })
}
