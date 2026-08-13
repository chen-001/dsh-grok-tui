/**
 * Diagnostic: dump the user/message events (with text) of one session log,
 * using the persistence package's own frame scanner + decoder.
 * Usage: tsx scripts/dump-user-messages.ts <session-id> [maxMessages]
 */

import { readdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { scanLog } from '../../../packages/session-persistence/session-persistence-jsonl/src/format.ts'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '../../../packages/session-persistence/session-persistence-jsonl/src/zstd.ts'

const ROOT = process.env.DSH_GROK_SESSIONS ?? '/home/chenzongwei/.dsh/sessions'
const id = process.argv[2]
const maxMessages = Number(process.argv[3] ?? 200)

// locate the session dir by scanning project dirs
let logPath: string | undefined
for (const project of readdirSync(ROOT, { withFileTypes: true }).filter(d =>
  d.isDirectory(),
)) {
  const cand = join(ROOT, project.name, id, 'session.jsonl.zstd')
  if (
    readdirSync(join(ROOT, project.name), { withFileTypes: true }).some(
      d => d.isDirectory() && d.name === id,
    )
  ) {
    logPath = cand
    break
  }
}
if (logPath === undefined) {
  console.error(`session ${id} not found under ${ROOT}`)
  process.exit(1)
}
const handle = await open(logPath, 'r')
try {
  const st = await handle.stat()
  const raw = Buffer.alloc(st.size)
  await handle.read(raw, 0, st.size, 0)
  const { frames, tornStart } = scanZstdFrames(raw)
  let text = ''
  for (const f of frames) {
    text += (await decompressZstdFrame(raw.subarray(f.start, f.end))).toString(
      'utf8',
    )
  }
  if (tornStart !== undefined) {
    text += '(torn tail frame at ' + tornStart + ')'
  }
  const { meta, events } = scanLog(Buffer.from(text, 'utf8'))
  console.log(
    `# ${id}  cwd=${meta.cwd}  createdAt=${new Date(meta.createdAt).toISOString()}  events=${events.length}`,
  )
  let shown = 0
  for (const e of events) {
    if (e.type !== 'user/message') continue
    const blocks =
      (e.data as { content?: Array<{ type?: string; text?: string }> })
        .content ?? []
    const textBlocks = blocks
      .filter(b => b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
    const joined = textBlocks.join('\n')
    const seq = e.seq ?? ''
    console.log(
      `\n--- user/message seq=${seq} turn=${(e.data as { turn?: unknown }).turn ?? ''} ---`,
    )
    console.log(joined.slice(0, 4000))
    if (++shown >= maxMessages) break
  }
  console.log(`\n(total user/message shown: ${shown})`)
} finally {
  await handle.close()
}
