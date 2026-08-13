/**
 * Backfill: account EXISTING sessions to web workspaces, registering a
 * workspace for any directory that has none.
 *
 * Sessions the web host's stale-memory writes dropped (or sessions created
 * before the attach landed) sit under "Ungrouped" in the web sidebar even
 * when their cwd matches a registered workspace. This script re-accounts
 * every persisted session from the shared store — the same scan the server
 * performs at startup.
 *
 * Usage:
 *   node --import tsx scripts/backfill-attach.ts            # dry run (prints the plan)
 *   node --import tsx scripts/backfill-attach.ts --apply    # write the attachments
 *
 * Env: DSH_GROK_SESSIONS / DSH_GROK_STORAGES override the shared roots,
 * exactly like the server itself.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  planWorkspaceSync,
  syncWorkspaceAccounts,
} from '../src/workspace-attach.ts'

const SESSIONS =
  process.env.DSH_GROK_SESSIONS ?? join(homedir(), '.dsh', 'sessions')
const STORAGES =
  process.env.DSH_GROK_STORAGES ?? join(homedir(), '.dsh', 'storages')
const APPLY = process.argv.includes('--apply')

console.log(
  `sessions root: ${SESSIONS}\nstorages root: ${STORAGES}\nmode: ${APPLY ? 'APPLY' : 'dry run (add --apply to write)'}`,
)
const plan = await planWorkspaceSync(STORAGES, SESSIONS)
for (const candidate of plan.attach) {
  console.log(`ATTACH   ${candidate.sessionId}  ${candidate.cwd}`)
}
for (const candidate of plan.register) {
  console.log(`REGISTER ${candidate.sessionId}  ${candidate.cwd}`)
}
for (const candidate of plan.skip) {
  console.log(
    `SKIP     ${candidate.sessionId}  ${candidate.cwd}  (cwd-unresolved)`,
  )
}
if (!APPLY) {
  console.log(
    `\ncandidates ${plan.attach.length + plan.register.length + plan.skip.length}, ` +
      `attach ${plan.attach.length}, register ${plan.register.length}, skip ${plan.skip.length} (dry run)`,
  )
  process.exit(0)
}
const result = await syncWorkspaceAccounts(STORAGES, SESSIONS)
console.log(
  `\napplied: attached ${result.attached}, registered ${result.registered}, skipped ${result.skipped}`,
)
