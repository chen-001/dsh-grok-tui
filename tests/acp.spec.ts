/**
 * ACP mapping tests: initialize/auth surface, session lifecycle, prompt
 * settlement through the REAL agent loop (scripted mock provider), in-flight
 * slot enforcement, and cancellation.
 */

import { appendFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import {
  PROTOCOL_VERSION,
  type SessionNotification,
} from '@agentclientprotocol/sdk'
import { afterEach, describe, expect, it } from '@rstest/core'
import { scanZstdFrames, sessionLogPath } from '../src/first-prompt.ts'
import {
  AcpTestClient,
  errorResponse,
  type GrokHarness,
  makeGrokHarness,
  recordingClient,
  textResponse,
} from './helpers.ts'

const zstdCompressAsync = promisify(zstdCompress)
const zstdDecompressAsync = promisify(zstdDecompress)
const checksum = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/** Wait until `probe` returns truthy, polling every 25ms. */
async function pollUntil(probe: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await probe()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('pollUntil: condition not met within 5s')
}

/** Event seqs in log order (expands packed chunk rows). */
function seqsOf(text: string): number[] {
  const seqs: number[] = []
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line) as {
      seq?: unknown
      seq0?: unknown
      data?: { texts?: unknown[] }
    }
    if (typeof record.seq === 'number') {
      seqs.push(record.seq)
    } else if (
      typeof record.seq0 === 'number' &&
      Array.isArray(record.data?.texts)
    ) {
      for (let k = 0; k < record.data.texts.length; k++)
        seqs.push(record.seq0 + k)
    }
  }
  return seqs
}

