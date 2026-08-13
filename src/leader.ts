/**
 * Grok leader transport: length-prefixed JSON frames over a Unix domain
 * socket (Windows named pipes are out of scope for now). One connection
 * drives a bidirectional message loop; ACP payloads are raw JSON-RPC strings
 * that the SDK Stream adapter (stream.ts) parses into typed messages.
 * @module dsh-grok-tui/leader
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { createServer, Socket } from 'node:net'
import type { ClientMessage, ServerMessage } from './types.ts'
import { MAX_FRAME_BYTES } from './types.ts'

/** Version prefix identifying a leader as THIS dsh bridge (see SERVER_VERSION in index.ts). */
const DSH_BRIDGE_PREFIX = 'dsh-grok-tui'
/** How long a foreign leader gets to exit after SIGTERM before SIGKILL. */
const EVICT_GRACE_MS = 5_000
/** Extra wait after SIGKILL before giving up on a foreign leader. */
const EVICT_KILL_WAIT_MS = 2_000
/** How long to wait for a live listener to answer the identity handshake. */
const IDENTIFY_TIMEOUT_MS = 2_000

/** One accepted client connection with its frame parser. */
export class LeaderConnection {
  /** Monotonic per-server client id assigned at registration. */
  clientId: number | undefined
  private readonly chunks: Buffer[] = []
  private buffered = 0
  private closed = false
  private readonly waiters: Array<
    (message: ClientMessage | undefined) => void
  > = []
  private readonly queue: ClientMessage[] = []

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk) => {
      this.#onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    socket.on('close', () => {
      this.closed = true
      for (const waiter of this.waiters.splice(0)) waiter(undefined)
    })
    socket.on('error', () => {
      /* close handling covers teardown */
    })
  }

  #onData(chunk: Buffer): void {
    this.chunks.push(chunk)
    this.buffered += chunk.length
    for (;;) {
      const header = this.#peek(4)
      if (header === undefined) return
      const frameLen = header.readUInt32BE(0)
      if (frameLen > MAX_FRAME_BYTES) {
        this.socket.destroy()
        return
      }
      const frame = this.#take(4 + frameLen)
      if (frame === undefined) return
      try {
        const message = JSON.parse(
          frame.subarray(4).toString('utf8'),
        ) as ClientMessage
        const waiter = this.waiters.shift()
        if (waiter !== undefined) waiter(message)
        else this.queue.push(message)
      } catch {
        // Invalid JSON on the wire is a protocol violation; drop the frame.
      }
    }
  }

  /** Peek exactly `n` bytes without consuming, or undefined until available. */
  #peek(n: number): Buffer | undefined {
    if (this.buffered < n) return undefined
    const out = Buffer.alloc(n)
    let offset = 0
    for (const part of this.chunks) {
      const take = Math.min(part.length, n - offset)
      part.copy(out, offset, 0, take)
      offset += take
      if (offset >= n) break
    }
    return out
  }

  /** Consume exactly `n` bytes from the front of the buffer. */
  #take(n: number): Buffer | undefined {
    if (this.buffered < n) return undefined
    const out = Buffer.alloc(n)
    let offset = 0
    while (offset < n) {
      const part = this.chunks[0]
      if (part === undefined) return undefined
      const take = Math.min(part.length, n - offset)
      part.copy(out, offset, 0, take)
      offset += take
      this.buffered -= take
      if (take === part.length) this.chunks.shift()
      else this.chunks[0] = part.subarray(take)
    }
    return out
  }

  /** Await the next parsed client message; resolves undefined on close. */
  async next(): Promise<ClientMessage | undefined> {
    const queued = this.queue.shift()
    if (queued !== undefined) return queued
    if (this.closed) return undefined
    return new Promise((resolve) => {
      this.waiters.push(resolve)
    })
  }

  /** Send one server message as a length-prefixed frame. */
  send(message: ServerMessage): void {
    const data = Buffer.from(JSON.stringify(message), 'utf8')
    if (data.length > MAX_FRAME_BYTES) return
    const header = Buffer.alloc(4)
    header.writeUInt32BE(data.length, 0)
    this.socket.write(Buffer.concat([header, data]))
  }

  /** Send one ACP JSON-RPC payload (already a JSON string). */
  sendAcp(payload: string): void {
    this.send({ type: 'acp', payload })
  }

  close(): void {
    this.socket.end()
  }
}

