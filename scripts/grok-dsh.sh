#!/usr/bin/env bash
# grok-dsh — one command for the grok TUI over DeepSeek Harness.
#
# OFFICIAL HOST BRIDGE (recommended): when the official `dsh web` host is
# running with the grok bridge (install.sh wires it into the web profile), its
# leader socket has a listener and grok-dsh connects the TUI straight to the
# HOST — a peer of the browser tabs, sharing one live agent per session. No
# backend is started; closing the TUI changes nothing. The bridge binds
# $XDG_RUNTIME_DIR/grok-leader.sock (Linux) or /tmp/grok-leader.sock (no
# XDG_RUNTIME_DIR), a path computed from the HOST process's env — which can
# disagree with the env of the terminal running grok-dsh (SSH login shells
# typically lack XDG_RUNTIME_DIR while a logind/desktop-started `dsh web` has
# it, and the reverse happens too). grok-dsh therefore probes every candidate
# socket (GROK_HOST_SOCKET override, this shell's XDG_RUNTIME_DIR, /tmp, and
# Linux /run/user/* runtime dirs) and uses whichever answers the bridge
# handshake. The socket path deliberately avoids ~/.grok/leader.sock (the
# ORIGINAL grok CLI's own leader path) and the DSH home (dsh's chokidar
# watchers crash on unix sockets on macOS), and the host probe verifies the
# leader's identity by handshake, so a standalone original grok TUI can never
# be mistaken for the bridge.
#
# STANDALONE DAEMON (fallback): without a running official host, grok-dsh
# starts this window's own backend (serve-real.ts, one server process + socket
# per window, auto-stopped when the TUI closes) and prints a warning: running
# BOTH the official host and a standalone daemon at once resurrects the
# two-writer session-log race (seq gaps) — never do both for the same store.
#
# The plugin lives in a STABLE directory (installed by install.sh, default
# ~/.dsh/dsh-grok-tui), independent of the dsh checkout. The backend imports
# unpublished @deepseek-ai/* workspace packages; they resolve through the
# ACTIVE dsh checkout's tsconfig paths via the tsx ESM hook — the same
# mechanism the dsh launcher itself uses — so the backend always runs
# against the currently installed dsh. Upgrading dsh needs no re-install.
#
#   grok-dsh           open the TUI on the official host's leader socket when
#                      it is running, else start a standalone backend + TUI.
#                      Inside tmux, a small side pane renders the live usage
#                      meter (cache hit %, in/out tokens) for ANY grok binary.
#   grok-dsh stop      stop ALL standalone grok-dsh backends (the official
#                      host is managed by `dsh web`, not by this command)
#   grok-dsh status    show host socket / backend status and grok version
#   grok-dsh restart   stop + start this window's standalone backend
#   grok-dsh setup     wire the grok bridge into the dsh web profile
#                      (~/.dsh/profiles/web) so `dsh web` carries the leader
#                      socket — run once after installing, then `dsh web`
#                      (restart it if already running) and `grok-dsh`. Explicit
#                      and idempotent: a global install never silently rewrites
#                      the user's dsh config.
#
# Env:
#   DSH_CURRENT        active dsh checkout (default ~/.dsh/source/current)
#   GROK_LEADER_SOCKET standalone socket path (default /tmp/dsh-grok-<pid>.sock)
#   GROK_HOST_SOCKET   official host bridge socket override (default: probe
#                      $XDG_RUNTIME_DIR/grok-leader.sock, /tmp/grok-leader.sock
#                      and Linux /run/user/* candidates — the bridge binds
#                      whichever path the HOST process's env implies)
#   GROK_BIN           grok binary. Resolution order: $GROK_BIN override, a
#                      sibling grok-build source checkout
#                      (../grok-build/target/debug/xai-grok-pager — carries
#                      the status-bar context/stats coupling), then the
#                      official `grok` binary on PATH / ~/.grok/bin/grok
#                      (the official binary renders no status items).
#   DSH_GROK_MODEL     model (default deepseek-v4-pro; flash: deepseek-v4-flash)
#   DSH_GROK_EFFORT    reasoning effort (default max; off|high|max)
set -euo pipefail

