/** Stage-timing probe: connect, initialize, session/new, first prompt. */
import { connect } from 'node:net'

const SOCKET = process.env.GROK_LEADER_SOCKET ?? '/tmp/dsh-grok.sock'
const t0 = Date.now()
const sock = connect(SOCKET)
let buf = Buffer.alloc(0)
let nextId = 1
const pending = new Map<number, (msg: unknown) => void>()
sock.on('data', (d: Buffer) => {
  buf = Buffer.concat([buf, d])
  while (buf.length >= 4) {
    const len = buf.readUInt32BE(0)
    if (buf.length < 4 + len) return
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString())
    buf = buf.subarray(4 + len)
    if (msg.type === 'acp') {
      const rpc = JSON.parse(msg.payload)
      if (rpc.id !== undefined) pending.get(rpc.id)?.(rpc)
    }
  }
})
function send(obj: unknown) {
  const data = Buffer.from(JSON.stringify(obj))
  const h = Buffer.alloc(4)
  h.writeUInt32BE(data.length)
  sock.write(Buffer.concat([h, data]))
}
function rpc(method: string, params: unknown): Promise<unknown> {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    send({
      type: 'acp',
      payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
  })
}
const stage = (name: string, t: number) => console.log(`${name}: ${t} ms`)

await new Promise<void>(r => sock.once('connect', () => r()))
const t1 = Date.now()
send({ type: 'register', client_type: 'probe', mode: 'stdio' })
await new Promise<void>(r => sock.once('data', () => r()))
const t2 = Date.now()
stage('connect+register', t2 - t1)
await rpc('initialize', { protocolVersion: 1 })
const t3 = Date.now()
stage('initialize', t3 - t2)
const created = (await rpc('session/new', {
  cwd: process.cwd(),
  mcpServers: [],
})) as { result?: { sessionId: string } }
const t4 = Date.now()
stage('session/new', t4 - t3)
const sessionId = created.result?.sessionId
const t5 = Date.now()
await rpc('session/prompt', {
  sessionId,
  prompt: [{ type: 'text', text: 'Reply with OK only.' }],
})
const t6 = Date.now()
stage('first prompt (LLM round-trip)', t6 - t5)
process.exit(0)