/**
 * Leader server: accepts clients on a Unix socket and hands each connection
 * to `onConnection`. A stale socket file (no listener behind it) is removed
 * before binding. A LIVE listener is never silently fought over: it is
 * identified by handshake — a second dsh bridge is refused as a genuine
 * conflict, while a foreign leader (e.g. a detached grok agent-leader that
 * inherited this socket path) is evicted so the host can take over. Returns
 * the path and a disposer that stops accepting and unlinks the socket file.
 *
 * Fatal conflicts are reported through `onFatal` when provided (tests),
 * otherwise rethrown asynchronously so the host fails loudly on startup.
 *
 * SOCKET GUARD: a foreign leader may still take the socket path AFTER this
 * host bound it (a grok agent-leader unlinks and rebinds the path it
 * inherited via GROK_LEADER_SOCKET). The guard compares the path's inode
 * against the one this host bound and reclaims the path when it changes or
 * disappears, binding a fresh server while established connections keep
 * riding the old server. `reclaimIntervalMs` controls the check cadence
 * (default 5s).
 */
export function createLeaderServer(
  socketPath: string,
  onConnection: (connection: LeaderConnection) => void,
  options: {
    onFatal?: (error: Error) => void
    reclaimIntervalMs?: number
  } = {},
): { dispose(): void; path: string } {
  const { onFatal } = options
  const fatal = (error: Error): void => {
    if (onFatal !== undefined) onFatal(error)
    else setImmediate(() => {
      throw error
    })
  }
  // Several servers may coexist: a superseded one keeps serving its
  // established connections while the fresh one owns the path.
  const servers = new Set<import('node:net').Server>()
  let boundInode: number | undefined
  let binding = false

  const bind = (conflictIsFatal: boolean): void => {
    const server = createServer(socket =>
      onConnection(new LeaderConnection(socket)),
    )
    servers.add(server)
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE' && conflictIsFatal) {
        fatal(new Error(`another leader is already listening at ${socketPath}`))
      }
      // Non-fatal conflicts (reclaim races) are retried by the guard.
    })
    binding = true
    server.listen(socketPath, () => {
      binding = false
      try {
        boundInode = statSync(socketPath).ino
      } catch {
        boundInode = undefined
      }
    })
  }

  if (!existsSync(socketPath)) {
    bind(true)
  } else {
    // A socket file exists. Probe whether anything listens behind it: a dead
    // process leaves a stale file that is safe to remove; a live listener
    // must be identified and either refused (dsh bridge) or evicted
    // (foreign).
    const probe = new Socket()
    probe.on('connect', () => {
      probe.destroy()
      void takeover(socketPath, () => bind(true), fatal)
    })
    probe.on('error', () => {
      probe.destroy()
      try {
        unlinkSync(socketPath)
      } catch {
        /* raced; listen will surface it */
      }
      bind(true)
    })
    probe.connect(socketPath)
  }

  // Socket guard: reclaim the path when a foreign leader takes it over.
  const reclaimTimer = setInterval(() => {
    if (binding) return
    let current: number | undefined
    try {
      current = statSync(socketPath).ino
    } catch {
      current = undefined
    }
    if (current !== undefined && current === boundInode) return
    console.error(
      `grok-server: leader socket ${socketPath} was taken over ` +
        `(inode ${String(current)} != ${String(boundInode)}); reclaiming`,
    )
    try {
      unlinkSync(socketPath)
    } catch {
      /* raced; bind will surface it */
    }
    bind(false)
  }, options.reclaimIntervalMs ?? 5_000)
  reclaimTimer.unref?.()

  return {
    dispose(): void {
      clearInterval(reclaimTimer)
      for (const server of servers) server.close()
      try {
        unlinkSync(socketPath)
      } catch {
        /* already gone */
      }
    },
    path: socketPath,
  }
}

/** Identity of a live listener obtained by the control-protocol handshake. */
interface LeaderIdentity {
  kind: 'dsh-bridge' | 'foreign'
  pid?: number
  version?: string
}

/**
 * Handshake with the leader at `socketPath` (register + get_leader_info) to
 * learn whether it is this dsh bridge or a foreign leader, and its pid.
 * Resolves undefined when the peer never answers — a foreign process that
 * does not speak the control protocol.
 */
