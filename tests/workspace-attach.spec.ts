/**
 * Workspace-registry attach tests: the shared-unit read-merge-write against
 * fixture workspace.json files, the store sync (plan + apply), and the
 * end-to-end behavior through the real harness — a session is accounted on
 * its FIRST EVENT (never at session/new, so zero-event sessions cannot book
 * ghost accounts), and a started conversation lands in its web workspace.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from '@rstest/core'
import { projectKey } from '../src/first-prompt.ts'
import {
  attachSessionToWorkspace,
  attachSessionViaWebHost,
  planWorkspaceSync,
  syncWorkspaceAccounts,
} from '../src/workspace-attach.ts'
import {
  AcpTestClient,
  type GrokHarness,
  makeGrokHarness,
  recordingClient,
  textResponse,
} from './helpers.ts'

/** A dead port: any attach attempt through it fails fast and falls back. */
const DEAD_WEB_PORT = 1

/** One request the fake web host gateway recorded. */
interface FakeWebRequest {
  method: string
  payload: Record<string, unknown>
}

/** A minimal fake of the web host's /api gateway (workspace.create + session.create). */
async function fakeWebHost(options?: { failSessionCreate?: boolean }): Promise<{
  requests: FakeWebRequest[]
  port: number
  close: () => Promise<void>
}> {
  const requests: FakeWebRequest[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        rpcId: string
        method: string
        payload: Record<string, unknown>
      }
      requests.push({ method: body.method, payload: body.payload })
      let value: unknown
      if (body.method === 'workspace.create') {
        value = {
          workspace: {
            workspaceId: 'ws-fake',
            path: String(body.payload.path),
            title: 'fake',
            sessionIds: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          created: false,
        }
      } else if (body.method === 'session.create') {
        if (options?.failSessionCreate) {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              type: 'server-response',
              rpcId: body.rpcId,
              result: {
                ok: false,
                error: { code: 'workspace-attach-failed', message: 'boom' },
              },
            }),
          )
          return
        }
        value = { sessionId: body.payload.sessionId }
      } else {
        res.writeHead(404)
        res.end()
        return
      }
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          type: 'server-response',
          rpcId: body.rpcId,
          result: { ok: true, value },
        }),
      )
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const close = (): Promise<void> =>
    new Promise(resolve => server.close(() => resolve()))
  cleanups.push(() => close().catch(() => {}))
  return { requests, port, close }
}

