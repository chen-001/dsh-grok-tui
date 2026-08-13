/**
 * Seq-continuity scan for session logs — the shared assertion between the
 * integration tests and the live host-bridge verification script.
 *
 * Decode a zstd JSONL session artifact and report every event position whose
 * seq does not continue the committed region, applying exactly the rule the
 * strict loader enforces (`SessionLogScanner`: expected seq == event index).
 * A single writer in one process can never produce a gap; the scan exists to
 * prove that dual-frontend (web + grok) logs stay contiguous, and to detect
 * legacy two-process interleaving left in a store.
 * @module dsh-grok-tui/seq-scan
 */

import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scanZstdFrames } from './first-prompt.ts'

const zstdDecompressAsync = promisify(zstdDecompress)

/**
 * The event seqs of every decoded record in one session artifact, in file
 * order, excluding the header record. Unreadable frames and records are
 * skipped (mirroring the repair scanner's tolerance).
 * @param path - the session artifact to scan.
 * @returns the flattened seq sequence.
 */
export async function seqsOfLog(path: string): Promise<number[]> {
  const buf = await readFile(path)
  const frames = scanZstdFrames(buf, 1_000_000)
  const { decodeStorageRecord } = await import('@deepseek-ai/dsh-session')
  const seqs: number[] = []
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
        continue
      }
      for (const event of decodeStorageRecord(record)) {
        if (typeof event.seq === 'number') seqs.push(event.seq)
      }
    }
  }
  return seqs
}

/**
 * Positions whose seq does not continue the committed region (0-based event
 * index). Empty result means the log is perfectly contiguous — the strict
 * loader would accept it.
 * @param seqs - the flattened event seq sequence of one artifact.
 * @returns the gap positions.
 */
export function seqGaps(seqs: readonly number[]): number[] {
  const gaps: number[] = []
  for (let i = 0; i < seqs.length; i++) {
    if (seqs[i] !== i) gaps.push(i)
  }
  return gaps
}
