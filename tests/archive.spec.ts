/**
 * Unit tests for the archive-set reader: the workspace storage unit shared
 * with the DSH Web UI.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from '@rstest/core'
import { readArchivedSessionIds } from '../src/archive.ts'

let dir: string | undefined

afterEach(async () => {
  await rm(dir ?? '', { recursive: true, force: true }).catch(() => {})
  dir = undefined
})

async function storagesRoot(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'grok-archive-'))
  return dir
}

describe('readArchivedSessionIds', () => {
  it('returns an empty set when the web never wrote the unit', async () => {
    const root = await storagesRoot()
    expect([...(await readArchivedSessionIds(root))]).toEqual([])
  })

  it('parses the registry-global archive set', async () => {
    const root = await storagesRoot()
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        unit: { name: 'workspace', version: 2 },
        global: {
          initialized: true,
          workspaceIds: [],
          archivedSessionIds: ['session-a', 'session-b'],
        },
        tables: {},
      }),
    )
    const archived = await readArchivedSessionIds(root)
    expect(archived.has('session-a')).toBe(true)
    expect(archived.has('session-b')).toBe(true)
    expect(archived.has('session-c')).toBe(false)
  })

  it('fails loud on a malformed unit', async () => {
    const root = await storagesRoot()
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'workspace.json'), '{not json')
    await expect(readArchivedSessionIds(root)).rejects.toThrow()
  })
})