/** Build a fixture unit document in the web storage-json shape. */
function unitDocument(
  workspaces: Array<{ id: string; path: string; sessionIds?: string[] }>,
): Record<string, unknown> {
  const table: Record<string, unknown> = {}
  for (const workspace of workspaces) {
    table[workspace.id] = {
      path: workspace.path,
      title: workspace.path.split('/').pop(),
      sessionIds: workspace.sessionIds ?? [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
  }
  return {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: workspaces.map(workspace => workspace.id),
      archivedSessionIds: ['archived-1'],
    },
    tables: { workspaces: table },
  }
}

/** A persisted-session fixture: one zstd log with a header line. */
function sessionLog(
  sessionId: string,
  cwd: string | undefined,
  createdAt = 1786000000000,
): Buffer {
  const header = {
    type: 'session',
    version: 1,
    id: sessionId,
    createdAt,
    ...(cwd === undefined ? {} : { cwd }),
    delegationDepth: 0,
  }
  return zstdCompressSync(`${JSON.stringify(header)}\n`)
}

/** Write a persisted session fixture under a sessions root. */
async function writeSession(
  sessionsRoot: string,
  sessionId: string,
  cwd: string | undefined,
): Promise<void> {
  const dir = join(
    sessionsRoot,
    cwd === undefined ? '_no-cwd' : projectKey(cwd),
    sessionId,
  )
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.jsonl.zstd'), sessionLog(sessionId, cwd))
}

/** Wait until `fn` succeeds or the deadline passes. */
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error('poll timeout')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

const cleanups: Array<() => Promise<void>> = []
let socketPath = ''
let dispose: (() => Promise<void>) | undefined
let harness: GrokHarness | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  harness = undefined
  await rm(socketPath, { force: true }).catch(() => {})
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'grok-attach-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

describe('attachSessionToWorkspace', () => {
  it('accounts a session to the workspace owning its cwd', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([
      { id: 'ws-1', path: root },
      { id: 'ws-2', path: '/elsewhere', sessionIds: ['other-session'] },
    ])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).resolves.toBe('attached')

    const written = JSON.parse(
      await readFile(join(storages, 'workspace.json'), 'utf8'),
    ) as {
      unit: { version: number }
      global: { archivedSessionIds: string[]; workspaceIds: string[] }
      tables: {
        workspaces: Record<string, { sessionIds: string[]; updatedAt: string }>
      }
    }
    // Prepended (newest first), sibling workspace and archive set untouched.
    expect(written.tables.workspaces['ws-1']?.sessionIds).toEqual([
      'new-session',
    ])
    expect(written.tables.workspaces['ws-2']?.sessionIds).toEqual([
      'other-session',
    ])
    expect(written.global.archivedSessionIds).toEqual(['archived-1'])
    expect(written.global.workspaceIds).toEqual(['ws-1', 'ws-2'])
    expect(written.unit.version).toBe(2)
    expect(written.tables.workspaces['ws-1']?.updatedAt).not.toBe(
      '2026-01-01T00:00:00.000Z',
    )
  })

  it('registers a new workspace when none owns the cwd', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: '/elsewhere' }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).resolves.toBe('registered')

    const written = JSON.parse(
      await readFile(join(storages, 'workspace.json'), 'utf8'),
    ) as {
      global: { workspaceIds: string[]; archivedSessionIds: string[] }
      tables: {
        workspaces: Record<
          string,
          { path: string; title: string; sessionIds: string[] }
        >
      }
    }
    const newId = written.global.workspaceIds[0]
    expect(newId).toBeTruthy()
    // New workspace is prepended to the registry order; the old one survives.
    expect(written.global.workspaceIds).toEqual([newId, 'ws-1'])
    expect(written.global.archivedSessionIds).toEqual(['archived-1'])
    expect(written.tables.workspaces[newId as string]).toMatchObject({
      path: root,
      title: root.split('/').pop(),
      sessionIds: ['new-session'],
    })
    expect(written.tables.workspaces['ws-1']?.sessionIds).toEqual([])
  })

  it('creates the unit file when the web never wrote one', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)

    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).resolves.toBe('registered')

    const written = JSON.parse(
      await readFile(join(storages, 'workspace.json'), 'utf8'),
    ) as {
      unit: { name: string; version: number }
      global: { initialized: boolean; workspaceIds: string[] }
      tables: {
        workspaces: Record<
          string,
          { path: string; title: string; sessionIds: string[] }
        >
      }
    }
    expect(written.unit).toEqual({ name: 'workspace', version: 2 })
    expect(written.global.initialized).toBe(true)
    const newId = written.global.workspaceIds[0]
    expect(written.tables.workspaces[newId as string]).toMatchObject({
      path: root,
      sessionIds: ['new-session'],
    })
  })

  it('is idempotent and leaves the file untouched for an accounted session', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([
      { id: 'ws-1', path: root, sessionIds: ['new-session'] },
    ])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).resolves.toBe('already-attached')

    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(unit))
  })

  it('never double-books a session accounted by another workspace', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([
      { id: 'ws-1', path: root },
      { id: 'ws-2', path: '/elsewhere', sessionIds: ['new-session'] },
    ])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).resolves.toBe('already-attached')

    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(unit))
  })

  it('leaves a session ungrouped when its cwd does not resolve', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root }])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', join(root, 'nope')),
    ).resolves.toBe('cwd-unresolved')
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(unit))
  })

  it('canonicalizes the cwd through symlinks before matching', async () => {
    const root = await tempDir()
    const real = join(root, 'real')
    await mkdir(real)
    const link = join(root, 'link')
    await symlink(real, link)
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: real }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', link),
    ).resolves.toBe('attached')
  })

  it('registers through a symlinked cwd under the canonical path', async () => {
    const root = await tempDir()
    const real = join(root, 'real')
    await mkdir(real)
    const link = join(root, 'link')
    await symlink(real, link)
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: '/elsewhere' }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    await expect(
      attachSessionToWorkspace(storages, 'new-session', link),
    ).resolves.toBe('registered')

    const written = JSON.parse(
      await readFile(join(storages, 'workspace.json'), 'utf8'),
    ) as {
      tables: { workspaces: Record<string, { path: string }> }
    }
    expect(
      Object.values(written.tables.workspaces).map(ws => ws.path),
    ).toContain(real)
  })

  it('rejects a malformed or version-mismatched unit loud', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const path = join(storages, 'workspace.json')

    await writeFile(path, 'not json')
    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).rejects.toThrow()

    await writeFile(
      path,
      JSON.stringify({
        unit: { name: 'workspace', version: 3 },
        global: null,
        tables: {},
      }),
    )
    await expect(
      attachSessionToWorkspace(storages, 'new-session', root),
    ).rejects.toThrow(/version 3 != expected 2/)
  })
})

