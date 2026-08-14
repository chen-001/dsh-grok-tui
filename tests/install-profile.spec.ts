/**
 * install-profile.mjs 块修复的回归测试（0.2.8）:
 * 历史 bug 曾产生重复 `id: grok-server`（0.2.6 块替换边界只删了 marker 行，
 * 旧块体残留）与空 `- insert:` 壳，导致 loader 报
 * "duplicate loader entry id: grok-server" 使 dsh web 无法启动。
 * 每个用例在独立临时 DSH_HOME 下跑脚本，断言输出文件形态。
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from '@rstest/core'

const pluginDir = join(import.meta.dirname, '..')
const base = await mkdtemp(join(tmpdir(), 'grok-install-profile-'))

const runInstaller = dshHome =>
  new Promise((resolve, reject) => {
    execFile(
      'node',
      ['scripts/install-profile.mjs', '--plugin-dir', pluginDir, '--dsh-home', dshHome],
      { cwd: pluginDir },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })

async function withPatch(content) {
  const dir = join(base, `case-${Math.random().toString(36).slice(2)}`)
  const profileDir = join(dir, 'profiles', 'web')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'cordis.patch.yml'), content)
  return { dir, patchPath: join(profileDir, 'cordis.patch.yml') }
}

const OLD_BLOCK = `# grok TUI bridge (added by dsh-grok-tui install.sh)
- insert:
    - id: grok-server
      name: dsh-grok-tui
      config:
        provider: deepseek-official
        model: !!js process.env.DSH_GROK_MODEL ?? 'deepseek-v4-pro'
        effort: !!js process.env.DSH_GROK_EFFORT ?? 'max'
        lastModelFile: !!js dshHomePath('grok-last-model')
        persistenceRoot: !!js dshHomePath('sessions')
        storageRoot: !!js dshHomePath('storages')
        userInteractionProvider: false
`

const NEW_BLOCK = `# grok TUI bridge (added by dsh-grok-tui install.sh): makes the grok TUI a
# peer client of this host — browser tabs and grok windows share one live
# agent per session, so interleaved session logs are structurally impossible.
- insert:
    - id: grok-server
      name: dsh-grok-tui
      config:
        socketPath: !!js (process.env.XDG_RUNTIME_DIR || '/tmp') + '/grok-leader.sock'
        provider: deepseek-official
        model: !!js process.env.DSH_GROK_MODEL ?? 'deepseek-v4-pro'
        effort: !!js process.env.DSH_GROK_EFFORT ?? 'max'
        lastModelFile: !!js dshHomePath('grok-last-model')
        persistenceRoot: !!js dshHomePath('sessions')
        storageRoot: !!js dshHomePath('storages')
        userInteractionProvider: false
        healthWatch: false
`

const countGrok = content => (content.match(/id: grok-server/g) ?? []).length

describe('install-profile grok block repair', () => {
  it('upgrades a single old-format block to the current one', async () => {
    const { dir, patchPath } = await withPatch(
      `# user row\n- id: connection\n  config:\n    trustedConfig: true\n\n${OLD_BLOCK}`,
    )
    await runInstaller(dir)
    const out = await readFile(patchPath, 'utf8')
    expect(countGrok(out)).toBe(1)
    expect(out).toContain("XDG_RUNTIME_DIR || '/tmp'")
    expect(out).toContain('id: connection') // user rows preserved
  })

  it('deduplicates a current block plus a stale leftover block', async () => {
    // The 0.2.6 bug left the current block followed by the old block's tail
    // (comment line + full old insert) — exactly the reported failure.
    const { dir, patchPath } = await withPatch(
      `# user row\n- insert:\n    - id: chat-width\n      name: '@x/chat-width'\n\n${NEW_BLOCK}# agent per session, so interleaved session logs are structurally impossible.\n- insert:\n    - id: grok-server\n      name: dsh-grok-tui\n      config:\n        provider: deepseek-official\n        model: !!js process.env.DSH_GROK_MODEL ?? 'deepseek-v4-pro'\n        effort: !!js process.env.DSH_GROK_EFFORT ?? 'max'\n        lastModelFile: !!js dshHomePath('grok-last-model')\n        persistenceRoot: !!js dshHomePath('sessions')\n        storageRoot: !!js dshHomePath('storages')\n        userInteractionProvider: false\n`,
    )
    await runInstaller(dir)
    const out = await readFile(patchPath, 'utf8')
    expect(countGrok(out)).toBe(1)
    expect(out).toContain("XDG_RUNTIME_DIR || '/tmp'")
    expect(out).toContain('chat-width') // user rows preserved
    // No empty `- insert:` shells remain.
    const lines = out.split('\n')
    const shells = lines.filter(
      (line, i) =>
        /^\s*- insert:\s*$/.test(line) && !/^\s+\S/.test(lines[i + 1] ?? ''),
    )
    expect(shells).toEqual([])
  })

  it('removes empty insert shells left by the partial removal', async () => {
    const { dir, patchPath } = await withPatch(
      `# user row\n- id: connection\n  config:\n    trustedConfig: true\n\n# grok TUI bridge (added by dsh-grok-tui install.sh)\n- insert:\n\n${NEW_BLOCK}`,
    )
    await runInstaller(dir)
    const out = await readFile(patchPath, 'utf8')
    expect(countGrok(out)).toBe(1)
    // Every `- insert:` must be followed by indented entries (no empty shell).
    const lines = out.split('\n')
    const shells = lines.filter(
      (line, i) =>
        /^\s*- insert:\s*$/.test(line) && !/^\s+\S/.test(lines[i + 1] ?? ''),
    )
    expect(shells).toEqual([])
  })

  it('is idempotent on a clean current block', async () => {
    const { dir, patchPath } = await withPatch(
      `# user row\n- id: connection\n  config:\n    trustedConfig: true\n\n${NEW_BLOCK}`,
    )
    await runInstaller(dir)
    const first = await readFile(patchPath, 'utf8')
    await runInstaller(dir)
    const second = await readFile(patchPath, 'utf8')
    expect(second).toBe(first)
    expect(countGrok(second)).toBe(1)
  })
})

afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})
