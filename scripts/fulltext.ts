import { open } from 'node:fs/promises'
import { scanLog } from '../../../packages/session-persistence/session-persistence-jsonl/src/format.ts'
import {
  decompressZstdFrame,
  scanZstdFrames,
} from '../../../packages/session-persistence/session-persistence-jsonl/src/zstd.ts'

const ROOT = process.env.DSH_GROK_SESSIONS ?? '/home/chenzongwei/.dsh/sessions'
const id = process.argv[2]
const project = process.argv[3] ?? '--home-chenzongwei-test-chen-001--'
const outPath = process.argv[4]
const logPath = `${ROOT}/${project}/${id}/session.jsonl.zstd`
const handle = await open(logPath, 'r')
const out = await open(outPath, 'w')
try {
  const st = await handle.stat()
  const raw = Buffer.alloc(st.size)
  await handle.read(raw, 0, st.size, 0)
  const { frames } = scanZstdFrames(raw)
  let text = ''
  for (const f of frames) {
    try {
      text += (
        await decompressZstdFrame(raw.subarray(f.start, f.end))
      ).toString('utf8')
    } catch {
      /* torn frame */
    }
  }
  const { meta, events } = scanLog(Buffer.from(text, 'utf8'))
  const reasoning: string[] = []
  const answer: string[] = []
  for (const ev of events) {
    if (ev.type === 'assistant/chunk') {
      const chunk = (
        ev.data as {
          chunk?: { blockType?: string; type?: string; text?: string }
        }
      ).chunk
      if (chunk?.blockType === 'reasoning' && typeof chunk.text === 'string')
        reasoning.push(chunk.text)
      if (chunk?.type === 'reasoning-delta' && typeof chunk.text === 'string')
        reasoning.push(chunk.text)
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string')
        answer.push(chunk.text)
    }
  }
  await out.write(
    `# ${id} events=${events.length}\n===== REASONING =====\n` +
      reasoning.join('') +
      '\n===== ANSWER =====\n' +
      answer.join(''),
    0,
    'utf8',
  )
} finally {
  await handle.close()
  await out.close()
}