INSTANCE="$$"
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
# A user may have exported GROK_LEADER_SOCKET for the original grok CLI; if
# it happens to name ANY host-bridge socket candidate, the standalone backend
# must NOT use it (it would fight the bridge for the listener) — fall back to
# the per-window /tmp path.
SOCKET="${GROK_LEADER_SOCKET:-/tmp/dsh-grok-${INSTANCE}.sock}"
if [[ -n "${GROK_LEADER_SOCKET:-}" ]]; then
  for _host_sock in $(host_socket_candidates); do
    if [[ "$GROK_LEADER_SOCKET" == "$_host_sock" ]]; then
      echo "note: GROK_LEADER_SOCKET names the host bridge socket — the standalone backend will use /tmp/dsh-grok-${INSTANCE}.sock instead"
      SOCKET="/tmp/dsh-grok-${INSTANCE}.sock"
      break
    fi
  done
fi
PIDFILE=/tmp/dsh-grok-${INSTANCE}.pid
LOG=/tmp/dsh-grok-${INSTANCE}.log
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
DSH_CURRENT="${DSH_CURRENT:-$HOME/.dsh/source/current}"
# Resolve the ACTIVE dsh checkout (symlink-safe; no readlink -f on macOS).
DSH_ROOT="$(CDPATH= cd -P -- "$DSH_CURRENT" 2>/dev/null && pwd -P)" || DSH_ROOT=''
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
# stays here; only the backend daemon runs from the plugin directory.
USER_CWD="$(pwd)"

server_pid() {
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

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

# Validate the ACTIVE dsh checkout. @deepseek-ai/* and cordis resolve via the
# checkout's tsconfig paths through the tsx ESM hook — the same mechanism the
# dsh launcher uses. This follows dsh upgrades automatically (DSH_ROOT is
# re-resolved on every launch).
check_dsh() {
  if [[ -z "$DSH_ROOT" || ! -x "$DSH_ROOT/node_modules/tsx/dist/esm/index.mjs" || ! -f "$DSH_ROOT/tsconfig.json" ]]; then
    echo "error: cannot resolve the active dsh checkout at $DSH_CURRENT" >&2
    echo "  (tsx hook and tsconfig.json are missing). Is dsh installed? Set" >&2
    echo "  DSH_CURRENT to the active checkout if it lives elsewhere." >&2
    exit 1
  fi
}

start_server() {
  if server_pid >/dev/null; then
    echo "backend already running (pid $(server_pid))"
    return 0
  fi
  check_dsh
  rm -f "$SOCKET"
  echo "starting backend (logs: $LOG)"
  # The daemon keeps the plugin directory as its cwd (session persistence);
  # the wrapper restores the caller's cwd right after so the TUI below runs
  # in the user's directory. `$!` is the daemon's pid, which stop_server
  # needs (do not wrap this in a subshell).
  cd "$DIR"
  if command -v setsid >/dev/null 2>&1; then
    # Linux: new session, fully detached from this terminal.
    GROK_LEADER_SOCKET="$SOCKET" TSX_TSCONFIG_PATH="$DSH_ROOT/tsconfig.json" \
      setsid node --import "$DSH_ROOT/node_modules/tsx/dist/esm/index.mjs" scripts/serve-real.ts >>"$LOG" 2>&1 &
  else
    # macOS (no setsid): nohup keeps the daemon alive after the wrapper exits.
    GROK_LEADER_SOCKET="$SOCKET" TSX_TSCONFIG_PATH="$DSH_ROOT/tsconfig.json" \
      nohup node --import "$DSH_ROOT/node_modules/tsx/dist/esm/index.mjs" scripts/serve-real.ts >>"$LOG" 2>&1 &
  fi
  echo $! >"$PIDFILE"
  cd "$USER_CWD"
  for _ in $(seq 1 150); do
    if ! kill -0 "$(cat "$PIDFILE" 2>/dev/null || echo 0)" 2>/dev/null; then
      echo "error: backend exited early; tail of $LOG:" >&2
      tail -20 "$LOG" >&2
      rm -f "$PIDFILE"
      exit 1
    fi
    [[ -S "$SOCKET" ]] && return 0
    sleep 0.2
  done
  echo "error: backend did not create $SOCKET in time; tail of $LOG:" >&2
  tail -20 "$LOG" >&2
  exit 1
}

stop_server() {
  local pid
  if pid="$(server_pid)"; then
    echo "stopping backend (pid $pid)"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 25); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  else
    echo "backend not running"
  fi
  rm -f "$PIDFILE" "$SOCKET"
}

