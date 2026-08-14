#!/usr/bin/env bash
# grok-dsh — the grok TUI over DeepSeek Harness, BRIDGE-ONLY.
#
# Since v0.5.0 there is exactly ONE deployment shape: the official `dsh web`
# host carries the grok bridge (install.sh wires it into the web profile), and
# grok-dsh connects the TUI straight to the HOST — a peer of the browser
# tabs, sharing one live agent per session. The standalone backend
# (scripts/serve-real.ts) is gone: `dsh web` must be running before
# `grok-dsh` can open the TUI.
#
# The bridge binds $XDG_RUNTIME_DIR/grok-leader.sock (Linux) or
# /tmp/grok-leader.sock (no XDG_RUNTIME_DIR), a path computed from the HOST
# process's env — which can disagree with the env of the terminal running
# grok-dsh (SSH login shells typically lack XDG_RUNTIME_DIR while a
# logind/desktop-started `dsh web` has it, and the reverse happens too).
# grok-dsh therefore probes every candidate socket (GROK_HOST_SOCKET
# override, this shell's XDG_RUNTIME_DIR, /tmp, and Linux /run/user/*
# runtime dirs) and uses whichever answers the bridge handshake. The socket
# path deliberately avoids ~/.grok/leader.sock (the ORIGINAL grok CLI's own
# leader path) and the DSH home (dsh's chokidar watchers crash on unix
# sockets on macOS), and the host probe verifies the leader's identity by
# handshake, so a standalone original grok TUI can never be mistaken for the
# bridge.
#
#   grok-dsh           open the TUI on the running host's leader socket.
#                      Fails with instructions when no `dsh web` is up.
#                      Inside tmux, a small side pane renders the live usage
#                      meter (cache hit %, in/out tokens) for ANY grok binary.
#   grok-dsh status    show host bridge status and grok version
#   grok-dsh setup     wire the grok bridge into the dsh web profile
#                      (~/.dsh/profiles/web) so `dsh web` carries the leader
#                      socket — run once after installing, then `dsh web`
#                      (restart it if already running) and `grok-dsh`. Explicit
#                      and idempotent: a global install never silently rewrites
#                      the user's dsh config.
#
# Env:
#   GROK_HOST_SOCKET   official host bridge socket override (default: probe
#                      $XDG_RUNTIME_DIR/grok-leader.sock, /tmp/grok-leader.sock
#                      and Linux /run/user/* candidates — the bridge binds
#                      whichever path the HOST process's env implies)
#   GROK_BIN           grok binary. Resolution order: $GROK_BIN override, a
#                      user-level pager at $HOME/.dsh/grok-pager, a sibling
#                      grok-build source checkout
#                      (../grok-build/target/debug/xai-grok-pager — carries
#                      the status-bar context/stats coupling), then the
#                      official `grok` binary on PATH / ~/.grok/bin/grok
#                      (the official binary renders no status items).
#   DSH_GROK_MODEL     model (default deepseek-v4-pro; flash: deepseek-v4-flash)
#   DSH_GROK_EFFORT    reasoning effort (default max; off|high|max)
set -euo pipefail

