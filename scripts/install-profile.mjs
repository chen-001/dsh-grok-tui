#!/usr/bin/env node
/**
 * Profile hookup for the grok-server bridge (used by install.sh, not a
 * standalone CLI): makes `dsh web` carry the grok TUI bridge with no extra
 * flags by wiring the plugin into the user's web profile —
 * `$DSH_HOME/profiles/<profile>/`.
 *
 * What it does (all idempotent, never clobbers user content):
 *   1. Initializes the profile directory exactly like the dsh app's
 *      initProfile would (manifest with the shipped bundle list, empty user
 *      patch layer, pnpm-workspace.yaml) when the profile does not exist yet.
 *   2. Adds the grok-server insert to cordis.patch.yml unless an entry with
 *      id `grok-server` is already present; an untouched template file (`[]`)
 *      is replaced by the insert block, a user-edited file gets the block
 *      appended at the end.
 *   3. Symlinks the plugin package into the profile's node_modules
 *      (`dsh-grok-tui`), the same resolution path the dsh loader uses for
 *      out-of-tree plugins (cf. the @dsh-external/* link: pattern).
 *   4. Best-effort: symlinks the plugin's host-runtime peers (cordis,
 *      @deepseek-ai/*) from the ACTIVE dsh checkout into the plugin's own
 *      node_modules, so the built dist bundle also resolves them under plain
 *      Node (no tsx hook). Skipped with a warning when the checkout does not
 *      provide them (the tsx launcher world resolves via tsconfig paths).
 *
 * Usage:
 *   node scripts/install-profile.mjs \
 *     --plugin-dir <GROK_DIR> --dsh-home <DSH_HOME> \
 *     [--profile web] [--checkout <DSH_CURRENT>]
 */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync, lstatSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((arg, i, all) => {
  if (arg.startsWith('--')) return [arg.slice(2), all[i + 1]];
  return [];
}).filter(([k]) => k));

const pluginDir = args['plugin-dir'];
const dshHome = args['dsh-home'];
const profileName = args['profile'] ?? 'web';
const checkout = args['checkout'] ?? join(dshHome, 'source', 'current');
if (!pluginDir || !dshHome) {
  console.error('install-profile.mjs: --plugin-dir and --dsh-home are required');
  process.exit(1);
}

const profileDir = join(dshHome, 'profiles', profileName);
mkdirSync(profileDir, { recursive: true });
mkdirSync(join(profileDir, 'node_modules'), { recursive: true });

const GROK_SERVER_BLOCK = `# grok TUI bridge (added by dsh-grok-tui install.sh): makes the grok TUI a
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
`;

// 1. Profile manifest (mirror the dsh app's initProfile; never overwrite).
const manifestPath = join(profileDir, 'package.json');
if (!existsSync(manifestPath)) {
  const bundles = profileName === 'headless'
    ? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless']
    : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  writeFileSync(manifestPath, JSON.stringify({
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles } },
  }, null, 2) + '\n');
}
const workspacePath = join(profileDir, 'pnpm-workspace.yaml');
if (!existsSync(workspacePath)) {
  writeFileSync(workspacePath, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
}

// 2. User patch layer: add the grok-server insert, preserving user content.
//    The block is installer-owned and identified by its `id: grok-server`
//    top-level YAML item (plus its leading comment lines). Locate every
//    grok block by line scanning — NOT by marker-line slicing: an older
//    installer's block carried a 3-line comment, and slicing from the marker
//    line alone left the trailing comment lines + the whole old insert
//    behind, producing a duplicate `id: grok-server` that fails the loader
//    ("duplicate loader entry id"). If any block is current (carries
//    `XDG_RUNTIME_DIR || '/tmp'`), keep it and drop the others; if
//    none is current, drop all and append the current block.
const patchPath = join(profileDir, 'cordis.patch.yml');
const originalPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '';
let patch = originalPatch;

/**
 * Remove top-level `- insert:` shells that carry no entries. These are
 * leftovers of the 0.2.6 upgrade bug (the grok block was partially removed,
 * leaving the bare `- insert:` line and its leading comments). A legit
 * insert always has indented entries below it (comments/blank lines don't
 * count). The comment lines directly above a shell belong to the removed
 * grok block and go with it.
 */
function removeEmptyInsertShells(text) {
  const lines = text.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*- insert:\s*$/.test(lines[i])) {
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))
      )
        j++;
      const hasBody = j < lines.length && /^\s+\S/.test(lines[j]);
      if (!hasBody) {
        while (
          kept.length > 0 &&
          kept[kept.length - 1].trimStart().startsWith('#')
        )
          kept.pop();
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Locate every top-level YAML item whose body mentions `id: grok-server`,
 * including its leading comment lines. A block spans from its top-level
 * start (a `- ` item or its immediately preceding `#` comment lines) down
 * to the next top-level non-blank line.
 */
function findGrokBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('id: grok-server')) continue;
    // Walk UP from the (indented) hit to the top-level `- ` item, then
    // absorb the comment lines directly above it.
    let start = i;
    while (start > 0 && (/^\s/.test(lines[start]) || lines[start].trim() === '')) start--;
    while (start > 0 && lines[start - 1].trimStart().startsWith('#')) start--;
    // Walk DOWN while the NEXT line is indented or blank, so `end` stays on
    // the item's last row (never on the next top-level line).
    let end = i;
    while (end + 1 < lines.length && (/^\s/.test(lines[end + 1]) || lines[end + 1].trim() === '')) end++;
    blocks.push({ start, end, text: lines.slice(start, end + 1).join('\n') });
  }
  return blocks;
}

