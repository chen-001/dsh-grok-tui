/**
 * Lightweight first-user-prompt reader for the JSONL persistence layout.
 *
 * The pager's resume picker needs each session's first user message for its
 * row label. The persistence seam only offers full-log `inspect()`, which
 * decompresses the ENTIRE zstd log — fine for a few small sessions, but the
 * shared Web store holds multi-hundred-MB logs. This module instead reads the
 * log's leading Zstandard frames (the append batches at the head of the file
 * always contain the earliest events) and stops at the first user message.
 *
 * The zstd frame scan and the path rules below mirror
 * `@deepseek-ai/dsh-session-persistence-jsonl` internals (scanZstdFrames,
 * encodeSegment, projectKey, logPath), which that package does not export;
 * keep them in lockstep if the backend layout changes.
 * @module dsh-grok-tui/first-prompt
 */

import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

const ZSTD_MAGIC = 0xfd2fb528
/** How many leading compressed bytes to scan for complete frames. */
const MAX_SCAN_BYTES = 8 * 1024 * 1024
/** Frame-decode budget: the first user message sits within a few batches. */
const MAX_FRAMES = 32

const zstdDecompressAsync = promisify(zstdDecompress)

/** Byte range of one structurally complete Zstandard frame. */
export interface ZstdFrame {
  start: number
  end: number
}

/** Mirror of dsh-session-persistence-jsonl's scanZstdFrames (frame scan only). */
export function scanZstdFrames(buffer: Buffer, maxFrames: number): ZstdFrame[] {
  const frames: ZstdFrame[] = []
  let offset = 0
  while (offset < buffer.length && frames.length < maxFrames) {
    const start = offset
    if (
      buffer.length - offset < 4 ||
      buffer.readUInt32LE(offset) !== ZSTD_MAGIC
    )
      break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) return frames
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return frames
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Mirror of dsh-session-persistence-jsonl's encodeSegment (safe path segment). */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~0020'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/** Mirror of dsh-session-persistence-jsonl's projectKey (readable project dir). */
export function projectKey(cwd: string): string {
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** A user message event's text blocks, joined (first prompt label). */
interface UserMessageLike {
  type?: unknown
  data?: { content?: Array<{ type?: unknown; text?: unknown }> }
}

/**
 * The on-disk JSONL artifact path for a persisted session (mirrors the
 * backend's `logPath`).
 * @param root - the session-persistence root directory.
 * @param cwd - the session's project directory, if any.
 * @param id - the session id.
 * @returns the artifact path (`.jsonl.zstd`).
 */
export function sessionLogPath(
  root: string,
  cwd: string | undefined,
  id: string,
): string {
  const dir =
    cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
  return join(dir, encodeSegment(id), 'session.jsonl.zstd')
}

/** Wire shape of the events this module scans for (subset of SessionEvent). */
interface ScannableEvent {
  type?: string
  data?: {
    title?: unknown
    content?: unknown
  }
}

/**
 * Latest automatic title of a persisted session, read from the log's leading
 * frames without full decompression (same budget as
 * {@link firstUserPromptFromLog}). The session-title service appends
 * `session/title` events (fallback first, then the LLM provider title), so
 * the LAST one seen is the current title. Returns undefined when the title
 * events fall outside the scanned frames or the session has none yet.
 * @param root - the persistence root.
 * @param header - session metadata (id + cwd locate the artifact).
 * @returns the latest `session/title` payload, or undefined.
 */
export async function sessionTitleFromLog(
  root: string,
  header: SessionHeader,
): Promise<string | undefined> {
  const path = sessionLogPath(root, header.cwd, String(header.id))
  let handle
  try {
    handle = await open(path, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(Math.min(MAX_SCAN_BYTES, 65536 * 16)),
      0,
      Math.min(MAX_SCAN_BYTES, 65536 * 16),
      0,
    )
    let data = buffer.subarray(0, bytesRead)
    let frames = scanZstdFrames(data, MAX_FRAMES)
    let grown = data.length
    while (frames.length === 0 && grown < MAX_SCAN_BYTES) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_SCAN_BYTES - grown))
      const { bytesRead: more } = await handle.read(
        chunk,
        0,
        chunk.length,
        grown,
      )
      if (more === 0) break
      data = Buffer.concat([data, chunk.subarray(0, more)])
      grown += more
      frames = scanZstdFrames(data, MAX_FRAMES)
    }
    let title: string | undefined
    for (const frame of frames) {
      let text: string
      try {
        text = (
          await zstdDecompressAsync(data.subarray(frame.start, frame.end))
        ).toString('utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let event: ScannableEvent
        try {
          event = JSON.parse(line) as ScannableEvent
        } catch {
          continue
        }
        if (event?.type !== 'session/title') continue
        const candidate = event.data?.title
        if (typeof candidate === 'string' && candidate.trim().length > 0) {
          title = candidate
        }
      }
    }
    return title
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {
      /* already closed */
    })
  }
}

/**
 * Read the first user message of a persisted session WITHOUT decompressing
 * the whole log: decode leading zstd frames until the first `user/message`
 * event. Returns `undefined` when the log is unreadable, has no user
 * message in the scanned prefix, or the backend layout does not match.
 * @param root - the session-persistence root directory.
 * @param header - session metadata (id + cwd locate the artifact).
 * @returns the first user prompt text, or undefined.
 */
export async function firstUserPromptFromLog(
  root: string,
  header: SessionHeader,
): Promise<string | undefined> {
  const path = sessionLogPath(root, header.cwd, String(header.id))
  let handle
  try {
    handle = await open(path, 'r')
    const { buffer, bytesRead } = await handle.read(
      Buffer.alloc(Math.min(MAX_SCAN_BYTES, 65536 * 16)),
      0,
      Math.min(MAX_SCAN_BYTES, 65536 * 16),
      0,
    )
    // A small first read may land inside frame 0's batch; grow until a
    // complete frame set (or the cap) is available.
    let data = buffer.subarray(0, bytesRead)
    let frames = scanZstdFrames(data, MAX_FRAMES)
    let grown = data.length
    while (frames.length === 0 && grown < MAX_SCAN_BYTES) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_SCAN_BYTES - grown))
      const { bytesRead: more } = await handle.read(
        chunk,
        0,
        chunk.length,
        grown,
      )
      if (more === 0) break
      data = Buffer.concat([data, chunk.subarray(0, more)])
      grown += more
      frames = scanZstdFrames(data, MAX_FRAMES)
    }
    for (const frame of frames) {
      let text: string
      try {
        text = (
          await zstdDecompressAsync(data.subarray(frame.start, frame.end))
        ).toString('utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.length === 0) continue
        let event: UserMessageLike
        try {
          event = JSON.parse(line) as UserMessageLike
        } catch {
          continue
        }
        if (event?.type !== 'user/message') continue
        const blocks = event.data?.content ?? []
        const prompt = blocks
          .filter(
            block => block?.type === 'text' && typeof block.text === 'string',
          )
          .map(block => block.text as string)
          .join('')
          .trim()
        if (prompt.length > 0) return prompt
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {
      /* already closed */
    })
  }
}
