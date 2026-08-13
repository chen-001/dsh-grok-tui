/**
 * Leader wire-protocol tests: registration handshake, keepalive pong,
 * control command answers, and disconnect handling, driven over a real Unix
 * socket by a raw framing client.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import { createLeaderServer } from '../src/leader.ts'
import { LeaderTestClient, makeGrokHarness } from './helpers.ts'

let socketPath = ''
let dispose: (() => Promise<void>) | undefined
let children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  children = []
  await dispose?.()
  dispose = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(
  check: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition not met in time')
    await sleep(50)
  }
}

/**
 * A fake leader in a child process that answers the control handshake with
 * the given `leader_binary_version` — standing in for a real
 * `xai-grok-pager` agent-leader (foreign) or another dsh bridge.
 */
function spawnFakeLeader(
  socketPath: string,
  version: string,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const script = `
      const net = require('node:net')
      const path = process.argv[1]
      const version = process.argv[2]
      const server = net.createServer((socket) => {
        socket.on('error', () => {})
        let buffer = Buffer.alloc(0)
        socket.on('data', (chunk) => {
          buffer = Buffer.concat([buffer, chunk])
          while (buffer.length >= 4) {
            const len = buffer.readUInt32BE(0)
            if (buffer.length < 4 + len) return
            const msg = JSON.parse(buffer.subarray(4, 4 + len).toString())
            buffer = buffer.subarray(4 + len)
            const data = Buffer.from(JSON.stringify({
              type: 'control_result',
              request_id: msg.request_id ?? 'x',
              result: { Ok: {
                pid: process.pid,
                socket_path: path,
                leader_binary_version: version,
                leader_protocol_version: 1,
              } },
            }))
            const header = Buffer.alloc(4)
            header.writeUInt32BE(data.length, 0)
            socket.write(Buffer.concat([header, data]))
          }
        })
      })
      server.listen(path, () => process.stdout.write('ready\\n'))
    `
    const child = spawn(process.execPath, ['-e', script, socketPath, version], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    children.push(child)
    let out = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      out += String(chunk)
      if (out.includes('ready')) resolve(child)
    })
    child.on('error', reject)
    child.on('exit', () => reject(new Error('fake leader exited early')))
  })
}

/** Poll until any leader listens (identity-agnostic). */
async function waitForConnect(
  socketPath: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const client = await LeaderTestClient.connect(socketPath)
      client.close()
      return
    } catch {
      /* not listening yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(`no listener at ${socketPath} within ${timeoutMs}ms`)
    }
    await sleep(100)
  }
}

/** Poll until a leader answering the DSH bridge handshake listens. */
async function waitForBridge(socketPath: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const client = await LeaderTestClient.connect(socketPath)
      try {
        client.sendControl({
          type: 'control',
          request_id: 'probe',
          command: { type: 'get_leader_info' },
        })
        const frame = await Promise.race([
          client.nextFrame(),
          sleep(2_000).then(() => undefined),
        ])
        const message = frame?.kind === 'control' ? frame.message : {}
        const payload = message.result as { Ok?: Record<string, unknown> }
        if (
          typeof payload?.Ok?.leader_binary_version === 'string' &&
          String(payload.Ok.leader_binary_version).startsWith('dsh-grok-tui')
        ) {
          return
        }
      } finally {
        client.close()
      }
    } catch {
      /* not a bridge yet */
    }
    if (Date.now() >= deadline) {
      throw new Error(`no dsh bridge at ${socketPath} within ${timeoutMs}ms`)
    }
    await sleep(100)
  }
}

