/**
 * Shared workspace-registry attach.
 *
 * The DSH Web UI groups sessions into workspaces through its workspace
 * registry, persisted as one JSON unit under the storages root
 * (`~/.dsh/storages/workspace.json`). The registry only ever attaches
 * sessions created through the web's own `session.create {workspaceId}`
 * flow; sessions this server creates via `agents.create` never reach it, so
 * they always show under "Ungrouped" in the web sidebar even when their
 * `cwd` matches a registered workspace. This module performs the same
 * attach the web would have done, as a direct read-merge-write of the
 * shared unit file.
 *
 * Mounting the real `dsh-workspace` plugin here instead would NOT be safe:
 * the storage-json backend is single-process in-memory authoritative, so two
 * processes holding the same unit would publish stale snapshots over each
 * other. A plain atomic file replace cannot corrupt the unit — at worst a
 * concurrent web write wins and the attach is lost until the web app
 * reloads the file (the web's own writes republish its memory, so its
 * accounting self-heals; grok's attach is simply not in that memory).
 *
 * A directory with no registered workspace gets one registered on first
 * use — the same act the web's first-bootstrap performs for historical
 * sessions (record path is the canonical cwd, title is its basename, the
 * record is prepended to the registry order). Only a cwd that does not
 * resolve to an existing directory stays ungrouped, exactly as DSH's
 * workspace create would reject it.
 * @module dsh-grok-tui/workspace-attach
 */

import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'
import { scanZstdFrames } from './first-prompt.ts'

const zstdDecompressAsync = promisify(zstdDecompress)

/** Unit file name the workspace domain opens under the storages root. */
const WORKSPACE_UNIT_FILE = 'workspace.json'

/** The unit version the web's workspace domain currently writes. */
const WORKSPACE_UNIT_VERSION = 2

/** Why a session was (or was not) accounted to a workspace. */
export type AttachOutcome =
  /** Prepended to the account of an existing workspace. */
  | 'attached'
  /** A new workspace was registered for the cwd and the session attached. */
  | 'registered'
  /** Already accounted by a workspace; the file was untouched. */
  | 'already-attached'
  /** The cwd does not resolve to an existing directory; nothing to register. */
  | 'cwd-unresolved'

