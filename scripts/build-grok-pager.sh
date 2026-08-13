#!/bin/sh
# build-grok-pager.sh — build the grok TUI pager from source WITH the dsh
# status-bar coupling, for machines that only have the official grok binary.
#
# Why: the official downloaded grok binary predates the dsh status-bar meta
# (`_meta.dshUsage`, `totalContextTokens`), so the top-right status items
# (cache %, input/output tokens, API calls, tool time) only render on a
# pager built from grok-build + the dsh patch shipped in this repository
# (vendor/grok-build-dsh.patch). The session itself works either way.
#
#   sh scripts/build-grok-pager.sh
#
# Requirements: git, cargo (Rust toolchain), and a protoc resolver — either
# `dotslash` (the launcher the repo's bin/protoc needs) or `protoc` on PATH.
# Missing ones are handled: dotslash is installed via cargo automatically.
#
# Env:
#   GROK_BUILD_DIR   grok-build checkout dir  (default: <plugin>/../grok-build)
#   GROK_BUILD_REPO  clone URL                (default: https://github.com/xai-org/grok-build.git)
#   GROK_BUILD_REV   commit/ref to build      (default: 393430e — the tested base)
#   GROK_BUILD_PATCH dsh patch file           (default: <plugin>/vendor/grok-build-dsh.patch)
set -eu

die() { printf 'error: %s\n' "$1" >&2; exit 1; }

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PLUGIN_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
BUILD_DIR=${GROK_BUILD_DIR:-$PLUGIN_DIR/../grok-build}
REPO=${GROK_BUILD_REPO:-https://github.com/xai-org/grok-build.git}
REV=${GROK_BUILD_REV:-393430ee4934bc791b0d538f304a21691c517433}
PATCH=${GROK_BUILD_PATCH:-$PLUGIN_DIR/vendor/grok-build-dsh.patch}
PAGER="$BUILD_DIR/target/debug/xai-grok-pager"

command -v git >/dev/null 2>&1 || die "git is required but not found."
command -v cargo >/dev/null 2>&1 || die "cargo (Rust toolchain) is required but not found. Install Rust (https://rustup.rs), then re-run."
[ -f "$PATCH" ] || die "the dsh patch is missing at $PATCH — is this the dsh-grok-tui repository?"

# --- 1. fetch the grok-build source at the pinned revision ------------------
if [ -d "$BUILD_DIR/.git" ]; then
  echo "==> updating grok-build checkout at $BUILD_DIR"
  git -C "$BUILD_DIR" fetch -q origin "$REV" \
    || die "could not fetch $REV from $REPO (set GROK_BUILD_REV to override)."
  # hard reset: the working tree may carry the previously applied dsh patch
  git -C "$BUILD_DIR" reset -q --hard FETCH_HEAD
elif [ -e "$BUILD_DIR" ]; then
  if [ -d "$BUILD_DIR" ] && ! ls -A "$BUILD_DIR" 2>/dev/null | grep -q .; then
    rmdir "$BUILD_DIR" 2>/dev/null || true
  else
    die "$BUILD_DIR exists but is not a git clone. Remove it (or set GROK_BUILD_DIR) and re-run."
  fi
fi
if [ ! -d "$BUILD_DIR" ]; then
  echo "==> cloning grok-build ($REV) into $BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  git -C "$BUILD_DIR" init -q
  git -C "$BUILD_DIR" remote add origin "$REPO"
  git -C "$BUILD_DIR" fetch -q --depth 1 origin "$REV" \
    || die "could not fetch $REV from $REPO (set GROK_BUILD_REV to override)."
  git -C "$BUILD_DIR" checkout -q -B dsh-build FETCH_HEAD
fi

# --- 2. apply the dsh status-bar patch (idempotent) --------------------------
if ! git -C "$BUILD_DIR" apply --check "$PATCH" 2>/dev/null; then
  if git -C "$BUILD_DIR" apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "==> dsh patch already applied"
  else
    die "the dsh patch does not apply to grok-build $REV. Set GROK_BUILD_REV to a compatible revision."
  fi
else
  echo "==> applying vendor/grok-build-dsh.patch"
  git -C "$BUILD_DIR" apply "$PATCH"
fi

# --- 3. protoc resolver -------------------------------------------------------
# xai-grok-tools-api's build script compiles proto files: the repo's
# bin/protoc is a `dotslash` launcher (`#!/usr/bin/env dotslash`), and the
# build falls back to `protoc` from PATH. The fallback only works if the
# protoc produces the exact output shape the build validates (the first
# stdout line of `protoc --dependency_out=/dev/stdout ...` must start with
# /dev/null:) — a random protoc (e.g. anaconda's 3.20) fails that check with
# an unhelpful panic in xai-grok-tools-api's build script. dotslash is small;
# install it via cargo when it (or a working protoc) is missing.
export PATH="$HOME/.cargo/bin:$PATH"
protoc_usable() {
  [ -x "$1" ] || return 1
  out=$("$1" --dependency_out=/dev/stdout --descriptor_set_out=/dev/null \
    -I"$2" "$2/grok-tools.proto" 2>/dev/null) || return 1
  case $out in /dev/null:*) return 0 ;; *) return 1 ;; esac
}
if command -v dotslash >/dev/null 2>&1; then
  echo "==> protoc resolver: dotslash ($(command -v dotslash))"
else
  PROTO_DIR="$BUILD_DIR/crates/codegen/xai-grok-tools-api/proto"
  if command -v protoc >/dev/null 2>&1 \
    && protoc_usable "$(command -v protoc)" "$PROTO_DIR"; then
    echo "==> protoc resolver: protoc ($(command -v protoc))"
  else
    echo "==> installing dotslash (the protoc launcher the repo's bin/protoc needs)"
    cargo install dotslash >/dev/null 2>&1 \
      || die "could not install dotslash. Install it manually (cargo install dotslash) or put a WORKING protoc on PATH, then re-run."
    echo "==> dotslash installed ($(command -v dotslash))"
  fi
fi

# --- 4. build (debug profile — the source of record for the status bar) ------
echo "==> building xai-grok-pager (this takes a while; logs: $BUILD_DIR/dsh-build.log)"
if ! ( cd "$BUILD_DIR" && cargo build -p xai-grok-pager-bin ) >"$BUILD_DIR/dsh-build.log" 2>&1; then
  echo "error: cargo build failed; tail of $BUILD_DIR/dsh-build.log:" >&2
  tail -20 "$BUILD_DIR/dsh-build.log" >&2
  exit 1
fi

[ -x "$PAGER" ] || die "build finished but $PAGER is missing."
echo "==> built: $PAGER"
"$PAGER" --version 2>/dev/null | head -1 || true
# Refresh the user-level pager slot: grok-dsh checks $HOME/.dsh/grok-pager
# FIRST (before PATH), so the freshly built pager takes effect immediately —
# and it survives npm/global installs and grok-build upgrades (no rebuild
# needed to keep rendering the dsh status bar; only re-run this script when
# you actually want a newer pager).
if mkdir -p "$HOME/.dsh" && cp -f "$PAGER" "$HOME/.dsh/grok-pager" && chmod +x "$HOME/.dsh/grok-pager"; then
  echo "==> installed the pager at \$HOME/.dsh/grok-pager (grok-dsh will use it)"
else
  echo "warning: could not copy the pager to \$HOME/.dsh/grok-pager — grok-dsh will fall back to the sibling/ PATH resolution."
fi
echo "grok-dsh prefers this binary over the official one — you get the full status bar."