/** Decompress a concatenated-frame artifact into its full plaintext. */
async function decodeArtifact(path: string): Promise<string> {
  const buf = await readFile(path)
  const frames = scanZstdFrames(buf, 1_000_000)
  const parts: Buffer[] = []
  for (const frame of frames) {
    parts.push(await zstdDecompressAsync(buf.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

let socketPath = ''
let dispose: (() => Promise<void>) | undefined
let harness: GrokHarness | undefined

afterEach(async () => {
  await dispose?.()
  dispose = undefined
  harness = undefined
  await rm(socketPath, { force: true }).catch(() => {})
})

async function connectClient(): Promise<AcpTestClient> {
  harness = await makeGrokHarness({ socketPath, script: [] })
  dispose = harness.dispose
  return AcpTestClient.connect(socketPath, recordingClient(harness))
}

/** Collect the committed text from agent_message_chunk updates. */
function committedText(updates: SessionNotification['update'][]): string {
  return updates
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => {
      const content = (update as { content?: { type?: string; text?: string } })
        .content
      return content?.type === 'text' ? (content.text ?? '') : ''
    })
    .join('')
}

describe('grok ACP surface', () => {
  it('advertises the api_key auth method and a model state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    const response = await client.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
    })
    expect(response.authMethods.map(method => method.id)).toContain(
      'xai.api_key',
    )
    expect(response.agentInfo.name).toBe('dsh-grok-tui')
    const meta = response._meta as {
      modelState?: { currentModelId: string; availableModels: unknown[] }
    }
    expect(meta.modelState?.currentModelId).toBe('mock')
    expect(meta.modelState?.availableModels.length).toBe(1)
    client.transport.close()
  })

  it('accepts authenticate as a no-op', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    await client.client.initialize({ protocolVersion: PROTOCOL_VERSION })
    await expect(
      client.client.authenticate({ methodId: 'xai.api_key' }),
    ).resolves.toBeDefined()
    client.transport.close()
  })

  it('creates a session and honors a client-supplied session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    const created = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
      _meta: { sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
    })
    expect(created.sessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    client.transport.close()
  })

  it('rejects a relative cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    await expect(
      client.client.newSession({ cwd: 'relative/path', mcpServers: [] }),
    ).rejects.toThrow(/cwd must be an absolute path/)
    client.transport.close()
  })

  it('ignores client-supplied mcpServers instead of spawning them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    const created = await client.client.newSession({
      cwd: dir,
      mcpServers: [
        {
          name: 'evil-server',
          command: 'npx',
          args: ['-y', 'never-run'],
          env: [],
        },
      ],
    })
    expect(created.sessionId).toBeTruthy()
    client.transport.close()
  })

  it('streams the committed answer and settles with end_turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({
      socketPath,
      script: [textResponse('Hello from DSH!')],
    })
    harness = harness2
    dispose = harness2.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    const result = await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    expect(result.stopReason).toBe('end_turn')
    expect(committedText(harness2.updates)).toBe('Hello from DSH!')
    client.transport.close()
  })

  it('re-aligns before writing when another frontend appends to the shared log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-align-'))
    const sessions = join(dir, 'sessions')
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({
      socketPath,
      script: [textResponse('first'), textResponse('second')],
    })
    harness = harness2
    dispose = harness2.dispose
    // JSONL persistence so the shared log materializes (m4-style mount).
    const { default: SessionPersistenceJsonl } = await import(
      '@deepseek-ai/dsh-session-persistence-jsonl',
    )
    await harness2.ctx.plugin(SessionPersistenceJsonl, {
      root: sessions,
      compression: 'zstd',
    })
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const created = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    const sessionId = created.sessionId
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'hi' }],
    })
    // Wait for grok's own flush to settle before simulating the other
    // frontend's write: the artifact must be stable under the append.
    const artifact = sessionLogPath(sessions, dir, sessionId)
    // The JSONL coordinator drains asynchronously after the turn; poll until
    // the artifact exists AND its size is stable (grok's own flush settled).
    await pollUntil(async () => {
      let first = 0
      try {
        first = (await stat(artifact)).size
      } catch {
        return false // not materialized yet
      }
      await new Promise(resolve => setTimeout(resolve, 50))
      try {
        const second = (await stat(artifact)).size
        return first > 0 && first === second
      } catch {
        return false
      }
    })
    // The DSH Web UI's agent holds an independent seq counter; its next turn
    // starts at the durable log's current length.
    const seqs = seqsOf(await decodeArtifact(artifact))
    const next = Math.max(...seqs) + 1
    const externalTurn = [
      { type: 'turn/start', seq: next, time: 9, data: { turn: 2 } },
      {
        type: 'turn/end',
        seq: next + 1,
        time: 10,
        data: { turn: 2, reason: { kind: 'completed' } },
      },
    ]
    await appendFile(
      artifact,
      await zstdCompressAsync(
        Buffer.from(
          `${externalTurn.map(e => JSON.stringify(e)).join('\n')}\n`,
          'utf8',
        ),
        checksum,
      ),
    )

    // The next grok prompt detects the external write and re-resumes from
    // disk before appending: the final log is contiguous and contains the
    // external turn between grok's two turns.
    await client.client.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: 'text', text: 'again' }],
    })
    client.transport.close()

    const finalSeqs = seqsOf(await decodeArtifact(artifact))
    for (let i = 0; i < finalSeqs.length; i++) expect(finalSeqs[i]).toBe(i)
    expect(finalSeqs).toContain(next)
    expect(finalSeqs).toContain(next + 1)
    expect(finalSeqs.length).toBeGreaterThan(next + 1)
  })

  it('stamps context pressure and dsh usage meta on live updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({
      socketPath,
      script: [textResponse('Hello!')],
    })
    harness = harness2
    dispose = harness2.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    })
    // The usage chunk renders nothing itself, so the server pushes a standard
    // usage_update notification the moment the view changes; its `_meta`
    // carries the fresh totals so both bars refresh immediately.
    await new Promise(resolve => setTimeout(resolve, 150))
    const updates = harness2.notifications.filter(
      notification => notification.update.sessionUpdate === 'usage_update',
    )
    expect(updates.length).toBeGreaterThan(0)
    // The first usage_update (step/start) may predate any provider usage, so
    // only the ones carrying totalTokens must show the full accounting.
    const stamped = updates.filter(
      notification => notification._meta?.totalTokens !== undefined,
    )
    expect(stamped.length).toBeGreaterThan(0)
    for (const notification of stamped) {
      expect(notification._meta?.totalTokens).toBe(5)
      const usage = notification._meta?.dshUsage as
        | {
          inputTokens: number
          outputTokens: number
          apiCalls: number
          toolDurationMs: number
        }
        | undefined
      expect(usage?.inputTokens).toBe(5)
      expect(usage?.outputTokens).toBe(6)
      expect(usage?.apiCalls).toBe(1)
      expect(usage?.toolDurationMs).toBe(0)
    }
    // Regular updates carry the same meta once usage exists.
    const allStamped = harness2.notifications.filter(
      notification => notification._meta?.totalTokens !== undefined,
    )
    expect(allStamped.length).toBeGreaterThanOrEqual(stamped.length)
    client.transport.close()
  })

  it('rejects a second prompt while one is in flight', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({ socketPath, script: ['hang'] })
    harness = harness2
    dispose = harness2.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    const first = client.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'one' }],
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    await expect(
      client.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'two' }],
      }),
    ).rejects.toThrow(/already in flight/)
    await client.client.cancel({ sessionId })
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    client.transport.close()
  })

  it('rejects content beyond the baseline prompt surface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const client = await connectClient()

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await expect(
      client.client.prompt({
        sessionId,
        prompt: [
          { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        ],
      }),
    ).rejects.toThrow(/only text and resource_link/)
    client.transport.close()
  })

  it('settles a failed turn with an error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-acp-'))
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({
      socketPath,
      script: [errorResponse('boom')],
    })
    harness = harness2
    dispose = harness2.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    await expect(
      client.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'hi' }],
      }),
    ).rejects.toThrow(/turn failed: boom/)
    client.transport.close()
  })

  it('pushes session titles onto the wire on both channels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grok-title-'))
    socketPath = join(dir, 'leader.sock')
    const harness2 = await makeGrokHarness({
      socketPath,
      script: [textResponse('Hello!')],
    })
    harness = harness2
    dispose = harness2.dispose
    const client = await AcpTestClient.connect(
      socketPath,
      recordingClient(harness2),
    )

    const { sessionId } = await client.client.newSession({
      cwd: dir,
      mcpServers: [],
    })
    // The host's session-title service appends `session/title` events
    // (fallback first, then the LLM provider title, then any user rename);
    // drive one through the live session to exercise the wire path.
    // `session/title` is a plugin-merged event type (dsh-session-title),
    // so the SessionEventMap does not carry it — append structurally.
    const session = harness2.ctx.sessions.get(sessionId)
    expect(session).toBeDefined()
    ;(session as unknown as {
      append(type: string, data: unknown): void
    }).append('session/title', {
      title: 'Fix the flaky test',
      messageSeqs: [1],
      source: { kind: 'fallback' },
    })

    // The session/event feed delivers asynchronously; wait for the wire.
    await pollUntil(() =>
      harness2.notifications.some(
        n => n.update.sessionUpdate === 'session_info_update',
      ),
    )
    // The standard ACP notification carries the title...
    const infoUpdate = harness2.notifications.find(
      n => n.update.sessionUpdate === 'session_info_update',
    )
    expect(infoUpdate?.update).toMatchObject({
      sessionUpdate: 'session_info_update',
      title: 'Fix the flaky test',
    })
    // ...and the grok extension notification the pager actually consumes
    // (SessionSummaryGenerated sets the pager's generated_session_title).
    const ext = harness2.extNotifications.find(
      n => n.method === 'x.ai/session_notification',
    )
    expect(ext?.params).toMatchObject({
      sessionId: String(sessionId),
      update: {
        sessionUpdate: 'session_summary_generated',
        sessionSummary: 'Fix the flaky test',
      },
    })
    client.transport.close()
  })
})