describe('workspace sync', () => {
  it('plans attach/register/skip from the persisted store', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    const sessions = join(root, 'sessions')
    await mkdir(storages)
    const owned = join(root, 'owned')
    const fresh = join(root, 'fresh')
    await mkdir(owned)
    await mkdir(fresh)
    const unit = unitDocument([
      { id: 'ws-1', path: owned },
      { id: 'ws-2', path: '/elsewhere' },
    ])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))
    await writeSession(sessions, 'attach-me', owned)
    await writeSession(sessions, 'fresh-1', fresh)
    await writeSession(sessions, 'fresh-2', fresh)
    await writeSession(sessions, 'gone-dir', join(root, 'nope'))
    await writeSession(sessions, 'already-in', owned, 1786000000000)
    // Pre-account 'already-in' through the unit fixture.
    const unitWithAccount = unitDocument([
      { id: 'ws-1', path: owned, sessionIds: ['already-in'] },
      { id: 'ws-2', path: '/elsewhere' },
    ])
    await writeFile(
      join(storages, 'workspace.json'),
      JSON.stringify(unitWithAccount),
    )

    const plan = await planWorkspaceSync(storages, sessions)
    expect(plan.attach.map(c => c.sessionId)).toEqual(['attach-me'])
    expect(plan.register.map(c => c.sessionId).sort()).toEqual([
      'fresh-1',
      'fresh-2',
    ])
    expect(plan.skip.map(c => c.sessionId)).toEqual(['gone-dir'])
  })

  it('applies one write: attaches and registers without double-booking', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    const sessions = join(root, 'sessions')
    await mkdir(storages)
    const owned = join(root, 'owned')
    const fresh = join(root, 'fresh')
    await mkdir(owned)
    await mkdir(fresh)
    const unit = unitDocument([
      { id: 'ws-1', path: owned, sessionIds: ['already-in'] },
      { id: 'ws-2', path: '/elsewhere' },
    ])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))
    await writeSession(sessions, 'attach-me', owned)
    await writeSession(sessions, 'fresh-1', fresh)
    await writeSession(sessions, 'fresh-2', fresh)
    await writeSession(sessions, 'already-in', owned)
    await writeSession(sessions, 'gone-dir', join(root, 'nope'))

    const result = await syncWorkspaceAccounts(storages, sessions)
    expect(result).toEqual({ attached: 1, registered: 2, skipped: 1 })

    const written = JSON.parse(
      await readFile(join(storages, 'workspace.json'), 'utf8'),
    ) as {
      global: { workspaceIds: string[] }
      tables: {
        workspaces: Record<string, { path: string; sessionIds: string[] }>
      }
    }
    const ws1 = Object.values(written.tables.workspaces).find(
      ws => ws.path === owned,
    )
    expect(ws1?.sessionIds).toContain('attach-me')
    expect(ws1?.sessionIds).toContain('already-in')
    expect(ws1?.sessionIds).toHaveLength(2)
    // One new workspace owns both fresh sessions; the dead dir is untouched.
    const freshWs = Object.values(written.tables.workspaces).find(
      ws => ws.path === fresh,
    )
    expect(freshWs?.sessionIds.sort()).toEqual(['fresh-1', 'fresh-2'])
    expect(written.global.workspaceIds[0]).toBe(
      Object.keys(written.tables.workspaces).find(
        id => written.tables.workspaces[id]?.path === fresh,
      ),
    )
  })

  it('is a read-only no-op when every session is accounted', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    const sessions = join(root, 'sessions')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root, sessionIds: ['s1'] }])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))
    await writeSession(sessions, 's1', root)

    const result = await syncWorkspaceAccounts(storages, sessions)
    expect(result).toEqual({ attached: 0, registered: 0, skipped: 0 })
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(unit))
  })
})