function identifyLeader(
  socketPath: string,
): Promise<LeaderIdentity | undefined> {
  return new Promise((resolve) => {
    const socket = new Socket()
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (identity: LeaderIdentity | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(identity)
    }
    const timer = setTimeout(() => finish(undefined), IDENTIFY_TIMEOUT_MS)
    timer.unref?.()
    socket.on('connect', () => {
      const send = (message: object): void => {
        const data = Buffer.from(JSON.stringify(message), 'utf8')
        const header = Buffer.alloc(4)
        header.writeUInt32BE(data.length, 0)
        socket.write(Buffer.concat([header, data]))
      }
      send({
        type: 'register',
        client_type: 'leader-identity-probe',
        mode: 'stdio',
        capabilities: { client_version: '0.0.0-probe' },
      })
      send({
        type: 'control',
        request_id: 'identity-1',
        command: { type: 'get_leader_info' },
      })
    })
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const len = buffer.readUInt32BE(0)
        if (buffer.length < 4 + len) return
        let message: ServerMessage
        try {
          message = JSON.parse(
            buffer.subarray(4, 4 + len).toString('utf8'),
          ) as ServerMessage
        } catch {
          buffer = buffer.subarray(4 + len)
          continue
        }
        buffer = buffer.subarray(4 + len)
        if (message.type !== 'control_result') continue
        const ok = (message.result as { Ok?: Record<string, unknown> }).Ok
        if (ok === undefined) continue
        const version =
          typeof ok.leader_binary_version === 'string'
            ? ok.leader_binary_version
            : ''
        const pid = typeof ok.pid === 'number' ? ok.pid : undefined
        finish(
          version.startsWith(DSH_BRIDGE_PREFIX)
            ? { kind: 'dsh-bridge', pid, version }
            : { kind: 'foreign', pid, version },
        )
      }
    })
    socket.on('error', () => finish(undefined))
    socket.connect(socketPath)
  })
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until `pid` is no longer alive or `timeoutMs` elapses. */
function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (!isAlive(pid) || Date.now() >= deadline) {
        resolve()
        return
      }
      setTimeout(tick, 100)
    }
    tick()
  })
}

/**
 * Ask a foreign leader to vacate the socket: SIGTERM, then SIGKILL after a
 * grace window. Best-effort; a pid that is already gone resolves immediately.
 */
async function evictLeader(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  await waitForExit(pid, EVICT_GRACE_MS)
  if (!isAlive(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
  await waitForExit(pid, EVICT_KILL_WAIT_MS)
}

/**
 * Linux-only: find the pid owning a Unix socket by matching
 * /proc/net/unix inode against every process's fds. Returns undefined when
 * unavailable or no owner is found (the process may have exited meanwhile).
 */
function findSocketOwnerPid(socketPath: string): number | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    let inode: string | undefined
    for (const line of readFileSync('/proc/net/unix', 'utf8').split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 8 && parts[parts.length - 1] === socketPath) {
        inode = parts[6]
        break
      }
    }
    if (inode === undefined) return undefined
    for (const entry of readdirSync('/proc')) {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid <= 0) continue
      try {
        for (const fd of readdirSync(`/proc/${pid}/fd`)) {
          if (readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) {
            return pid
          }
        }
      } catch {
        /* permission or race; keep scanning */
      }
    }
  } catch {
    /* /proc unavailable */
  }
  return undefined
}

/**
 * A live listener holds the socket file: identify it, then either refuse a
 * genuine conflict (a second dsh bridge) or evict a foreign leader (such as
 * a detached grok agent-leader that inherited this socket path after its
 * host exited) before binding. Without this step a leftover foreign leader
 * permanently blocks `dsh web` from restarting.
 */
async function takeover(
  socketPath: string,
  bind: () => void,
  fatal: (error: Error) => void,
): Promise<void> {
  const identity = await identifyLeader(socketPath)
  if (identity?.kind === 'dsh-bridge') {
    fatal(
      new Error(
        `another dsh web (grok-server) is already listening at ${socketPath}` +
          (identity.pid === undefined ? '' : ` (pid ${identity.pid})`) +
          ' — stop it before starting a second host',
      ),
    )
    return
  }
  let pid = identity?.pid
  if (pid === undefined) pid = findSocketOwnerPid(socketPath)
  if (identity === undefined && pid === undefined) {
    fatal(
      new Error(
        `a foreign leader is listening at ${socketPath} but its pid could ` +
          'not be identified; stop it manually and retry',
      ),
    )
    return
  }
  if (pid !== undefined) {
    console.error(
      `grok-server: evicting foreign leader (pid ${pid}, ` +
        `${identity?.version ?? 'unknown version'}) that holds ${socketPath}`,
    )
    await evictLeader(pid)
  }
  try {
    unlinkSync(socketPath)
  } catch {
    /* raced; listen will surface it */
  }
  bind()
}
