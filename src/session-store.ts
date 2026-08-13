/**
 * On-disk session-log inspection for create-vs-resume decisions.
 *
 * dsh's create path (agent-loop `restoreOrCreateConfigured`) only falls
 * back to first creation when `persistence.list()` does not list the id.
 * `list()` skips logs whose first frame is unreadable or whose first line
 * is not a parseable session header — but `materialize` still rejects a
 * file that exists on disk ("refusing to materialize ... a log already
 * exists on disk"). A log in that limbo state (empty or headerless, e.g.
 * left by a crashed or raced writer) makes every turn of that session fail
 * forever. These helpers find such logs so the server can remove them and
 * create fresh, and detect genuinely valid logs so the server can resume
 * them instead of colliding.
 * @module dsh-grok-tui/session-store
 */

import { open, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scanZstdFrames } from './first-prompt.ts'

const zstdDecompressAsync = promisify(zstdDecompress)

/** The one session-log file name the JSONL backend publishes (zstd). */
const LOG_FILE = 'session.jsonl.zstd'

/** What exists on disk for one session id. */
export type SessionLogState =
  /** No session directory / no log file anywhere in the store. */
  | { kind: 'absent' }
  /** A log file exists but carries no readable first frame (0 bytes, torn, or headerless). */
  | { kind: 'empty'; path: string }
  /** A log with a parseable first line. */
  | { kind: 'valid'; path: string }

/**
 * Classify the on-disk state of one session id: absent, empty (unreadable),
 * or valid. Scans project directories under the store root.
 * @param sessionsRoot - the shared session store (`~/.dsh/sessions`).
 * @param sessionId - the session id to look for.
 * @returns the classified state; absent when nothing is on disk.
 */
export async function sessionLogState(
  sessionsRoot: string,
  sessionId: string,
): Promise<SessionLogState> {
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return { kind: 'absent' }
  }
  for (const project of projects) {
    const log = join(sessionsRoot, project, sessionId, LOG_FILE)
    try {
      const info = await stat(log)
      if (!info.isFile()) continue
    } catch {
      continue
    }
    const first = await firstLogLine(log)
    return first === undefined
      ? { kind: 'empty', path: log }
      : { kind: 'valid', path: log }
  }
  return { kind: 'absent' }
}

/**
 * Remove a session's directory (log included). Only call for sessions whose
 * log is empty — an unreadable log carries no events worth keeping.
 * @param sessionsRoot - the shared session store (`~/.dsh/sessions`).
 * @param sessionId - the session id to remove.
 * @returns true when a directory was removed.
 */
export async function removeSessionLog(
  sessionsRoot: string,
  sessionId: string,
): Promise<boolean> {
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return false
  }
  for (const project of projects) {
    const dir = join(sessionsRoot, project, sessionId)
    try {
      await rm(dir, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
  return false
}

/** The first zstd frame's first non-empty line, or undefined when unreadable. */
async function firstLogLine(log: string): Promise<string | undefined> {
  try {
    const handle = await open(log, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      const frames = scanZstdFrames(buf.subarray(0, bytesRead), 4)
      const first = frames[0]
      if (first === undefined) return undefined
      const text = (
        await zstdDecompressAsync(buf.subarray(first.start, first.end))
      ).toString('utf8')
      return text.split('\n').find(line => line.trim().length > 0)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/**
 * Wait until a session's log is observable on disk (bounded poll). The
 * web-host attach must see the log before calling the host's `session.create`
 * with the session id: a create (instead of resume) races this server's own
 * materialize, and the loser's log-collision rejection sticks forever
 * ("refusing to materialize ... a log already exists on disk"). The harness
 * documents `session/flush` as the observation barrier for the eager write
 * path, but the persistence drain listener runs concurrently with ours, so
 * await the file itself.
 * @param sessionsRoot - the shared session store (`~/.dsh/sessions`).
 * @param sessionId - the session whose log must appear.
 * @param timeoutMs - bound on the wait (default 2000).
 * @returns the observed on-disk state (empty or valid).
 * @throws when the log did not appear within the bound.
 */
export async function waitForSessionLog(
  sessionsRoot: string,
  sessionId: string,
  timeoutMs = 2000,
): Promise<Exclude<SessionLogState, { kind: 'absent' }>> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await sessionLogState(sessionsRoot, sessionId)
    if (state.kind !== 'absent') {
      return state as Exclude<SessionLogState, { kind: 'absent' }>
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `session log for ${sessionId} did not appear within ${timeoutMs}ms`,
      )
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}
