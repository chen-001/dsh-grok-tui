#!/bin/sh
# dsh-grok-tui postinstall — runs inside the installed package directory.
#
# 1. MATERIALIZE when npm linked the package into npm's git-clone cache.
#    `npm install <git-url>` (npm 11) installs the package as a SYMLINK to
#    ~/.npm/_cacache/tmp/git-cloneXXXX, and npm's cache GC later deletes that
#    clone — leaving the whole package (and its bin link) broken. Copy the
#    clone into a real directory so the install survives the GC.
# 2. Ensure the herdr sidebar rows exist (idempotent; install.sh does the
#    same). Best-effort: failures never fail the npm install.
#
# The package dir may BE the symlink this script replaces: chdir away first
# and work with absolute paths, or removing the link under our own cwd makes
# every later getcwd() fail ("sh: getcwd() failed") and aborts the install.
set -u

pkg="$PWD"
cd / 2>/dev/null || exit 0

# --- 1. materialize a symlinked install --------------------------------------
if [ -L "$pkg" ]; then
  target=$(readlink "$pkg" 2>/dev/null || true)
  if [ -n "$target" ] && [ -d "$target" ]; then
    tmp="${pkg}.materialize.$$"
    parent=$(dirname "$pkg")
    if cp -a "$target" "$tmp" 2>/dev/null \
      && rm -f "$pkg" \
      && mv "$tmp" "$pkg" 2>/dev/null; then
      echo "dsh-grok-tui: materialized symlinked install (npm git-clone cache) into a real directory"
    else
      rm -rf "$tmp" 2>/dev/null || true
    fi
  fi
fi

# Back into the (now real) package dir so npm's post-install bookkeeping
# keeps a valid cwd.
cd "$pkg" 2>/dev/null || true

# --- 2. herdr sidebar config (best-effort) -----------------------------------
if [ -f "$pkg/scripts/install-herdr-config.py" ] && command -v python3 >/dev/null 2>&1; then
  python3 "$pkg/scripts/install-herdr-config.py" >/dev/null 2>&1 || true
fi
