/**
 * Session-health watch tests: the interleaved-writer detector, the path-level
 * repair, and the watch pass that heals stable interleaved artifacts in the
 * shared store so the DSH Web UI's history reads see a clean log.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { describe, expect, it } from '@rstest/core'
import {
  encodeSegment,
  projectKey,
  scanZstdFrames,
} from '../src/first-prompt.ts'
import {
  detectInterleavedArtifact,
  repairInterleavedArtifact,
} from '../src/repair.ts'
import { startSessionHealthWatch } from '../src/session-health.ts'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

const frame = (text: string): Promise<Buffer> =>
  zstdCompressAsync(Buffer.from(`${text}\n`, 'utf8'), checksum)

/** Write one session artifact: a header frame plus one frame per line group. */
async function writeSessionLog(
  root: string,
  cwd: string,
  id: string,
  lines: string[][],
): Promise<string> {
  const dir = join(root, projectKey(cwd), encodeSegment(id))
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'session.jsonl.zstd')
  const header = JSON.stringify({
    type: 'session',
    version: 0,
    id,
    createdAt: 1,
    delegationDepth: 0,
  })
  const parts: Buffer[] = [await frame(header)]
  for (const group of lines) {
    parts.push(await frame(group.join('\n')))
  }
  await writeFile(path, Buffer.concat(parts))
  return path
}

/** Decode every frame's plaintext in order. */
async function decodeAll(path: string): Promise<string> {
  const buf = await readFile(path)
  const frames = scanZstdFrames(buf, 1_000_000)
  const parts: Buffer[] = []
  for (const frame of frames) {
    parts.push(await zstdDecompressAsync(buf.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

function event(type: string, seq: number): string {
  return JSON.stringify({ type, seq, time: 1_700_000_000_000 + seq, data: {} })
}

/** Event seqs in log order. */
function seqsOf(text: string): number[] {
  const seqs: number[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as { seq?: unknown }
    if (typeof record.seq === 'number') seqs.push(record.seq)
  }
  return seqs
}

/** Backdate an artifact so the health watch treats it as idle. */
async function backdate(path: string): Promise<void> {
  const old = new Date(Date.now() - 60_000)
  await utimes(path, old, old)
}

const silentLogger = { info: () => {}, warn: () => {} }

describe('detectInterleavedArtifact', () => {
  it('flags a log whose seqs repeat (two writers interleaved)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-'))
    try {
      const root = join(dir, 'sessions')
      const cwd = join(dir, 'project')
      const clean = await writeSessionLog(root, cwd, 'clean-session', [
        [event('turn/start', 0), event('user/message', 1)],
        [event('step/start', 2), event('turn/end', 3)],
      ])
      const interleaved = await writeSessionLog(
        root,
        cwd,
        'interleaved-session',
        [
          [
            event('turn/start', 0),
            event('user/message', 1),
            event('step/start', 2),
          ],
          // A stale second writer re-appends seqs the first already wrote.
          [event('step/end', 2), event('turn/end', 3)],
        ],
      )
      expect(await detectInterleavedArtifact(clean)).toBe(false)
      expect(await detectInterleavedArtifact(interleaved)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not flag a missing-seq (torn) log — that is not this repair', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-'))
    try {
      const root = join(dir, 'sessions')
      const cwd = join(dir, 'project')
      const torn = await writeSessionLog(root, cwd, 'torn-session', [
        [event('turn/start', 0), event('step/start', 2)], // seq 1 missing
      ])
      expect(await detectInterleavedArtifact(torn)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('repairInterleavedArtifact', () => {
  it('rebuilds an interleaved artifact into a contiguous log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-'))
    try {
      const root = join(dir, 'sessions')
      const cwd = join(dir, 'project')
      const id = 'repair-path-session'
      const path = await writeSessionLog(root, cwd, id, [
        [
          event('turn/start', 0),
          event('user/message', 1),
          event('step/start', 2),
        ],
        [event('step/end', 2), event('turn/end', 3)],
      ])
      expect(await repairInterleavedArtifact(path)).toBe(true)
      expect(seqsOf(await decodeAll(path))).toEqual([0, 1, 2, 3])
      // The repaired artifact stays stable: a second repair rewrites the same
      // canonical bytes (idempotent).
      const before = await readFile(path)
      expect(await repairInterleavedArtifact(path)).toBe(true)
      expect(await readFile(path)).toEqual(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a rebuild with a genuine hole (file untouched)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-'))
    try {
      const root = join(dir, 'sessions')
      const cwd = join(dir, 'project')
      const path = await writeSessionLog(root, cwd, 'hole-session', [
        [event('turn/start', 0), event('step/start', 2)], // seq 1 missing
        [event('step/end', 2)],
      ])
      const before = await readFile(path)
      expect(await repairInterleavedArtifact(path)).toBe(false)
      expect(await readFile(path)).toEqual(before)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('session health watch', () => {
  it('heals a stable interleaved log and skips active and clean ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-'))
    try {
      const root = join(dir, 'sessions')
      const cwd = join(dir, 'project')
      const stale = await writeSessionLog(root, cwd, 'stale-interleaved', [
        [
          event('turn/start', 0),
          event('user/message', 1),
          event('step/start', 2),
        ],
        [event('step/end', 2), event('turn/end', 3)],
      ])
      await backdate(stale)
      const clean = await writeSessionLog(root, cwd, 'clean-session', [
        [event('turn/start', 0), event('user/message', 1)],
        [event('step/start', 2), event('turn/end', 3)],
      ])
      await backdate(clean)
      // Actively written (fresh mtime): the watch must not fight the writer.
      const active = await writeSessionLog(root, cwd, 'active-interleaved', [
        [
          event('turn/start', 0),
          event('user/message', 1),
          event('step/start', 2),
        ],
        [event('step/end', 2), event('turn/end', 3)],
      ])

      const watch = startSessionHealthWatch({
        root,
        intervalMs: 15_000,
        logger: silentLogger,
      })
      try {
        await watch.tick()
        expect(seqsOf(await decodeAll(stale))).toEqual([0, 1, 2, 3])
        const cleanBefore = await readFile(clean)
        await watch.tick()
        expect(await readFile(clean)).toEqual(cleanBefore)
        // The active artifact keeps its interleaved bytes (skipped).
        expect(seqsOf(await decodeAll(active))).toEqual([0, 1, 2, 2, 3])
      } finally {
        watch.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips a tick while the previous pass is still running (no concurrent passes)', async () => {
    // A pass over a large store outlives the 15s interval; without the guard
    // every interval starts another concurrent pass (each decompressing whole
    // artifacts), stacking to multi-core saturation (observed ~487% CPU on a
    // 355MB store). The second tick must be skipped while the first runs.
    const dir = await mkdtemp(join(tmpdir(), 'grok-health-skip-'))
    const warnings: string[] = []
    const watch = startSessionHealthWatch({
      root: dir,
      intervalMs: 60_000, // never auto-fires within the test window
      logger: { info: () => {}, warn: (message: string) => warnings.push(message) },
    })
    try {
      // tick() enters synchronously and sets the in-flight guard before its
      // first await, so the second call observes it and skips.
      const first = watch.tick()
      const second = watch.tick()
      await Promise.all([first, second])
      expect(
        warnings.some(message => message.includes('still running')),
      ).toBe(true)
    } finally {
      watch.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })
})
