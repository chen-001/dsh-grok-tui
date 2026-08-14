#!/usr/bin/env bash
# publish-branch.sh — publish ONE git branch as its own npm package.
#
# Every feature branch gets a dedicated npm package name so a SECOND machine
# can install and test the branch's build with a single npm install command:
#
#   dsh-grok-tui             ← main (the official package)
#   dsh-grok-tui-<slug>      ← one package per branch (slug = last path segment)
#                              e.g. feat/slash-commands → dsh-grok-tui-slash-commands
#
# The published tarball is built from the CURRENT checkout of the target
# branch, packaged into a temp dir (git archive + freshly built dist), with
# the package.json name rewritten and the version stamped
# `<branch-version>-<short-commit>` (unique per publish, traceable to a
# commit). The working tree is never modified.
#
# Usage:
#   git checkout feat/slash-commands        # be ON the branch you publish
#   scripts/publish-branch.sh feat/slash-commands
#   scripts/publish-branch.sh feat/slash-commands --dry-run   # no-op check
#
# Requires:
#   - npm logged in (npm adduser, once per machine) — checked before publish
#   - DSH_PATH (default ~/.dsh/source/current) — the build resolves
#     @deepseek-ai/* types through it; dist is rebuilt for the tarball
#
# Target-device install (the point of this script):
#   npm install -g dsh-grok-tui-slash-commands
#   grok-dsh setup && grok-dsh
# (uninstall the previous branch package first if the `grok-dsh` bin collides)
set -euo pipefail

BRANCH="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=1

if [[ -z "$BRANCH" ]]; then
  echo "usage: publish-branch.sh <branch> [--dry-run]" >&2
  echo "  publish the CURRENT checkout's branch as dsh-grok-tui-<slug>" >&2
  exit 1
fi

# --- preconditions -----------------------------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is dirty — commit or stash first (the publish builds from the tree)" >&2
  exit 1
fi
CURRENT="$(git branch --show-current)"
if [[ "$CURRENT" != "$BRANCH" ]]; then
  echo "error: publish from the branch itself — currently on '$CURRENT', asked for '$BRANCH'" >&2
  echo "  run: git checkout $BRANCH && $0 $BRANCH" >&2
  exit 1
fi
git rev-parse --verify "$BRANCH" >/dev/null 2>&1 || {
  echo "error: no such branch '$BRANCH'" >&2
  exit 1
}

SLUG="${BRANCH##*/}"
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
  echo "error: branch segment '$SLUG' is not a valid npm name (lowercase alnum + dashes only)" >&2
  exit 1
fi
PKG_NAME="dsh-grok-tui-$SLUG"
COMMIT="$(git rev-parse --short HEAD)"
BASE_VERSION="$(node -p "require('./package.json').version")"
PKG_VERSION="$BASE_VERSION-$SLUG.$COMMIT"

echo "==> publishing branch '$BRANCH'"
echo "    package:   $PKG_NAME"
echo "    version:   $PKG_VERSION"
echo "    dist built with DSH_PATH=${DSH_PATH:-$HOME/.dsh/source/current}"

# --- build -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "error: node not found" >&2
  exit 1
fi
DSH_PATH="${DSH_PATH:-$HOME/.dsh/source/current}"
if [[ ! -d "$DSH_PATH" ]]; then
  echo "error: DSH_PATH=$DSH_PATH is not a directory — set DSH_PATH to a dsh checkout" >&2
  exit 1
fi
if ! DSH_PATH="$DSH_PATH" npm run build >/tmp/dsh-grok-publish-build.log 2>&1; then
  echo "error: build failed — tail of the build log:" >&2
  tail -20 /tmp/dsh-grok-publish-build.log >&2
  exit 1
fi
echo "    build ok"

# --- login check -------------------------------------------------------------
if ! npm whoami >/dev/null 2>&1; then
  echo "error: npm is not logged in — run 'npm adduser' once, then re-run this script" >&2
  exit 1
fi
WHOAMI="$(npm whoami)"

# --- name ownership check ----------------------------------------------------
EXISTING="$(npm view "$PKG_NAME" maintainers 2>/dev/null || true)"
if [[ -n "$EXISTING" && "$EXISTING" != *"$WHOAMI"* ]]; then
  echo "error: $PKG_NAME is already owned by someone else: $EXISTING" >&2
  echo "  pick a different branch slug or remove the package first" >&2
  exit 1
fi
if [[ -n "$EXISTING" ]]; then
  echo "    name already published by you ($EXISTING) — publishing a new version"
fi

# --- package in a temp dir ---------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git archive HEAD | tar -x -C "$TMP"
# The tarball must carry the freshly built bundle (git archive has the
# committed one; the tree above may be one build ahead).
cp dist/index.js "$TMP/dist/index.js"
# Rewrite name + version on the temp copy (never the working tree).
node -e "
  const fs = require('node:fs')
  const p = '$TMP/package.json'
  const pkg = JSON.parse(fs.readFileSync(p, 'utf8'))
  pkg.name = '$PKG_NAME'
  pkg.version = '$PKG_VERSION'
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')
"
echo "    staged at $TMP"

# --- publish ---------------------------------------------------------------
(
  cd "$TMP"
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "==> dry run (no publish): npm publish --access public --dry-run"
    npm publish --access public --dry-run
    echo "    would publish: $PKG_NAME@$PKG_VERSION"
  else
    npm publish --access public
    echo "==> published $PKG_NAME@$PKG_VERSION"
  fi
)

# --- target-device instructions ----------------------------------------------
echo ""
echo "install on the target machine (one command):"
echo "  npm install -g $PKG_NAME"
echo "  grok-dsh setup      # wire the bridge into the web profile (once)"
echo "  dsh web && grok-dsh"
echo ""
echo "notes:"
echo "  - uninstall a previously installed branch package first if the 'grok-dsh' bin collides:"
echo "    npm uninstall -g dsh-grok-tui   # or whatever branch package is installed"
echo "  - this build is $BRANCH @ $COMMIT ($PKG_VERSION)"