# This window owns its standalone backend: stopping it on TUI exit
# (Ctrl+C, /exit, crash). Host-bridge mode starts no backend.
tui_exit() {
  if [[ "${1:-}" == "status" ]]; then
    if found="$(host_socket_find)"; then
      echo "official host bridge: RUNNING (leader socket $found)"
    else
      echo "official host bridge: not running (no bridge handshake at $(host_socket_candidates | paste -sd ' ' -))"
    fi
    if pid="$(server_pid)"; then
      echo "standalone backend: running (pid $pid, socket $SOCKET)"
      echo "  WARNING: do not run a standalone backend while the official host is up —"
      echo "  two writers on one session store resurrect the seq-gap corruption."
      echo "logs: $LOG"
    else
      echo "standalone backend: not running"
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
    stop_server
  fi
}

if [[ "${1:-}" == "stop" ]]; then
  echo "stopping all standalone grok-dsh backends"
  pkill -f "serve-real.ts" 2>/dev/null || true
  sleep 1
  rm -f /tmp/dsh-grok-*.sock /tmp/dsh-grok-*.pid /tmp/dsh-grok-*.log
  echo "note: the official host (if any) is managed by 'dsh web', not by this command"
  exit 0
fi
if [[ "${1:-}" == "status" ]]; then
  tui_exit status
  echo "dsh checkout: ${DSH_ROOT:-<unresolved: $DSH_CURRENT>}"
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
if [[ "${1:-}" == "restart" ]]; then
  stop_server
fi

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

if [[ ! -x "$GROK_BIN" ]]; then
  echo "error: no grok TUI binary found (GROK_BIN=${GROK_BIN:-<unset>})." >&2
  echo "  Install the official binary:  curl -fsSL https://x.ai/cli/install.sh | bash" >&2
  echo "  or set GROK_BIN=/path/to/xai-grok-pager (source-built, with status bar)." >&2
  exit 1
fi

echo "grok binary: $("$GROK_BIN" --version 2>/dev/null | head -1)"
echo "working directory: $USER_CWD"

# Official host bridge first: the host's leader socket owns the session
# store, and connecting to it makes this TUI a peer of the browser tabs
# (one live agent per session — no seq gaps possible).
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

# Fallback: standalone backend for this window. CONFIRM first: starting a
# standalone backend is the two-writer-risk path (never run it alongside
# `dsh web`), so require an explicit y instead of silently opening the TUI.
echo "WARNING: no official host bridge at $(host_socket_candidates | paste -sd ' ' -) — starting a standalone backend."
echo "  Do NOT start 'dsh web' while this backend is running: two writers on one"
echo "  session store would resurrect the seq-gap corruption."
echo "  (prefer starting 'dsh web' first and re-running grok-dsh for the bridge)"
if ! { [[ -t 0 ]] && read -r -p "Start the standalone backend and open the TUI? [y/N] " _answer; } || [[ "${_answer:-}" != "y" && "${_answer:-}" != "Y" && "${_answer:-}" != "yes" && "${_answer:-}" != "YES" ]]; then
  echo "aborted — nothing started. Start 'dsh web' and re-run grok-dsh for the bridge."
  exit 0
fi
start_server
trap tui_exit EXIT
echo "TUI open — closing it (Ctrl+C or /exit) stops THIS window's backend"
start_usage_panel
start_herdr_watcher
(cd "$USER_CWD" && GROK_LEADER_SOCKET="$SOCKET" "$GROK_BIN" --leader)
