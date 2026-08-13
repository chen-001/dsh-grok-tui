/**
 * Diagnostic: replicate the /resume picker's session-catalog recognition
 * (persistence.list() + firstUserPromptFromLog) against the REAL store, and
 * report which sessions are recognized and which fall out of the list.
 */
import { existsSync, readdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { parseHeaderMeta } from '../../../packages/session-persistence/session-persistence-jsonl/src/format.ts'
import { firstUserPromptFromLog, scanZstdFrames } from '../src/first-prompt.ts'

const zstdDecompressAsync = promisify(zstdDecompress)
const ROOT = process.env.DSH_GROK_SESSIONS ?? '/home/chenzongwei/.dsh/sessions'
const ONLY_PROJECT = process.argv[2]

async function firstLineOf(log: string): Promise<string | undefined> {
  const handle = await open(log, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
    const frames = scanZstdFrames(buf.subarray(0, bytesRead), 4)
    if (frames.length === 0) return undefined
    const text = (
      await zstdDecompressAsync(buf.subarray(frames[0].start, frames[0].end))
    ).toString('utf8')
    return text.split('\n').find(line => line.trim().length > 0)
  } finally {
    await handle.close()
  }
}

const rows: Array<{
  id: string
  cwd?: string
  recognized: boolean
  prompt?: string
  firstLine?: string
}> = []
for (const project of readdirSync(ROOT, { withFileTypes: true }).filter(d =>
  d.isDirectory(),
)) {
  if (ONLY_PROJECT !== undefined && project.name !== ONLY_PROJECT) continue
  const projPath = join(ROOT, project.name)
  for (const sess of readdirSync(projPath, { withFileTypes: true }).filter(
    d => d.isDirectory(),
  )) {
    const log = join(projPath, sess.name, 'session.jsonl.zstd')
    if (!existsSync(log)) continue
    const firstLine = await firstLineOf(log)
    const header =
      firstLine === undefined ? undefined : parseHeaderMeta(firstLine)
    const prompt =
      header === undefined
        ? undefined
        : await firstUserPromptFromLog(ROOT, header)
    rows.push({
      id: sess.name,
      cwd: header?.cwd,
      recognized: prompt !== undefined,
      prompt: prompt?.slice(0, 90),
      firstLine: firstLine?.slice(0, 160),
    })
  }
}

rows.sort((a, b) =>
  a.recognized === b.recognized
    ? a.id.localeCompare(b.id)
    : a.recognized
      ? 1
      : -1,
)
for (const r of rows) {
  console.log(`${r.recognized ? 'OK ' : 'MISS'} ${r.id}`)
  console.log(`    cwd: ${r.cwd ?? '(none)'}`)
  if (r.recognized) console.log(`    first prompt: ${r.prompt}`)
  else console.log(`    first line:   ${r.firstLine ?? '(unreadable)'}`)
}
const missing = rows.filter(r => !r.recognized)
console.log(
  `\nTOTAL ${rows.length}, recognized ${rows.length - missing.length}, MISSING from /resume list: ${missing.length}`,
)
