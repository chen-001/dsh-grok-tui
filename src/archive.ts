/**
 * Registry-global archive set reader.
 *
 * The DSH Web UI keeps its archived-session set in the workspace registry's
 * durable state (`global.archivedSessionIds`), persisted by the storage-json
 * backend as one unit file under the harness storages root. This server only
 * READS that file (the web host owns writes), so the resume catalog can hide
 * sessions the user archived on the web side. The set is registry-global:
 * archiving never touches workspace accounting.
 *
 * A missing unit file is the normal pre-web state and means "nothing
 * archived"; any other read or parse failure propagates loud.
 * @module dsh-grok-tui/archive
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Unit file name the workspace domain opens under the storages root. */
const WORKSPACE_UNIT_FILE = 'workspace.json'

/**
 * Read the archived-session id set from the shared storage unit.
 * @param storagesRoot - the harness storages root (default `~/.dsh/storages`).
 * @returns the archived session ids, empty when the web never wrote the unit.
 */
export async function readArchivedSessionIds(
  storagesRoot: string,
): Promise<Set<string>> {
  const unitPath = join(storagesRoot, WORKSPACE_UNIT_FILE)
  let raw: string
  try {
    raw = await readFile(unitPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
  const parsed: unknown = JSON.parse(raw)
  const global =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as { global?: unknown }).global
      : undefined
  const archived =
    typeof global === 'object' && global !== null
      ? (global as { archivedSessionIds?: unknown }).archivedSessionIds
      : undefined
  if (!Array.isArray(archived)) {
    throw new Error(
      `workspace storage unit is malformed: missing global.archivedSessionIds array in ${unitPath}`,
    )
  }
  return new Set(archived.filter((id): id is string => typeof id === 'string'))
}
