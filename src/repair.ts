/**
 * Self-healing repair for interleaved JSONL session logs.
 *
 * The grok TUI and the DSH Web UI share one session store. When BOTH frontends
 * hold the same session open at once, their independent in-memory seq counters
 * interleave appends into the log, producing seq gaps that the backend's
 * strict loader rejects ("corrupt session log: seq gap in committed region").
 *
 * This module rebuilds such a log: decode every zstd frame, expand packed
 * chunk rows, keep the LAST occurrence of each seq (interleaved writers
 * re-append earlier seqs, so the newest occurrence belongs to the writer with
 * the furthest counter), sort by seq, and — only when the result is perfectly
 * contiguous — write back a single checksummed frame. A non-contiguous result
 * refuses to touch the file. The session-health watch drives these functions
 * proactively so the Web UI's history reads (which the grok server cannot
 * intercept) see a clean log.
 * @module dsh-grok-tui/repair
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { encodeSegment, scanZstdFrames } from './first-prompt.ts'

const zstdDecompressAsync = promisify(zstdDecompress)
const zstdCompressAsync = promisify(zstdCompress)

/**
 * Whether one session artifact carries the interleaved-writer signature: some
 * event seq appears more than once. A strict-contiguous log never repeats a
 * seq, and two writers appending contiguous ranges from divergent counters
 * necessarily overlap (repeat) — a gap-only defect (torn batch) has no repeats
 * and is not this repair's target.
 * @param path - the session artifact to scan.
 * @returns whether a repeated seq was found; `false` also for unreadable or
 *   non-zstd files (the watch leaves those alone).
 */
export async function detectInterleavedArtifact(
  path: string,
): Promise<boolean> {
  const buf = await readFile(path)
  const frames = scanZstdFrames(buf, 1_000_000)
  const { decodeStorageRecord } = await import('@deepseek-ai/dsh-session')
  const seen = new Set<number>()
  for (const frame of frames) {
    let text: string
    try {
      text = (
        await zstdDecompressAsync(buf.subarray(frame.start, frame.end))
      ).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let record: unknown
      try {
        record = JSON.parse(line) as unknown
      } catch {
        continue
      }
      for (const event of decodeStorageRecord(record)) {
        if (typeof event.seq === 'number') {
          if (seen.has(event.seq)) return true
          seen.add(event.seq)
        }
      }
    }
  }
  return false
}

/**
 * Rebuild one interleaved session artifact in place. Only writes when the
 * rebuilt log is perfectly seq-contiguous; any anomaly leaves the file
 * untouched and reports `false`.
 * @param path - the session artifact to repair.
 * @returns whether a repair was performed.
 */
export async function repairInterleavedArtifact(
  path: string,
): Promise<boolean> {
  const buf = await readFile(path)
  const frames = scanZstdFrames(buf, 1_000_000)
  const { decodeStorageRecord } = await import('@deepseek-ai/dsh-session')
  const lastSeen = new Map<number, string>()
  let header: string | undefined
  for (const frame of frames) {
    let text: string
    try {
      text = (
        await zstdDecompressAsync(buf.subarray(frame.start, frame.end))
      ).toString('utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let record: unknown
      try {
        record = JSON.parse(line) as unknown
      } catch {
        continue
      }
      if (
        typeof record === 'object' &&
        record !== null &&
        (record as { type?: unknown }).type === 'session'
      ) {
        if (header === undefined) header = line
        continue
      }
      for (const event of decodeStorageRecord(record)) {
        if (typeof event.seq === 'number') {
          lastSeen.set(event.seq, JSON.stringify(event))
        }
      }
    }
  }
  if (header === undefined) return false
  const seqs = [...lastSeen.keys()].sort((a, b) => a - b)
  let previous: number | undefined
  for (const seq of seqs) {
    if (previous !== undefined && seq !== previous + 1) return false
    previous = seq
  }
  // Write the rebuilt log as canonical concatenated frames — the header
  // alone, then event batches — instead of one giant frame. The persistence
  // layer's first-frame contract (list() reads the first frame's first
  // line; the strict loader treats each frame as an independent batch)
  // rejects a whole-log single frame, which would poison the ENTIRE shared
  // session catalog for every frontend.
  const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const frame = (lines: string[]): Promise<Buffer> =>
    zstdCompressAsync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), checksum)
  const events = seqs.map(seq => lastSeen.get(seq) as string)
  const batch = 2000
  const parts: Buffer[] = [await frame([header])]
  for (let i = 0; i < events.length; i += batch) {
    parts.push(await frame(events.slice(i, i + batch)))
  }
  await writeFile(path, Buffer.concat(parts))
  return true
}

/**
 * Rebuild a seq-interleaved session log in place. Only writes when the
 * rebuilt log is perfectly seq-contiguous; any anomaly leaves the file
 * untouched and reports `false`.
 * @param root - the session-persistence root directory.
 * @param sessionId - the session whose log to repair.
 * @returns whether a repair was performed.
 */
export async function repairInterleavedLog(
  root: string,
  sessionId: SessionId,
): Promise<boolean> {
  const id = encodeSegment(String(sessionId))
  try {
    const { glob } = await import('node:fs/promises')
    const candidates: string[] = []
    for await (const path of glob(join(root, '*', id, 'session.jsonl.zstd'))) {
      candidates.push(path)
    }
    // Prefer the newest artifact when the id appears under multiple projects.
    candidates.sort()
    const path = candidates.at(-1)
    if (path === undefined) return false
    return repairInterleavedArtifact(path)
  } catch {
    return false
  }
}