describe('grok server session accounting', () => {
  it('accounts a conversation to its web workspace on the first event', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    socketPath = join(root, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
      storageRoot: storages,
      // Dead port: no web host reachable, so the direct unit write runs.
      webPort: DEAD_WEB_PORT,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )

    const created = await client.client.newSession({
      cwd: root,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    client.transport.close()

    await pollUntil(async () => {
      const written = JSON.parse(
        await readFile(join(storages, 'workspace.json'), 'utf8'),
      ) as {
        tables: { workspaces: Record<string, { sessionIds: string[] }> }
      }
      return written.tables.workspaces['ws-1']?.sessionIds.includes(
        created.sessionId,
      )
    })
  })

  it('never books a zero-event session (no ghost accounts)', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root }])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))

    socketPath = join(root, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [],
      storageRoot: storages,
      webPort: DEAD_WEB_PORT,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )

    await client.client.newSession({
      cwd: root,
      mcpServers: [],
    })
    // No prompt: the pager's idle startup session must not pollute the
    // registry (persistence is lazy — such a session has no log at all).
    await new Promise(resolve => setTimeout(resolve, 300))
    client.transport.close()

    const written = JSON.parse(await readFile(path, 'utf8')) as {
      tables: { workspaces: Record<string, { sessionIds: string[] }> }
    }
    expect(written.tables.workspaces['ws-1']?.sessionIds).toEqual([])
  })

  it('registers a workspace for a directory with no matching workspace', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: '/elsewhere' }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))

    socketPath = join(root, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
      storageRoot: storages,
      webPort: DEAD_WEB_PORT,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )

    const created = await client.client.newSession({
      cwd: root,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    client.transport.close()

    await pollUntil(async () => {
      const written = JSON.parse(
        await readFile(join(storages, 'workspace.json'), 'utf8'),
      ) as {
        tables: {
          workspaces: Record<string, { path: string; sessionIds: string[] }>
        }
      }
      return Object.values(written.tables.workspaces).some(
        ws => ws.path === root && ws.sessionIds.includes(created.sessionId),
      )
    })
  })

  it('attaches through the running web host API when one is reachable', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root }])
    const path = join(storages, 'workspace.json')
    await writeFile(path, JSON.stringify(unit))
    const fake = await fakeWebHost()

    socketPath = join(root, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
      storageRoot: storages,
      webPort: fake.port,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )

    const created = await client.client.newSession({
      cwd: root,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    client.transport.close()

    await pollUntil(async () => {
      return fake.requests.some(req => req.method === 'session.create')
    })
    const methods = fake.requests.map(req => req.method)
    expect(methods).toEqual(['workspace.create', 'session.create'])
    expect(fake.requests[0]?.payload).toEqual({ path: root })
    expect(fake.requests[1]?.payload).toMatchObject({
      sessionId: created.sessionId,
      workspaceId: 'ws-fake',
    })
    // The host owns the attach; the unit file stays untouched by grok.
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(unit))
  })

  it('falls back to the shared unit when the web host attach fails', async () => {
    const root = await tempDir()
    const storages = join(root, 'storages')
    await mkdir(storages)
    const unit = unitDocument([{ id: 'ws-1', path: root }])
    await writeFile(join(storages, 'workspace.json'), JSON.stringify(unit))
    const fake = await fakeWebHost({ failSessionCreate: true })

    socketPath = join(root, 'leader.sock')
    harness = await makeGrokHarness({
      socketPath,
      script: [textResponse('ok')],
      storageRoot: storages,
      webPort: fake.port,
    })
    dispose = harness.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness),
    )

    const created = await client.client.newSession({
      cwd: root,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    client.transport.close()

    await pollUntil(async () => {
      const written = JSON.parse(
        await readFile(join(storages, 'workspace.json'), 'utf8'),
      ) as {
        tables: { workspaces: Record<string, { sessionIds: string[] }> }
      }
      return written.tables.workspaces['ws-1']?.sessionIds.includes(
        created.sessionId,
      )
    })
  })
})

describe('attachSessionViaWebHost', () => {
  it('resolves the workspace and attaches through the host RPCs', async () => {
    const fake = await fakeWebHost()

    await expect(
      attachSessionViaWebHost(
        { origin: `http://127.0.0.1:${fake.port}` },
        'session-1',
        '/work/dir',
      ),
    ).resolves.toBe(true)

    expect(fake.requests.map(req => req.method)).toEqual([
      'workspace.create',
      'session.create',
    ])
    expect(fake.requests[0]?.payload).toEqual({ path: '/work/dir' })
    expect(fake.requests[1]?.payload).toEqual({
      sessionId: 'session-1',
      workspaceId: 'ws-fake',
    })
  })

  it('rejects when the host reports an RPC failure', async () => {
    const fake = await fakeWebHost({ failSessionCreate: true })

    await expect(
      attachSessionViaWebHost(
        { origin: `http://127.0.0.1:${fake.port}` },
        'session-1',
        '/work/dir',
      ),
    ).rejects.toThrow(/session\.create failed: boom/)
  })

  it('rejects fast when no web host is listening', async () => {
    await expect(
      attachSessionViaWebHost(
        { origin: `http://127.0.0.1:${DEAD_WEB_PORT}` },
        'session-1',
        '/work/dir',
      ),
    ).rejects.toThrow()
  })
})