/** One workspace record as stored in the shared unit. */
interface WorkspaceRecord {
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

/** The parsed unit document: `workspaces` aliases the live `tables` object. */
export interface WorkspaceUnit {
  document: Record<string, unknown>
  workspaces: Record<string, WorkspaceRecord>
}

/** The unit document a never-initialized web would write on its first open. */
function freshUnitDocument(): Record<string, unknown> {
  return {
    unit: { name: 'workspace', version: WORKSPACE_UNIT_VERSION },
    global: { initialized: true, workspaceIds: [], archivedSessionIds: [] },
    tables: { workspaces: {} },
  }
}

/**
 * Read and shape-check the shared workspace unit, or `undefined` when the
 * web never wrote it. Malformed content and version mismatches throw loud:
 * writing a foreign shape back could corrupt the web's registry.
 * @param storagesRoot - the harness storages root (`~/.dsh/storages`).
 * @returns the parsed document and its workspaces table.
 */
export async function readWorkspaceUnit(
  storagesRoot: string,
): Promise<WorkspaceUnit | undefined> {
  const unitPath = join(storagesRoot, WORKSPACE_UNIT_FILE)
  let raw: string
  try {
    raw = await readFile(unitPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(
      `workspace storage unit is malformed in ${unitPath}: not a JSON object`,
    )
  }
  const document = parsed as Record<string, unknown>
  const unitHeader =
    typeof document.unit === 'object' && document.unit !== null
      ? (document.unit as Record<string, unknown>)
      : undefined
  if (
    unitHeader === undefined ||
    unitHeader.name !== 'workspace' ||
    typeof unitHeader.version !== 'number'
  ) {
    throw new Error(
      `workspace storage unit is malformed in ${unitPath}: missing or foreign unit header`,
    )
  }
  if (unitHeader.version !== WORKSPACE_UNIT_VERSION) {
    throw new Error(
      `workspace storage unit version ${unitHeader.version} != expected ${WORKSPACE_UNIT_VERSION} in ${unitPath}`,
    )
  }
  const tables =
    typeof document.tables === 'object' && document.tables !== null
      ? (document.tables as Record<string, unknown>)
      : undefined
  const workspaces = tables?.workspaces
  if (
    typeof workspaces !== 'object' ||
    workspaces === null ||
    Array.isArray(workspaces)
  ) {
    throw new Error(
      `workspace storage unit is malformed in ${unitPath}: missing workspaces table`,
    )
  }
  return {
    document,
    workspaces: workspaces as Record<string, WorkspaceRecord>,
  }
}

/**
 * The registered workspace path owning a cwd, after canonicalization —
 * `undefined` when the cwd does not resolve or no workspace owns it.
 * @param unit - the parsed shared workspace unit.
 * @param cwd - the session's working directory.
 * @returns the owning workspace's canonical path, if any.
 */
export async function matchingWorkspacePath(
  unit: WorkspaceUnit,
  cwd: string,
): Promise<string | undefined> {
  let canonical: string
  try {
    canonical = await realpath(cwd)
  } catch {
    return undefined
  }
  const record = Object.values(unit.workspaces).find(
    candidate => candidate.path === canonical,
  )
  return record?.path
}

/** The canonical existing-directory path of a cwd, or `undefined`. */
async function canonicalDirectory(cwd: string): Promise<string | undefined> {
  try {
    const canonical = await realpath(cwd)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

/** Whether any workspace record already accounts the session. */
function accountedAnywhere(unit: WorkspaceUnit, sessionId: string): boolean {
  return Object.values(unit.workspaces).some(record =>
    record.sessionIds.includes(sessionId),
  )
}

/**
 * Account one session to a workspace, creating the workspace when the cwd
 * has none: an existing matching record gets the web `attachSession`
 * treatment (prepend to `sessionIds`, stamp `updatedAt`); a directory with
 * no record gets one registered first (path = canonical cwd, title =
 * basename, record prepended to the registry order, matching the web's
 * first-bootstrap). A cwd that does not resolve to an existing directory
 * leaves the session ungrouped — the web's workspace create rejects the
 * same path. A session already accounted elsewhere is never double-booked
 * (the web registry would reject the duplicate account at startup).
 * @param storagesRoot - the harness storages root (`~/.dsh/storages`).
 * @param sessionId - the session id stamped into the persisted header.
 * @param cwd - the session's working directory (from the ACP session/new).
 * @returns the attach outcome; malformed units reject.
 */
export async function attachSessionToWorkspace(
  storagesRoot: string,
  sessionId: string,
  cwd: string,
): Promise<AttachOutcome> {
  const unit = await readWorkspaceUnit(storagesRoot)
  if (unit !== undefined) {
    const canonical = await matchingWorkspacePath(unit, cwd)
    if (canonical !== undefined) {
      if (accountedAnywhere(unit, sessionId)) return 'already-attached'
      const record = Object.values(unit.workspaces).find(
        candidate => candidate.path === canonical,
      ) as WorkspaceRecord
      if (!Array.isArray(record.sessionIds)) {
        throw new Error(
          'workspace storage unit is malformed: workspace record has a non-array sessionIds',
        )
      }
      record.sessionIds.unshift(sessionId)
      record.updatedAt = new Date().toISOString()
      await writeUnitAtomic(
        join(storagesRoot, WORKSPACE_UNIT_FILE),
        unit.document,
      )
      return 'attached'
    }
  }
  // No workspace owns the cwd: register one, or stay ungrouped when the
  // directory cannot be a workspace (missing/non-directory path).
  const canonical = await canonicalDirectory(cwd)
  if (canonical === undefined) return 'cwd-unresolved'
  if (unit !== undefined && accountedAnywhere(unit, sessionId)) {
    return 'already-attached'
  }
  const now = new Date().toISOString()
  const id = randomUUID()
  const record: WorkspaceRecord = {
    path: canonical,
    title: basename(canonical),
    sessionIds: [sessionId],
    createdAt: now,
    updatedAt: now,
  }
  const document = unit?.document ?? freshUnitDocument()
  let global = document.global as Record<string, unknown> | undefined
  if (typeof global !== 'object' || global === null) {
    global = { initialized: true, workspaceIds: [], archivedSessionIds: [] }
    document.global = global
  }
  const workspaces = (document.tables as Record<string, unknown>)
    .workspaces as Record<string, WorkspaceRecord>
  const workspaceIds = global.workspaceIds as string[]
  workspaces[id] = record
  workspaceIds.unshift(id)
  await writeUnitAtomic(join(storagesRoot, WORKSPACE_UNIT_FILE), document)
  return 'registered'
}

/** Durably replace the unit file with the mutated document (same protocol as the storage-json backend). */
async function writeUnitAtomic(path: string, document: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const handle = await open(tmp, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, path)
    await fsyncDirectory(dirname(path))
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** fsync a POSIX directory so a just-renamed entry is crash-durable. */
async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

// ── store sync ───────────────────────────────────────────────────────────────

/** One scanned persisted session. */
export interface SessionCandidate {
  sessionId: string
  cwd: string
}

/** Read-only sync plan: what a store scan would attach, register, or skip. */
export interface WorkspaceSyncPlan {
  /** Sessions whose cwd is owned by an existing workspace. */
  attach: SessionCandidate[]
  /** Sessions whose cwd needs a new workspace registration. */
  register: SessionCandidate[]
  /** Sessions whose cwd does not resolve (cannot be accounted). */
  skip: SessionCandidate[]
}

/** Counts from {@link syncWorkspaceAccounts}. */
export interface WorkspaceSyncResult {
  attached: number
  registered: number
  skipped: number
}

/** How to reach the running web host's API gateway. */
export interface WebAttachConfig {
  /** The web host origin, e.g. `http://127.0.0.1:3080`. */
  origin: string
  /** Per-RPC timeout in milliseconds (default 3000). */
  timeoutMs?: number
}

/**
 * Attach a session through the RUNNING web host's own API gateway. The host
 * performs the attach in ITS in-memory registry (the same flow the web UI
 * uses), so the sidebar shows the grouping immediately and — crucially — the
 * host's next registry write republishes its memory, which now includes the
 * session: no stale-memory clobber, no restart required.
 *
 * The workspace is resolved by path through `workspace.create` (idempotent:
 * an already-registered directory returns the existing record), then
 * `session.create` reuses the persisted session — with a preassigned
 * `sessionId` the host's `ensureSession` resumes an existing session whose
 * cwd matches instead of creating a duplicate, then attaches it.
 *
 * Throws on any failure (unreachable host, RPC error, validation) so the
 * caller can fall back to the direct unit write.
 * @param config - the web host origin and timeout.
 * @param sessionId - the persisted session to account.
 * @param cwd - the session's working directory.
 * @returns true once the host confirmed the attach.
 */
export async function attachSessionViaWebHost(
  config: WebAttachConfig,
  sessionId: string,
  cwd: string,
): Promise<boolean> {
  const rpc = async (
    method: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> => {
    const response = await fetch(`${config.origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `grok-${randomUUID()}`,
        method,
        payload,
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 3000),
    })
    if (!response.ok) {
      throw new Error(`web host ${method} returned HTTP ${response.status}`)
    }
    const body = (await response.json()) as {
      result?: { ok?: boolean; value?: unknown; error?: { message?: string } }
    }
    const result = body.result
    if (result?.ok !== true || result.value === undefined) {
      throw new Error(
        `web host ${method} failed: ${result?.error?.message ?? 'unknown error'}`,
      )
    }
    return result.value
  }
  const created = (await rpc('workspace.create', { path: cwd })) as {
    workspace: { workspaceId: string }
  }
  await rpc('session.create', {
    sessionId,
    workspaceId: created.workspace.workspaceId,
  })
  return true
}

/** The first complete line of a session log (its header), zstd-decoded. */
async function headerLineOf(log: string): Promise<string | undefined> {
  try {
    const handle = await open(log, 'r')
    try {
      const buf = Buffer.alloc(1024 * 1024)
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      const frames = scanZstdFrames(buf.subarray(0, bytesRead), 4)
      const first = frames[0]
      if (first === undefined) return undefined
      const text = (
        await zstdDecompressAsync(buf.subarray(first.start, first.end))
      ).toString('utf8')
      return text.split('\n').find(line => line.trim().length > 0)
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
}

/** The id and cwd from a log's header line, when well-formed. */
function parseHeaderCwd(
  firstLine: string | undefined,
): { sessionId: string; cwd: string | undefined } | undefined {
  if (firstLine === undefined) return undefined
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: unknown
      id?: unknown
      cwd?: unknown
    }
    if (parsed.type !== 'session' || typeof parsed.id !== 'string') {
      return undefined
    }
    return {
      sessionId: parsed.id,
      cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
    }
  } catch {
    return undefined
  }
}

/** Scan every persisted session header (mirrors the web's persistence.list). */
async function scanPersistedSessions(
  sessionsRoot: string,
): Promise<Array<{ sessionId: string; cwd: string }>> {
  const out: Array<{ sessionId: string; cwd: string }> = []
  let projects: string[]
  try {
    projects = await readdir(sessionsRoot)
  } catch {
    return out
  }
  for (const project of projects) {
    const projectPath = join(sessionsRoot, project)
    let sessions: string[]
    try {
      sessions = await readdir(projectPath)
    } catch {
      continue
    }
    for (const dir of sessions) {
      const log = join(projectPath, dir, 'session.jsonl.zstd')
      const header = parseHeaderCwd(await headerLineOf(log))
      if (header?.cwd === undefined) continue
      out.push({ sessionId: header.sessionId, cwd: header.cwd })
    }
  }
  return out
}

/**
 * Read-only plan of what {@link syncWorkspaceAccounts} would do.
 * @param storagesRoot - the harness storages root (`~/.dsh/storages`).
 * @param sessionsRoot - the shared session store (`~/.dsh/sessions`).
 * @returns the plan; sessions already accounted never appear.
 */
export async function planWorkspaceSync(
  storagesRoot: string,
  sessionsRoot: string,
): Promise<WorkspaceSyncPlan> {
  const unit = await readWorkspaceUnit(storagesRoot)
  const accounted = new Set(
    Object.values(unit?.workspaces ?? {}).flatMap(
      record => record.sessionIds,
    ),
  )
  const plan: WorkspaceSyncPlan = { attach: [], register: [], skip: [] }
  for (const candidate of await scanPersistedSessions(sessionsRoot)) {
    if (accounted.has(candidate.sessionId)) continue
    if (
      unit !== undefined &&
      (await matchingWorkspacePath(unit, candidate.cwd)) !== undefined
    ) {
      plan.attach.push(candidate)
      continue
    }
    if ((await canonicalDirectory(candidate.cwd)) === undefined) {
      plan.skip.push(candidate)
    } else {
      plan.register.push(candidate)
    }
  }
  return plan
}

/**
 * Re-account every persisted session the web host's stale-memory writes may
 * have dropped from the shared unit: one scan, one read-merge-write. Attaches
 * to existing workspaces and registers new ones for unregistered cwds; never
 * touches sessions already accounted (a duplicate would fail the web's
 * startup validation) and never invents sessions (only persisted logs count).
 * @param storagesRoot - the harness storages root (`~/.dsh/storages`).
 * @param sessionsRoot - the shared session store (`~/.dsh/sessions`).
 * @returns the applied counts.
 */
export async function syncWorkspaceAccounts(
  storagesRoot: string,
  sessionsRoot: string,
): Promise<WorkspaceSyncResult> {
  const plan = await planWorkspaceSync(storagesRoot, sessionsRoot)
  const skipped = plan.skip.length
  if (plan.attach.length === 0 && plan.register.length === 0) {
    return { attached: 0, registered: 0, skipped }
  }
  const unit = await readWorkspaceUnit(storagesRoot)
  const document = unit?.document ?? freshUnitDocument()
  const workspaces = (document.tables as Record<string, unknown>)
    .workspaces as Record<string, WorkspaceRecord>
  let global = document.global as Record<string, unknown> | undefined
  if (typeof global !== 'object' || global === null) {
    global = { initialized: true, workspaceIds: [], archivedSessionIds: [] }
    document.global = global
  }
  const workspaceIds = global.workspaceIds as string[]
  const now = new Date().toISOString()
  let attached = 0
  for (const target of plan.attach) {
    const canonical = await matchingWorkspacePath(
      unit as WorkspaceUnit,
      target.cwd,
    )
    if (canonical === undefined) continue // dir vanished since planning
    const record = Object.values(workspaces).find(
      candidate => candidate.path === canonical,
    ) as WorkspaceRecord
    if (record.sessionIds.includes(target.sessionId)) continue
    record.sessionIds.unshift(target.sessionId)
    record.updatedAt = now
    attached++
  }
  // One new workspace per unregistered canonical cwd, all its sessions in it.
  const byPath = new Map<string, string[]>()
  for (const target of plan.register) {
    const canonical = await canonicalDirectory(target.cwd)
    if (canonical === undefined) continue
    const list = byPath.get(canonical) ?? []
    list.push(target.sessionId)
    byPath.set(canonical, list)
  }
  let registered = 0
  for (const [canonical, sessionIds] of byPath) {
    const id = randomUUID()
    workspaces[id] = {
      path: canonical,
      title: basename(canonical),
      sessionIds,
      createdAt: now,
      updatedAt: now,
    }
    workspaceIds.unshift(id)
    registered += sessionIds.length
  }
  if (attached === 0 && registered === 0) {
    return { attached: 0, registered: 0, skipped }
  }
  await writeUnitAtomic(join(storagesRoot, WORKSPACE_UNIT_FILE), document)
  return { attached, registered, skipped }
}