describe('leader transport', () => {
  it('registers a client with protocol metadata and capabilities', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    const client = await LeaderTestClient.connect(socketPath)
    const registered = await client.register()
    expect(registered.type).toBe('registered')
    expect(registered.ready).toBe(true)
    expect(registered.leader_protocol_version).toBe(1)
    expect(typeof registered.client_id).toBe('number')
    client.close()
  })

  it('answers keepalive pings with pong', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    const client = await LeaderTestClient.connect(socketPath)
    await client.register()
    client.sendControl({ type: 'ping' })
    const frame = await client.nextFrame()
    expect(frame).toEqual({ kind: 'control', message: { type: 'pong' } })
    client.close()
  })

  it('answers get_leader_info with the socket path and protocol version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    const client = await LeaderTestClient.connect(socketPath)
    await client.register()
    client.sendControl({
      type: 'control',
      request_id: 'r1',
      command: { type: 'get_leader_info' },
    })
    const frame = await client.nextFrame()
    expect(frame?.kind).toBe('control')
    const message = frame?.kind === 'control' ? frame.message : {}
    expect(message.type).toBe('control_result')
    expect(message.request_id).toBe('r1')
    const payload = message.result as { Ok?: Record<string, unknown> }
    expect(payload.Ok?.socket_path).toBe(socketPath)
    expect(payload.Ok?.leader_protocol_version).toBe(1)
    client.close()
  })

  it('rejects unsupported control commands with an error result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    const client = await LeaderTestClient.connect(socketPath)
    await client.register()
    client.sendControl({
      type: 'control',
      request_id: 'r2',
      command: { type: 'relaunch_for_update', to_version: '9.9.9' },
    })
    const frame = await client.nextFrame()
    const message = frame?.kind === 'control' ? frame.message : {}
    expect(message.type).toBe('control_result')
    const payload = message.result as { Err?: { code: string } }
    expect(payload.Err?.code).toBe('internal_error')
    client.close()
  })

  it('closes the connection on disconnect', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    const client = await LeaderTestClient.connect(socketPath)
    await client.register()
    client.sendControl({ type: 'disconnect' })
    const frame = await client.nextFrame()
    expect(frame).toBeUndefined()
  })

  it('evicts a foreign leader holding the socket and takes over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    // A foreign leader that answers the handshake as xai-grok-pager — the
    // shape of a detached grok agent-leader that inherited this socket path.
    const foreign = await spawnFakeLeader(socketPath, 'xai-grok-pager-0.0.0-test')
    await waitForConnect(socketPath)

    // Mounting the real plugin must evict the foreign process and bind.
    const harness = await makeGrokHarness({ socketPath })
    dispose = harness.dispose

    await waitForBridge(socketPath)
    await waitFor(() => foreign.exitCode !== null || foreign.signalCode !== null)
    expect(foreign.signalCode).toBe('SIGTERM')

    // The takeover is a real dsh bridge speaking the full protocol.
    const client = await LeaderTestClient.connect(socketPath)
    await client.register()
    client.close()
  })

  it('refuses a second dsh bridge without killing it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    const bridge = await spawnFakeLeader(socketPath, 'dsh-grok-tui-0.1.0-test')
    await waitForBridge(socketPath)

    let fatal: Error | undefined
    const leader = createLeaderServer(socketPath, () => {}, {
      onFatal: (error) => {
        fatal = error
      },
    })
    await waitFor(() => fatal !== undefined)
    expect(fatal?.message).toMatch(/another dsh web/)
    // The running bridge must be left untouched.
    expect(bridge.exitCode).toBeNull()
    expect(bridge.signalCode).toBeNull()
    leader.dispose()
  })

  it('removes a stale socket file left by a dead process and binds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    await writeFile(socketPath, '')
    let fatal: Error | undefined
    const leader = createLeaderServer(socketPath, () => {}, {
      onFatal: (error) => {
        fatal = error
      },
    })
    await waitForConnect(socketPath)
    expect(fatal).toBeUndefined()
    leader.dispose()
  })

  it('reclaims the socket path when a foreign leader takes it over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-leader-'))
    socketPath = join(dir, 'leader.sock')
    let fatal: Error | undefined
    const leader = createLeaderServer(socketPath, () => {}, {
      onFatal: (error) => {
        fatal = error
      },
      reclaimIntervalMs: 200,
    })
    await waitForConnect(socketPath)
    const hostInode = statSync(socketPath).ino

    // A foreign leader takes the path: unlink + rebind (the grok agent-leader
    // does exactly this via run_leader_server's remove_file + bind).
    rmSync(socketPath)
    await waitFor(
      () => {
        try {
          return statSync(socketPath).ino !== hostInode
        } catch {
          return false
        }
      },
      5_000,
    )
    // The guard must reclaim the path and keep serving connections.
    expect(fatal).toBeUndefined()
    await waitForConnect(socketPath)
    leader.dispose()
  })
})