# Candidate official-host bridge sockets, in preference order. The bridge
# binds "$XDG_RUNTIME_DIR/grok-leader.sock" when the HOST process has
# XDG_RUNTIME_DIR (Linux multi-user: /run/user/<uid>, private + 0700), else
# /tmp/grok-leader.sock. That path is computed from the dsh web process's
# env, which can disagree with the env of THIS shell: SSH login shells
# typically lack XDG_RUNTIME_DIR while a logind/desktop-started `dsh web`
# has it (and the reverse happens too). Probing every candidate finds the
# running host whichever side has XDG_RUNTIME_DIR. In both cases the path is
# deliberately NOT ~/.grok/leader.sock: a standalone ORIGINAL grok TUI spawns
# its own leader process on that path, and connecting to it would hand this
# TUI to the original grok backend instead of the dsh bridge. Staying out of
# the DSH home also avoids dsh's chokidar watchers crashing on unix sockets
# (macOS fs.watch UNKNOWN errno -102).
host_socket_candidates() {
  if [[ -n "${GROK_HOST_SOCKET:-}" ]]; then
    printf '%s\n' "$GROK_HOST_SOCKET"
    return 0
  fi
  if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
    printf '%s\n' "$XDG_RUNTIME_DIR/grok-leader.sock"
  fi
  printf '%s\n' "/tmp/grok-leader.sock"
  # Linux logind keeps one private runtime dir per uid; if THIS shell has no
  # XDG_RUNTIME_DIR but the host does, its socket lives here. Dead or
  # foreign-uid candidates fail the -S / handshake checks instantly.
  if [[ -d /run/user ]]; then
    for _runtime_dir in /run/user/*/; do
      [[ -d "$_runtime_dir" ]] || continue
      printf '%s\n' "${_runtime_dir%/}/grok-leader.sock"
    done
  fi
}
# Resolve THIS script's real path. npm links the bin (node_modules/.bin/grok-dsh)
# as a SYMLINK to the package script, and bash sets BASH_SOURCE[0] to the
# symlink path — dirname would then point at node_modules/.bin instead of the
# package. Follow the link chain (readlink -f does not exist on macOS).
_SRC="${BASH_SOURCE[0]}"
while [ -h "$_SRC" ]; do
  _LINK="$(readlink "$_SRC")"
  case "$_LINK" in
    /*) _SRC="$_LINK" ;;
    *) _SRC="$(dirname "$_SRC")/$_LINK" ;;
  esac
done
DIR="$(cd "$(dirname "$_SRC")/.." && pwd)"
# Resolve the grok TUI binary device-independently (see header comment).
# Order: $GROK_BIN override, the user-level pager at $HOME/.dsh/grok-pager
# (a symlink or copy of the source-built pager, refreshed by
# build-grok-pager.sh — survives npm/git installs and grok-build upgrades),
# a sibling grok-build source checkout (built into <plugin>/../grok-build by
# build-grok-pager.sh — only reachable from a git/npm-local install), then the
# official `grok` binary on PATH / ~/.grok/bin/grok (renders no status items).
GROK_BIN="${GROK_BIN:-}"
if [[ -z "$GROK_BIN" ]]; then
  if [[ -x "$HOME/.dsh/grok-pager" ]]; then
    GROK_BIN="$HOME/.dsh/grok-pager"
  else
    _sibling=''
    for _pager in "$DIR/../grok-build/target/debug/xai-grok-pager" "$DIR/../grok-build/target/release/xai-grok-pager"; do
      if [[ -x "$_pager" ]]; then
        _sibling="$_pager"
        break
      fi
    done
    if [[ -n "$_sibling" ]]; then
      GROK_BIN="$_sibling"
    elif command -v grok >/dev/null 2>&1; then
      GROK_BIN="$(command -v grok)"
    elif [[ -x "$HOME/.grok/bin/grok" ]]; then
      GROK_BIN="$HOME/.grok/bin/grok"
    fi
  fi
fi
# The directory grok-dsh was invoked from: the TUI (and each session's cwd)
# stays here.
USER_CWD="$(pwd)"

# Find the official host's bridge: probe every candidate socket and print
# the first that answers the HANDSHAKE (probe-host-bridge.mjs), empty when
# none. The handshake, not a connect check, is what identifies the bridge:
# the original grok TUI also listens on its own leader socket
# (~/.grok/leader.sock) when run standalone, and only the dsh bridge answers
# get_leader_info with a `dsh-grok-tui` binary version. The probe script
# lives next to this launcher.
host_socket_find() {
  local sock
  for sock in $(host_socket_candidates); do
    [[ -S "$sock" ]] || continue
    if node "$DIR/scripts/probe-host-bridge.mjs" "$sock" 2>/dev/null; then
      printf '%s\n' "$sock"
      return 0
    fi
  done
  return 1
}

# --- usage panel (optional tmux side pane) -----------------------------------
# When running inside tmux, split a small pane below the TUI that renders the
# live dsh usage meter (scripts/usage-panel.mjs, fed by the bridge's status
# file) — so even the STOCK grok binary shows cache hit rate / in / out tokens.
# Outside tmux the TUI just shows the stock context bar; nothing else changes.
PANEL_PANE=''
start_usage_panel() {
  [[ -n "${TMUX:-}" ]] || return 0
  command -v tmux >/dev/null 2>&1 || return 0
  PANEL_PANE="$(tmux split-window -v -l 8 -P -F '#{pane_id}' \
    "node \"$DIR/scripts/usage-panel.mjs\"" 2>/dev/null)" || PANEL_PANE=''
}
stop_usage_panel() {
  [[ -n "$PANEL_PANE" ]] || return 0
  tmux kill-pane -t "$PANEL_PANE" 2>/dev/null || true
  PANEL_PANE=''
}

# --- herdr agent-pane metrics ------------------------------------------------
# Inside a herdr pane (HERDR_ENV=1), mirror the usage view into herdr's
# `pane.report_metadata` IPC so the agents list shows cache % / TTFT / TPS /
# in / out tokens under the grok agent (sidebar rows declared as
# `Custom("dsh.cache")` etc. — see README "herdr 适配").
HERDR_WATCHER_PID=''
# Ensure the herdr sidebar rows exist before the watcher starts reporting.
# The npm postinstall already runs this (idempotent); this covers installs
# that skipped scripts (--ignore-scripts) or predate the postinstall.
ensure_herdr_config() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  # npm installs files as 0644 (not executable); python3 runs it regardless.
  [[ -f "$DIR/scripts/install-herdr-config.py" ]] || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  python3 "$DIR/scripts/install-herdr-config.py" >/dev/null 2>&1 || true
}
start_herdr_watcher() {
  [[ "${HERDR_ENV:-}" == "1" ]] || return 0
  command -v node >/dev/null 2>&1 || return 0
  ensure_herdr_config
  node "$DIR/scripts/herdr-usage-watcher.mjs" >/dev/null 2>&1 &
  HERDR_WATCHER_PID=$!
}
stop_herdr_watcher() {
  [[ -n "$HERDR_WATCHER_PID" ]] || return 0
  kill "$HERDR_WATCHER_PID" 2>/dev/null || true
  HERDR_WATCHER_PID=''
}

# TUI exit / status: the host is managed by `dsh web`, so closing the TUI
# only stops this window's side panes and watchers.
tui_exit() {
  if [[ "${1:-}" == "status" ]]; then
    if found="$(host_socket_find)"; then
      echo "official host bridge: RUNNING (leader socket $found)"
    else
      echo "official host bridge: not running (no bridge handshake at $(host_socket_candidates | paste -sd ' ' -))"
      echo "  start 'dsh web' first, then re-run grok-dsh"
    fi
    if [[ -x "$GROK_BIN" ]]; then
      echo "grok binary: $("$GROK_BIN" --version 2>/dev/null | head -1) ($GROK_BIN)"
      if [[ "$GROK_BIN" != "$HOME/.grok/bin/grok" && "$GROK_BIN" != "$(command -v grok 2>/dev/null || true)" ]]; then
        echo "  (source-built pager: renders the dsh status bar — cache %, tokens, tool time)"
      fi
    else
      echo "grok binary: <none — install via curl -fsSL https://x.ai/cli/install.sh | bash>"
    fi
  else
    stop_herdr_watcher
    stop_usage_panel
  fi
}

if [[ "${1:-}" == "status" ]]; then
  tui_exit status
  exit 0
fi
if [[ "${1:-}" == "setup" ]]; then
  # Wire the grok bridge into the dsh web profile (~/.dsh/profiles/web) so
  # `dsh web` carries the leader socket and `grok-dsh` connects to it as a
  # peer client. Explicit (never run automatically at npm install): a global
  # package must not silently rewrite the user's dsh config. Idempotent —
  # install-profile.mjs never clobbers existing rows and can be re-run safely.
  DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
  DSH_CURRENT="${DSH_CURRENT:-$DSH_HOME/source/current}"
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node not found — install Node ^22.19 || >=24 first" >&2
    exit 1
  fi
  if [[ ! -f "$DIR/scripts/install-profile.mjs" ]]; then
    echo "error: install-profile.mjs missing from this install ($DIR)" >&2
    echo "  load the bridge manually with:  dsh web --patch $DIR/grok-server.yml" >&2
    exit 1
  fi
  node "$DIR/scripts/install-profile.mjs" \
    --plugin-dir "$DIR" --dsh-home "$DSH_HOME" --checkout "$DSH_CURRENT" \
    || {
      echo "error: profile hookup failed — load the bridge manually with:" >&2
      echo "  dsh web --patch $DIR/grok-server.yml" >&2
      exit 1
    }
  echo "done — restart 'dsh web' (if running) so it picks up the grok bridge,"
  echo "  then run 'grok-dsh' to connect the TUI to the host."
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "error: unknown command '$1'" >&2
  echo "usage: grok-dsh [status|setup]" >&2
  echo "  (bridge-only since v0.5.0: start 'dsh web' first, then run grok-dsh)" >&2
  exit 1
fi

if [[ ! -x "$GROK_BIN" ]]; then
  echo "error: no grok TUI binary found (GROK_BIN=${GROK_BIN:-<unset>})." >&2
  echo "  Install the official binary:  curl -fsSL https://x.ai/cli/install.sh | bash" >&2
  echo "  or set GROK_BIN=/path/to/xai-grok-pager (source-built, with status bar)." >&2
  exit 1
fi

echo "grok binary: $("$GROK_BIN" --version 2>/dev/null | head -1)"
echo "working directory: $USER_CWD"

# Bridge-only: the host's leader socket owns the session store, and
# connecting to it makes this TUI a peer of the browser tabs (one live agent
# per session — no seq gaps possible). No host = no TUI.
if found="$(host_socket_find)"; then
  echo "connecting to the official host bridge at $found"
  echo "TUI open — closing it (Ctrl+C or /exit) leaves the host untouched"
  start_usage_panel
  start_herdr_watcher
  (cd "$USER_CWD" && GROK_LEADER_SOCKET="$found" "$GROK_BIN" --leader)
  stop_herdr_watcher
  stop_usage_panel
  exit 0
fi

echo "error: no official dsh web host bridge found." >&2
echo "  grok-dsh is bridge-only since v0.5.0: start the host first, then re-run." >&2
echo "    dsh web            # start the official host (carries the grok bridge)" >&2
echo "    grok-dsh           # then open the TUI" >&2
echo "  probed sockets: $(host_socket_candidates | paste -sd ' ' -)" >&2
echo "  not installed yet? run 'grok-dsh setup' once to wire the bridge into the web profile." >&2
exit 1