function removeBlockLines(text, block) {
  const lines = text.split('\n');
  const kept = [...lines.slice(0, block.start), ...lines.slice(block.end + 1)];
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Remove the stray empty-array line (`[]`) that v0.3.3's broken append
 * branch glued into a fresh profile: it wrote `[]\n\n- insert:` (the
 * initProfile template's `[]` followed by the grok block), which is illegal
 * YAML. Detect a bare `[]` line that is FOLLOWED by other data (i.e. it is
 * not the whole content) and drop it plus the initProfile template comment
 * lines directly above it, so the remaining grok block is a clean top-level
 * array again.
 */
function removeStrayEmptyArray(text) {
  const lines = text.split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '[]') {
      // Look ahead past blank/comment lines for any real data line; only the
      // stray `[]` backed by later content is the broken form.
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === '' || lines[j].trimStart().startsWith('#'))) j++;
      if (j < lines.length) {
        // This `[]` is not the whole file: drop it and the initProfile
        // template comment block directly above (its leading `#` lines) that
        // names no grok content.
        while (kept.length > 0 && kept[kept.length - 1].trimStart().startsWith('#')) kept.pop();
        continue;
      }
    }
    kept.push(lines[i]);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

patch = removeEmptyInsertShells(patch);
patch = removeStrayEmptyArray(patch);
const grokBlocks = findGrokBlocks(patch);
if (grokBlocks.length > 0) {
  const current = grokBlocks.filter((b) => b.text.includes("XDG_RUNTIME_DIR || '/tmp'"));
  if (grokBlocks.length === 1 && current.length === 1) {
    console.log('install-profile: cordis.patch.yml already carries grok-server — leaving it untouched');
  } else {
    // Drop every stale/duplicate block, then append the current block.
    // Delete in REVERSE start order: removing a block shifts every later
    // block's line numbers, so descending order keeps the remaining
    // blocks' recorded positions valid.
    const sorted = [...grokBlocks].sort((a, b) => b.start - a.start);
    for (const block of sorted) patch = removeBlockLines(patch, block);
    patch = patch.replace(/\s*$/, '') + '\n\n' + GROK_SERVER_BLOCK;
    console.log(
      `install-profile: replaced ${grokBlocks.length} grok-server block(s) with the current one in ${patchPath}`,
    );
  }
} else {
  const trimmed = patch.trim();
  // The shipped initProfile template is "3 comment lines + []", NOT the bare
  // "[]" string this branch used to test — so a fresh user's first setup hit
  // the append branch and glued the grok block onto the trailing "[]",
  // producing `[]\n\n- insert:` (illegal YAML: "end of the stream or a
  // document separator is expected"). Strip comment/blank lines first and
  // treat any remainder that is empty or the literal empty array `[]` as a
  // pristine layer to replace wholesale.
  const dataOnly = trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .join('\n');
  if (dataOnly === '' || dataOnly === '[]') {
    // The shipped template or an empty layer: replace wholesale.
    patch = `${GROK_SERVER_BLOCK}`;
  } else {
    // A user-edited layer: append the insert at the end of the YAML list.
    patch = patch.replace(/\s*$/, '') + '\n\n' + GROK_SERVER_BLOCK;
    console.log(`install-profile: wrote grok-server insert into ${patchPath}`);
  }
}
if (patch !== originalPatch) writeFileSync(patchPath, patch);

// 3. Plugin package link into the profile's node_modules.
const link = join(profileDir, 'node_modules', 'dsh-grok-tui');
const pluginReal = realpathSync(pluginDir);
let linked = false;
try {
  linked = lstatSync(link).isSymbolicLink() && realpathSync(link) === pluginReal;
} catch {
  /* absent link: create below */
}
if (!linked) {
  try {
    rmSync(link, { recursive: true, force: true });
  } catch {
    /* absent link: nothing to remove */
  }
  symlinkSync(pluginReal, link, 'junction');
  console.log(`install-profile: linked dsh-grok-tui -> ${pluginReal}`);
} else {
  console.log(`install-profile: dsh-grok-tui already linked into the profile`);
}

// 4. Best-effort host-runtime peers inside the plugin's node_modules
// (plain-Node resolution for the built bundle; the tsx launcher world does
// not need these).
const peers = ['cordis', 'schemastery'];
mkdirSync(join(pluginDir, 'node_modules'), { recursive: true });
for (const peer of peers) {
  const target = join(checkout, 'node_modules', peer);
  const linkPath = join(pluginDir, 'node_modules', peer);
  if (!existsSync(target)) {
    console.log(`install-profile: warning — ${target} missing; ${peer} resolves via tsx paths only`);
    continue;
  }
  if (existsSync(linkPath)) continue;
  symlinkSync(target, linkPath, 'junction');
}
const deepseekTarget = join(checkout, 'node_modules', '@deepseek-ai');
const deepseekLink = join(pluginDir, 'node_modules', '@deepseek-ai');
if (existsSync(deepseekTarget)) {
  mkdirSync(dirname(deepseekLink), { recursive: true });
  for (const pkg of ['dsh-agent', 'dsh-llm', 'dsh-session', 'dsh-tools', 'dsh-user-questions']) {
    const target = join(deepseekTarget, pkg);
    const linkPath = join(deepseekLink, pkg);
    if (!existsSync(target)) continue;
    if (existsSync(linkPath)) continue;
    symlinkSync(target, linkPath, 'junction');
  }
} else {
  console.log(`install-profile: warning — ${deepseekTarget} missing; @deepseek-ai/* resolve via tsx paths only`);
}

console.log(`install-profile: done — 'dsh ${profileName === 'web' ? 'web' : `--profile ${profileName}`}' now carries the grok bridge`);
console.log(`  socket: /tmp/grok-leader.sock (override in cordis.patch.yml)`);
