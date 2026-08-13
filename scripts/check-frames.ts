/**
 * Diagnostic: for every session log in the store, report frame structure and
 * whether frame 0 is exactly one header line (the list() contract).
 */
import { existsSync, readdirSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { scanZstdFrames } from '../../../packages/session-persistence/session-persistence-jsonl/src/zstd.ts'

const ROOT = process.env.DSH_GROK_SESSIONS ?? '/home/chenzongwei/.dsh/sessions'
const problems: string[] = []
let total = 0
for (const project of readdirSync(ROOT, { withFileTypes: true }).filter(d =>
  d.isDirectory(),
)) {
  const projPath = join(ROOT, project.name)
  for (const sess of readdirSync(projPath, { withFileTypes: true }).filter(
    d => d.isDirectory(),
  )) {
    const log = join(projPath, sess.name, 'session.jsonl.zstd')
    if (!existsSync(log)) continue
    total++
    const handle = await open(log, 'r')
    let info: string
    try {
      const st = await handle.stat()
      const head = Buffer.alloc(Math.min(st.size, 2 * 1024 * 1024))
      const { bytesRead } = await handle.read(head, 0, head.length, 0)
      const data = head.subarray(0, bytesRead)
      const { frames, tornStart } = scanZstdFrames(data)
      const frameCount = frames.length
      info = `frames(scan)=${frameCount}${tornStart !== undefined ? ' torn-tail' : ''}`
      if (frameCount === 0) {
        problems.push(`${project}/${sess.id}: NO COMPLETE FRAME in first 2MB`)
        continue
      }
      const f0 = frames[0]
      const whole = Buffer.alloc(st.size)
      await handle.read(whole, 0, st.size, 0)
      const { frames: allFrames } = scanZstdFrames(whole)
      const text = await import('node:zlib').then(
        z => z.zstdDecompressSync?.(whole.subarray(f0.start, f0.end)) ?? null,
      )
      if (text === null) {
        info += ' frame0-decode-skipped'
      } else {
        const lines = text
          .toString('utf8')
          .split('\n')
          .filter(l => l.trim().length > 0)
        if (lines.length !== 1 || !lines[0].includes('"type":"session"')) {
          problems.push(
            `${project}/${sess.id}: frame0 has ${lines.length} lines, first=${lines[0]?.slice(0, 80) ?? '(empty)'}`,
          )
        }
        info += ` frame0-lines=${lines.length} totalFrames=${allFrames.length}`
      }
    } catch (e) {
      info = `ERROR: ${(e as Error).message}`
      problems.push(`${project}/${sess.id}: ${info}`)
    } finally {
      await handle.close()
    }
    console.log(`${project}/${sess.id}: ${info}`)
  }
}
console.log(`\nTOTAL ${total} logs, PROBLEMS: ${problems.length}`)
for (const p of problems) console.log('  !! ' + p)
