/**
 * 真实 provider 目录下的模型目录验证（不启动任何 Web 服务）:
 * 挂载与官方 host 相同的 provider 组合（llm + settings + llm-deepseek +
 * llm-pi-ai，读取真实 ~/.dsh/settings.yaml），再挂 grok-server 插件，用
 * leader 客户端 initialize 取回 modelState，断言跨 provider 重名模型
 * （deepseek-v4-flash/deepseek-v4-pro/glm-5.1/glm-5.2）每个 provider 的
 * 拷贝都可见且 id/name 可区分。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, } from 'node:net'
import {
  type Agent as AcpAgent,
  ClientSideConnection,
  PROTOCOL_VERSION,
  type Stream,
} from '@agentclientprotocol/sdk'
import { Context } from 'cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as GrokServer from '../src/index.ts'

const dir = await mkdtemp(join(tmpdir(), 'grok-model-verify-'))
const socketPath = join(dir, 'leader.sock')

const ctx = new Context()
await mountAgentLoopTestDependencies(ctx, { systemPrompt: { persona: '' } })
const plug = async (name: string) => {
  const m = await import(name)
  return m.default ?? m
}
await ctx.plugin(await plug('@deepseek-ai/dsh-settings-local'))
await ctx.plugin(await plug('@deepseek-ai/dsh-llm-deepseek'))
await ctx.plugin(await plug('@deepseek-ai/dsh-llm-pi-ai'))
await ctx.plugin(AgentLoop, { agents: [] })
console.log('providers:', ctx.llm.listProviders().map(p => p.id).join(', '))
await ctx.plugin(GrokServer, {
  socketPath,
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  persistenceRoot: join(dir, 'sessions'),
  userInteractionProvider: false,
})

// leader client — frame listener registered BEFORE any send so early
// frames are queued, never dropped
const pending: Array<(m: unknown) => void> = []
const acpQueue: unknown[] = []
const sock = connect(socketPath)
const chunks: Buffer[] = []
let buffered = 0
sock.on('data', (c: Buffer) => {
  chunks.push(c)
  buffered += c.length
  for (;;) {
    if (buffered < 4) return
    const all = Buffer.concat(chunks)
    const need = 4 + all.readUInt32BE(0)
    if (all.length < need) return
    chunks.length = 0
    buffered = 0
    if (all.length > need) {
      chunks.push(all.subarray(need))
      buffered = all.length - need
    }
    const msg = JSON.parse(all.subarray(4, need).toString()) as Record<string, unknown>
    if (msg.type === 'acp') {
      const parsed = JSON.parse(String(msg.payload))
      const waiter = pending.shift()
      if (waiter) waiter(parsed)
      else acpQueue.push(parsed)
    }
  }
})
await new Promise<void>((resolve, reject) => {
  sock.once('connect', resolve)
  sock.once('error', reject)
})
const send = (m: Record<string, unknown>) => {
  const d = Buffer.from(JSON.stringify(m))
  const h = Buffer.alloc(4)
  h.writeUInt32BE(d.length, 0)
  sock.write(Buffer.concat([h, d]))
}
send({ type: 'register', client_type: 'verify-models', mode: 'stdio', capabilities: {} })
const nextAcp = (): Promise<unknown> => {
  const queued = acpQueue.shift()
  return queued !== undefined
    ? Promise.resolve(queued)
    : new Promise(resolve => pending.push(resolve))
}
let controller: ReadableStreamDefaultController<never> | undefined
const stream: Stream = {
  readable: new ReadableStream({ start(inner) { controller = inner } }),
  writable: new WritableStream({ write: (m: never) => send({ type: 'acp', payload: JSON.stringify(m) }) }),
}
const client = new ClientSideConnection(
  (_a: AcpAgent) => ({
    sessionUpdate: async () => {},
    extNotification: async () => {},
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }),
  stream,
)
void (async () => {
  for (;;) {
    const frame = await nextAcp()
    controller?.enqueue(frame as never)
  }
})()

const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION })
const state = init._meta?.modelState as {
  currentModelId?: string
  availableModels?: Array<{ modelId?: string; name?: string; description?: string }>
} | undefined
console.log('currentModelId:', state?.currentModelId)
const rows = state?.availableModels ?? []
const byId = (needle: string) => rows.filter(r => r.modelId?.includes(needle))
const dup = byId('deepseek-v4-flash')
console.log('deepseek-v4-flash rows:', JSON.stringify(dup))
const dupPro = byId('deepseek-v4-pro')
console.log('deepseek-v4-pro rows:', JSON.stringify(dupPro))
const glm = byId('glm-5.1')
console.log('glm-5.1 rows:', JSON.stringify(glm))
const allIds = rows.map(r => r.modelId)
const uniqueIds = new Set(allIds)
console.log(`total rows: ${rows.length}, unique ids: ${uniqueIds.size}`)
const ok =
  dup.length === 2 &&
  new Set(dup.map(r => r.modelId)).size === 2 &&
  dupPro.length === 2 &&
  new Set(dupPro.map(r => r.modelId)).size === 2 &&
  glm.length === 2 &&
  allIds.length === uniqueIds.size &&
  state?.currentModelId === 'deepseek-official@deepseek-v4-pro'
console.log(ok ? '\nMODEL CATALOG VERIFY PASS' : '\nMODEL CATALOG VERIFY FAIL')
await ctx.fiber.dispose()
process.exit(ok ? 0 : 1)
