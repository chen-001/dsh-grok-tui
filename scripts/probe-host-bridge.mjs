#!/usr/bin/env node
/**
 * Probe whether a leader socket is the DSH grok BRIDGE (not any other
 * leader). Used by grok-dsh.sh to verify the official host bridge before
 * connecting the TUI (bridge-only since v0.5.0).
 *
 * The original grok TUI also listens on ~/.grok/leader.sock when run
 * standalone — a plain connect() check would mistake that foreign leader for
 * the bridge and hand the TUI to the ORIGINAL grok backend. So this probe
 * performs the leader handshake (register + get_leader_info) and only
 * accepts a leader whose `leader_binary_version` carries the dsh-grok-tui
 * prefix (see src/index.ts SERVER_VERSION).
 *
 * Usage: node probe-host-bridge.mjs <socket-path>
 * Exit 0 when the socket is the dsh bridge, 1 otherwise (no listener,
 * foreign leader, or timeout).
 */
import { connect } from 'node:net'

const socketPath = process.argv[2]
if (!socketPath) {
  console.error('usage: probe-host-bridge.mjs <socket-path>')
  process.exit(2)
}

const TIMEOUT_MS = 2000
// A freshly upgraded dsh web can stay busy (initialization, index builds)
// for tens of seconds; keep probing generously so a slow-but-alive host is
// never mistaken for absent. Worst case adds ~20s to a fallback launch.
const ATTEMPTS = 10

/**
 * One probe attempt against the socket: connect, handshake, verify the
 * leader identity. Resolves true/false (never rejects).
 */
function attempt(socketPath) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(ok)
    }
    const socket = connect(socketPath)
    const timer = setTimeout(() => finish(false), TIMEOUT_MS)
    timer.unref?.()
    socket.on('connect', () => {
      const send = (message) => {
        const data = Buffer.from(JSON.stringify(message))
        const header = Buffer.alloc(4)
        header.writeUInt32BE(data.length, 0)
        socket.write(Buffer.concat([header, data]))
      }
      send({
        type: 'register',
        client_type: 'probe-host-bridge',
        mode: 'stdio',
        capabilities: { client_version: '0.0.0-probe' },
      })
      send({
        type: 'control',
        request_id: 'probe-1',
        command: { type: 'get_leader_info' },
      })
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0)
        if (buffer.length < 4 + len) return
        let message
        try {
          message = JSON.parse(buffer.subarray(4, 4 + len).toString())
        } catch {
          buffer = buffer.subarray(4 + len)
          continue
        }
        buffer = buffer.subarray(4 + len)
        if (message.type !== 'control_result') continue
        const ok = message.result?.Ok
        const version = typeof ok?.leader_binary_version === 'string'
          ? ok.leader_binary_version
          : ''
        finish(version.startsWith('dsh-grok-tui'))
      }
    })
    socket.on('error', () => finish(false))
  })
}

async function main() {
  // A busy host (e.g. a freshly upgraded dsh web still indexing) can delay
  // the handshake past one timeout; retry before declaring "no bridge".
  for (let i = 0; i < ATTEMPTS; i++) {
    if (await attempt(socketPath)) process.exit(0)
  }
  process.exit(1)
}

main()
