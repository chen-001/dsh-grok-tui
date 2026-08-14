/**
 * Repair tests: an interleaved JSONL log (two writers appending out of seq
 * order) is rejected by the strict loader and rebuilt by repairInterleavedLog
 * into a loadable, seq-contiguous log.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from '@rstest/core'
import {
  encodeSegment,
  projectKey,
  scanZstdFrames,
} from '../src/first-prompt.ts'
import { repairInterleavedLog } from '../src/repair.ts'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)

/** Decode a concatenated-frame log (one-shot zstdDecompress stops at frame 1). */
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

/** Event seqs in log order (approximates the loader's contiguous-seq check). */
function seqsOf(text: string): number[] {
  const seqs: number[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as { seq?: unknown }
    if (typeof record.seq === 'number') seqs.push(record.seq)
  }
  return seqs
}

describe('repairInterleavedLog', () => {
  it('rebuilds an interleaved log into a loadable contiguous log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-repair-'))
    const root = join(dir, 'sessions')
    const id = SessionId('session-repair-test-0001')
    const cwd = join(dir, 'project')
    const logDir = join(root, projectKey(cwd), encodeSegment(String(id)))
    const path = join(logDir, 'session.jsonl.zstd')
    await import('node:fs/promises').then(m =>
      m.mkdir(logDir, { recursive: true }),
    )

    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: String(id),
      createdAt: 1_700_000_000_000,
      cwd,
      delegationDepth: 0,
    })
    const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
    const frame = async (lines: string[]): Promise<Buffer> => {
      return zstdCompressAsync(
        Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
        checksum,
      )
    }
    // Writer A writes seq 0-5, then writer B (stale counter) re-appends 3-8,
    // then A continues 9-11: the file interleaves out-of-order frames.
    const parts = [
      await frame([header]),
      await frame([
        event('user/message', 0),
        event('turn/start', 1),
        event('turn/end', 2),
      ]),
      await frame([
        event('user/message', 9),
        event('turn/start', 10),
        event('turn/end', 11),
      ]),
      await frame([
        event('user/message', 3),
        event('turn/start', 4),
        event('turn/end', 5),
      ]),
      await frame([
        event('user/message', 6),
        event('turn/start', 7),
        event('turn/end', 8),
      ]),
    ]
    await writeFile(path, Buffer.concat(parts))

    // The interleaved log is not seq-contiguous (a strict loader rejects it).
    const before = await decodeAll(path)
    expect(seqsOf(before)).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

    // Repair and verify the rebuilt log is fully contiguous.
    expect(await repairInterleavedLog(root, id)).toBe(true)
    const after = await decodeAll(path)
    expect(seqsOf(after)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    // Regression guard: the rebuilt log must satisfy the persistence layer's
    // first-frame contract (first frame = exactly one header line) or one
    // repaired session would poison the entire shared session catalog.
    const buf = await readFile(path)
    const frames = scanZstdFrames(buf, 1_000_000)
    const first = (
      await zstdDecompressAsync(buf.subarray(frames[0]?.start, frames[0]?.end))
    ).toString('utf8')
    expect(first).toBe(`${header}\n`)
    await rm(dir, { recursive: true, force: true })
  })

  it('refuses to touch a log that cannot be made contiguous', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-repair-'))
    const root = join(dir, 'sessions')
    const id = SessionId('session-repair-test-0002')
    const cwd = join(dir, 'project')
    const logDir = join(root, projectKey(cwd), encodeSegment(String(id)))
    const path = join(logDir, 'session.jsonl.zstd')
    await import('node:fs/promises').then(m =>
      m.mkdir(logDir, { recursive: true }),
    )

    const header = JSON.stringify({
      type: 'session',
      version: 0,
      id: String(id),
      createdAt: 1_700_000_000_000,
      cwd,
      delegationDepth: 0,
    })
    const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
    const frame = async (lines: string[]): Promise<Buffer> => {
      return zstdCompressAsync(
        Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
        checksum,
      )
    }
    // A genuine hole (seq 3 never appears) cannot be repaired.
    const parts = [
      await frame([header]),
      await frame([
        event('user/message', 0),
        event('turn/start', 1),
        event('turn/end', 2),
      ]),
      await frame([
        event('user/message', 4),
        event('turn/start', 5),
        event('turn/end', 6),
      ]),
    ]
    await writeFile(path, Buffer.concat(parts))
    const original = await readFile(path)

    expect(await repairInterleavedLog(root, id)).toBe(false)
    expect(await readFile(path)).toEqual(original)
    await rm(dir, { recursive: true, force: true })
  })
})
