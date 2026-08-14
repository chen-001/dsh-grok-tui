#!/bin/sh
# dsh-grok-tui one-line installer — the grok TUI as a pure frontend for
# DeepSeek Harness (dsh).
#
#   curl -fsSL https://raw.githubusercontent.com/chen-001/dsh-grok-tui/main/install.sh | sh
#
# Prerequisites (checked, not installed):
#   - git, Node ^22.19.0 || >=24.0.0, npm (ships with Node)
#   - dsh (DeepSeek Harness) ALREADY INSTALLED — this installer assumes it
#     and never installs dsh itself
#   - the grok TUI binary (checked and prompted for; install with):
#       curl -fsSL https://x.ai/cli/install.sh | bash
#
# What it does:
#   1. Clones this repository into a STABLE plugin directory, default
#      ~/.dsh/dsh-grok-tui (GROK_DIR) — INDEPENDENT of the dsh checkout, so
#      upgrading dsh never orphans the plugin. The server imports
#      @deepseek-ai/* (unpublished workspace packages) and cordis at runtime;
#      every `grok-dsh` launch resolves them through the ACTIVE dsh checkout's
#      tsconfig paths via the tsx ESM hook (the same mechanism the dsh
#      launcher uses), so the backend always follows the currently installed
#      dsh — no re-install after dsh upgrades.
#      When run from an existing checkout (`git clone ... && cd dsh-grok-tui
#      && sh install.sh`), the checkout is MOVED into the stable plugin dir
#      first, so a clone-and-install works from anywhere. An install left
#      behind in an old dsh checkout (<dsh source>/current/plugins/
#      dsh-grok-tui) is migrated to the stable dir.
#   2. Installs npm dependencies. The postinstall no longer requires
#      DSH_PATH: it skips tsconfig.json generation unless DSH_PATH is set
#      (the runtime runs from source via tsx and never needs tsconfig.json;
#      only dev build/typecheck do, and they pass DSH_PATH).
#   2b. Builds the plugin bundle (dist/index.js) for the official host
#       bridge — the web profile (step 3b) needs this artifact and the
#       profile is NOT written unless the build succeeds.
#   3. Writes a `grok-dsh` launcher into your PATH bin dir that runs
#      scripts/grok-dsh.sh (auto-selects: official-host bridge when `dsh web`
#      is running, else a per-window backend daemon + grok TUI).
#   3b. Wires the bridge into the dsh WEB profile (~/.dsh/profiles/web):
#      idempotently adds the grok-server row to cordis.patch.yml and links
#      the plugin into the profile's node_modules, so `dsh web` carries the
#      grok leader socket with no extra flags. The TUI then connects to the
#      OFFICIAL host as a peer client (see README "官方 host 桥接模式").
#
# Afterwards, typing `grok-dsh` in any terminal opens the grok TUI backed by
# this machine's dsh. grok-dsh is BRIDGE-ONLY (since v0.5.0): `dsh web` must
# be running with the bridge (this installer wired it into the web profile),
# and grok-dsh connects the TUI straight to the host — peer of the browser
# tabs, sharing one live agent per session. Without a running host, grok-dsh
# fails with instructions instead of starting a backend:
#          grok-dsh           open the TUI (requires a running `dsh web`)
#          grok-dsh status    host bridge status, grok version
#          grok-dsh setup     wire the bridge into the web profile (idempotent)
#
# Re-running this installer updates the plugin (git fetch + reset to GROK_REF).
# dsh upgrades need nothing: each grok-dsh launch links the current checkout.
#
# Overridable via environment:
#   GROK_DSH_REPO    clone URL of the dsh-grok-tui repository  (no default — set it)
#   GROK_REF         branch or tag to check out                 (default: main)
#   GROK_DIR         stable plugin directory                    (default: ~/.dsh/dsh-grok-tui)
#   DSH_SOURCE       dsh source container                       (default: ~/.dsh/source)
#   DSH_CURRENT      stable symlink to the active checkout      (default: $DSH_SOURCE/current)
#   DSH_HOME         Harness home holding .env and config       (default: ~/.dsh)
#   DSH_BIN_DIR      directory the `grok-dsh` launcher lands in (default: ~/.local/bin)
set -eu

GROK_DSH_REPO=${GROK_DSH_REPO:-https://github.com/chen-001/dsh-grok-tui.git}
GROK_REF=${GROK_REF:-main}
DSH_SOURCE=${DSH_SOURCE:-$HOME/.dsh/source}
DSH_CURRENT=${DSH_CURRENT:-$DSH_SOURCE/current}
DSH_HOME=${DSH_HOME:-$HOME/.dsh}
DSH_BIN_DIR=${DSH_BIN_DIR:-$HOME/.local/bin}
GROK_INSTALLER_URL=${GROK_INSTALLER_URL:-https://x.ai/cli/install.sh}

# --- usage -------------------------------------------------------------------
case "${1:-}" in
  --build-grok) GROK_BUILD=1; shift ;;
esac
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat <<'EOF'
dsh-grok-tui installer

Usage:
  sh install.sh                 install or update dsh-grok-tui
  sh install.sh --build-grok    also build the grok TUI from source (full status bar)
  sh install.sh --help          this message

After installation, open the grok TUI with:  grok-dsh
(grok-dsh is bridge-only: start `dsh web` first, then run grok-dsh to
connect the TUI to the host. Without a running host, grok-dsh fails with
instructions instead of starting a backend.)

The source build (~15-30 min, needs Rust) is prompted for during install and
can be skipped; it is required for the dsh status bar (cache %, tokens).
Skip non-interactively with GROK_BUILD=0.
EOF
  exit 0
fi

# --- path helpers ------------------------------------------------------------
resolve_dir() { CDPATH= cd -- "$1" 2>/dev/null && pwd -P || printf '%s\n' "$1"; }

# --- in-repo detection -------------------------------------------------------
# Under `curl ... | sh` the script arrives on stdin, so $0 is not a file and
# this check fails closed. From a checked-out copy, adopt that checkout
# instead of cloning (mirrors the dsh installer's adoption mode). Either way
# the plugin ends up in the STABLE GROK_DIR, independent of the dsh checkout.
IN_REPO=0
GROK_DIR=${GROK_DIR:-$DSH_HOME/dsh-grok-tui}
CHECKOUT_DIR=''
if [ -f "$0" ]; then
  _self_dir=$(resolve_dir "$(dirname -- "$0")")
  if [ -f "$_self_dir/scripts/grok-dsh.sh" ] && [ -f "$_self_dir/package.json" ]; then
    IN_REPO=1
    CHECKOUT_DIR=$_self_dir
  fi
fi

# --- terminal-aware prompting ------------------------------------------------
if { true </dev/tty; } 2>/dev/null; then
  HAS_TTY=1
  trap 'stty echo </dev/tty 2>/dev/null || true' EXIT
  trap 'stty echo </dev/tty 2>/dev/null || true; exit 130' INT TERM HUP
else
  HAS_TTY=0
fi

if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); RED=$(printf '\033[31m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RST=$(printf '\033[0m')
else
  B=''; DIM=''; RED=''; GRN=''; YEL=''; RST=''
fi

info()  { printf '%s==>%s %s\n' "$GRN" "$RST" "$1"; }
step()  { printf '\n%s==>%s %s%s%s\n' "$GRN" "$RST" "$B" "$1" "$RST"; }
warn()  { printf '%s warn%s %s\n' "$YEL" "$RST" "$1" >&2; }
die()   { printf '%serror%s %s\n' "$RED" "$RST" "$1" >&2; exit 1; }

confirm() {
  _def=${2:-N}
  if [ "$HAS_TTY" != 1 ]; then
    [ "$_def" = Y ]
    return
  fi
  if [ "$_def" = Y ]; then _hint='[Y/n]'; else _hint='[y/N]'; fi
  printf '%s%s%s %s ' "$B" "$1" "$RST" "$_hint" >/dev/tty
  IFS= read -r _r </dev/tty || _r=''
  [ -n "$_r" ] || _r=$_def
  case "$_r" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

printf '%s\n' "${B}dsh-grok-tui — grok TUI over DeepSeek Harness${RST}"
case "$GROK_DSH_REPO" in
  *YOUR-GITHUB-USERNAME*)
    die "GROK_DSH_REPO is still the placeholder. Set your repository URL, e.g.:
    GROK_DSH_REPO=https://github.com/<you>/dsh-grok-tui.git sh install.sh
(or edit the default at the top of install.sh before pushing it)." ;;
esac
# The raw one-liner URL for re-install instructions, derived from the clone URL.
_raw=${GROK_DSH_REPO%.git}
case "$_raw" in
  https://github.com/*|http://github.com/*)
    RAW_INSTALLER="https://raw.githubusercontent.com/${_raw#*github.com/}/$GROK_REF/install.sh" ;;
  *) RAW_INSTALLER="<your dsh-grok-tui install.sh URL>" ;;
esac
if [ "$IN_REPO" = 1 ]; then
  printf '%scheckout %s%s\n' "$DIM" "$CHECKOUT_DIR" "$RST"
  printf '%splugin dir %s%s\n' "$DIM" "$GROK_DIR" "$RST"
else
  printf '%srepo %s @ %s%s\n' "$DIM" "$GROK_DSH_REPO" "$GROK_REF" "$RST"
  printf '%splugin dir %s%s\n' "$DIM" "$GROK_DIR" "$RST"
fi

# --- 1. dependency check -----------------------------------------------------
step "Checking dependencies"

command -v git >/dev/null 2>&1 || die "git is required but not found. Install git, then re-run."
info "git ... ok"

command -v npm >/dev/null 2>&1 || die "npm is required but not found (it ships with Node.js). Install Node, then re-run."
info "npm ... ok"

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  _v=$(node -v 2>/dev/null) || return 1
  _v=${_v#v}
  _major=${_v%%.*}
  _rest=${_v#*.}
  _minor=${_rest%%.*}
  case "$_major" in ''|*[!0-9]*) return 1 ;; esac
  case "$_minor" in ''|*[!0-9]*) _minor=0 ;; esac
  [ "$_major" -ge 24 ] && return 0
  [ "$_major" -eq 22 ] && [ "$_minor" -ge 19 ] && return 0
  return 1
}
if node_ok; then
  info "node $(node -v) ... ok"
else
  if command -v node >/dev/null 2>&1; then
    die "Node $(node -v) is unsupported. dsh needs ^22.19.0 || >=24.0.0 — upgrade Node, then re-run."
  fi
  die "Node is required but not found. Install Node ^22.19.0 || >=24, then re-run."
fi

# dsh must already be installed: the server runs inside the dsh ecosystem and
# resolves @deepseek-ai/* and cordis from the active checkout's node_modules.
DSH=''
if command -v dsh >/dev/null 2>&1; then
  DSH=$(command -v dsh)
elif [ -x "$DSH_CURRENT/bin/dsh" ]; then
  DSH=$DSH_CURRENT/bin/dsh
fi
if [ -z "$DSH" ]; then
  die "dsh is required but not found. Install DeepSeek Harness (dsh) first, then re-run this installer."
fi
info "dsh ... $DSH"
[ -x "$DSH_CURRENT/bin/dsh" ] || warn "expected active checkout at $DSH_CURRENT/bin/dsh — $DSH may point elsewhere"

# --- 2. resolve the plugin source -------------------------------------------
# The plugin lives in the STABLE GROK_DIR (default ~/.dsh/dsh-grok-tui),
# outside the dsh checkout; see the header for why.
if [ "$IN_REPO" = 1 ]; then
  step "Using existing dsh-grok-tui checkout at $CHECKOUT_DIR"
  if [ "$CHECKOUT_DIR" = "$GROK_DIR" ]; then
    info "checkout is already at the stable plugin dir"
  elif [ -e "$GROK_DIR" ]; then
    die "$GROK_DIR already exists. Remove it (or set GROK_DIR elsewhere) and re-run."
  else
    warn "moving the checkout to the stable plugin dir:"
    printf '    %s\n' "$GROK_DIR"
    mkdir -p "$(dirname -- "$GROK_DIR")"
    mv "$CHECKOUT_DIR" "$GROK_DIR"
  fi
  info "plugin dir: $GROK_DIR"
else
  step "Fetching dsh-grok-tui into $GROK_DIR"
  # Migrate an install left behind in an old dsh checkout (pre-stable-dir
  # layout): move it instead of cloning, so deps and history carry over.
  _old="$DSH_CURRENT/plugins/dsh-grok-tui"
  if [ ! -e "$GROK_DIR" ] && [ -d "$_old/.git" ]; then
    info "migrating existing install from $DSH_CURRENT/plugins/dsh-grok-tui"
    mkdir -p "$(dirname -- "$GROK_DIR")"
    mv "$_old" "$GROK_DIR"
  fi
  if [ -e "$GROK_DIR" ] && [ ! -d "$GROK_DIR/.git" ]; then
    die "$GROK_DIR exists but is not a git clone. Remove it (or set GROK_DIR elsewhere) and re-run."
  fi
  if [ -d "$GROK_DIR/.git" ]; then
    info "existing clone found — updating"
    git -C "$GROK_DIR" fetch origin "$GROK_REF" \
      || die "could not fetch ref '$GROK_REF' from $GROK_DSH_REPO (is the branch/tag name right? set GROK_REF to override)."
    git -C "$GROK_DIR" checkout -q -B "$GROK_REF" FETCH_HEAD
  else
    mkdir -p "$(dirname -- "$GROK_DIR")"
    if ! git clone --branch "$GROK_REF" "$GROK_DSH_REPO" "$GROK_DIR" 2>/dev/null; then
      info "branch/tag '$GROK_REF' not found — cloning the default branch"
      git clone "$GROK_DSH_REPO" "$GROK_DIR"
    fi
  fi
fi

# --- 3. verify the repository layout ----------------------------------------
step "Verifying repository layout"
[ -f "$GROK_DIR/scripts/grok-dsh.sh" ] || die "scripts/grok-dsh.sh is missing in $GROK_DIR — is this the right repository?"
[ -f "$GROK_DIR/package.json" ] || die "package.json is missing in $GROK_DIR — is this the right repository?"
info "layout ... ok"

# --- 4. runtime dependencies -------------------------------------------------
# Plain npm install: the postinstall now SKIPS tsconfig.json generation when
# DSH_PATH is unset (runtime runs from source via tsx and never needs it).
# @deepseek-ai/* and cordis resolve at runtime from the ACTIVE dsh checkout:
# every grok-dsh launch runs the server through the checkout's tsx hook with
# TSX_TSCONFIG_PATH set to the checkout's tsconfig.json (the same mechanism
# the dsh launcher uses), so they never come from the registry.
step "Installing dsh-grok-tui dependencies (npm)"
if [ ! -d "$GROK_DIR/node_modules" ] || [ ! -f "$GROK_DIR/node_modules/@agentclientprotocol/sdk/package.json" ]; then
  ( cd "$GROK_DIR" && npm install --no-audit --no-fund ) \
    || die "could not install dsh-grok-tui dependencies. Check the network / npm registry, then re-run."
fi
info "dependencies ... ok"

# --- 5. grok TUI binary ------------------------------------------------------
step "Checking the grok TUI binary"
GROK_FOUND=''
if command -v grok >/dev/null 2>&1; then
  GROK_FOUND=$(command -v grok)
elif [ -x "$HOME/.grok/bin/grok" ]; then
  GROK_FOUND="$HOME/.grok/bin/grok"
fi
if [ -z "$GROK_FOUND" ]; then
  warn "no grok TUI binary found on PATH or ~/.grok/bin."
  if [ "$HAS_TTY" = 1 ] && confirm "Install the official grok binary now?" Y; then
    command -v curl >/dev/null 2>&1 || die "curl is required to install the grok binary."
    curl -fsSL "$GROK_INSTALLER_URL" | bash
    if [ -x "$HOME/.grok/bin/grok" ]; then GROK_FOUND="$HOME/.grok/bin/grok"; fi
  fi
fi
if [ -n "$GROK_FOUND" ]; then
  info "grok ... $GROK_FOUND"
else
  warn "proceeding without it — install later with:  curl -fsSL $GROK_INSTALLER_URL | bash"
  warn "or set GROK_BIN=/path/to/xai-grok-pager (source-built, with status bar)."
fi

# --- 5b. source-built pager (full status bar) --------------------------------
# The official grok binary predates the dsh status-bar meta (dshUsage,
# totalContextTokens), so the top-right status items (cache %, tokens, API
# calls, tool time) require the pager built from grok-build + the dsh patch
# (scripts/build-grok-pager.sh). Offered here; skip with GROK_BUILD=0 or n.
GROK_PAGER="$GROK_DIR/../grok-build/target/debug/xai-grok-pager"
if [ -x "$GROK_PAGER" ]; then
  info "source-built pager ... $GROK_PAGER"
else
  case "${GROK_BUILD:-}" in
    0|no|false) : ;;
    *)
      step "Building the grok TUI from source (full status bar)"
      if [ "$HAS_TTY" != 1 ] && [ "${GROK_BUILD:-}" != 1 ] && [ "${GROK_BUILD:-}" != yes ]; then
        warn "non-interactive run — skipping the source build (set GROK_BUILD=1 to force)."
        warn "build later with:  sh $GROK_DIR/scripts/build-grok-pager.sh"
      elif confirm "Build the grok TUI from source now? (~15-30 min, needs Rust; n to skip)" Y; then
        if command -v cargo >/dev/null 2>&1; then
          info "building (logs: $GROK_DIR/../grok-build/dsh-build.log)"
          if sh "$GROK_DIR/scripts/build-grok-pager.sh"; then
            info "source-built pager ready — grok-dsh will use it for the full status bar."
          else
            warn "source build failed — the official grok binary will be used (no custom status bar)."
          fi
        else
          warn "cargo (Rust toolchain) not found — skipping the source build."
          warn "Install Rust (https://rustup.rs), then:  sh $GROK_DIR/scripts/build-grok-pager.sh"
        fi
      else
        info "skipped — build later with:  sh $GROK_DIR/scripts/build-grok-pager.sh"
      fi
      ;;
  esac
fi

# --- 5c. Build the plugin (dist/index.js is required by the host bridge) ------
# The profile hookup (step 6b) links the plugin into the web profile's
# node_modules; `dsh web` loads it via package.json exports → ./dist/index.js,
# so dist must exist before the profile is written.
step "Building the plugin for the host bridge"
if ! ( cd "$GROK_DIR" && DSH_PATH="$DSH_CURRENT" npm run build ); then
  die "could not build dist/index.js — make sure DSH_CURRENT ($DSH_CURRENT) points to a valid dsh checkout, then re-run."
fi
if [ ! -f "$GROK_DIR/dist/index.js" ]; then
  die "build completed but $GROK_DIR/dist/index.js is missing — check the build output above."
fi
info "dist/index.js ... ok"

# --- 6. launcher -------------------------------------------------------------
step "Linking grok-dsh into $DSH_BIN_DIR"
mkdir -p "$DSH_BIN_DIR"
LAUNCHER="$DSH_BIN_DIR/grok-dsh"
cat >"$LAUNCHER" <<EOF
#!/bin/sh
# grok-dsh launcher — dsh-grok-tui (grok TUI over DeepSeek Harness).
# Installed by $GROK_DIR/install.sh. Re-run that installer to update the plugin.
set -eu
PLUGIN_DIR='$GROK_DIR'
if [ ! -f "\$PLUGIN_DIR/scripts/grok-dsh.sh" ]; then
  echo "dsh-grok-tui is not installed here: \$PLUGIN_DIR is missing." >&2
  echo "Re-run the installer:" >&2
  echo "  curl -fsSL $RAW_INSTALLER | sh" >&2
  exit 1
fi
exec "\$PLUGIN_DIR/scripts/grok-dsh.sh" "\$@"
EOF
chmod +x "$LAUNCHER"
info "linked $LAUNCHER"

case ":$PATH:" in
  *":$DSH_BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0 ;;
esac
if [ "$ON_PATH" = 0 ]; then
  warn "$DSH_BIN_DIR is not on your PATH."
  _line="export PATH=\"$DSH_BIN_DIR:\$PATH\""
  _rc=''
  _sh=${SHELL:-}
  case "${_sh##*/}" in
    zsh)  _rc="$HOME/.zshrc" ;;
    bash) _rc="$HOME/.bashrc" ;;
  esac
  if [ -n "$_rc" ] && [ -f "$_rc" ] && grep -qF "$_line" "$_rc" 2>/dev/null; then
    info "$_rc already exports $DSH_BIN_DIR — open a new shell to pick it up"
  elif [ -n "$_rc" ] && confirm "Add it to $_rc?" Y; then
    printf '\n# Added by the dsh-grok-tui installer\n%s\n' "$_line" >>"$_rc"
    info "updated $_rc — run 'source $_rc' or open a new shell to pick it up"
  else
    warn "add this line to your shell profile yourself:"
    printf '    %s\n' "$_line"
  fi
fi

# --- 6b. official-host bridge profile hookup ---------------------------------
# Wire the plugin into the web profile so `dsh web` carries the grok bridge
# with no extra flags: the grok TUI then connects to the OFFICIAL host as a
# peer client (browser tabs and grok windows share one live agent per
# session — no interleaved session logs). This is the ONLY deployment shape
# since v0.5.0 (no standalone backend).
# (scripts/install-profile.mjs is idempotent and never clobbers user rows.)
step "Wiring the grok bridge into the dsh web profile"
if command -v node >/dev/null 2>&1; then
  node "$GROK_DIR/scripts/install-profile.mjs" \
    --plugin-dir "$GROK_DIR" --dsh-home "$DSH_HOME" --checkout "$DSH_CURRENT" \
    || warn "profile hookup failed — load the bridge manually with:  dsh web --patch $GROK_DIR/grok-server.yml"
else
  warn "node missing — profile hookup skipped; load the bridge with:  dsh web --patch $GROK_DIR/grok-server.yml"
fi

# --- 6c. herdr sidebar rows (usage metrics under the grok agent) -------------
# herdr (terminal agent multiplexer): when grok-dsh runs inside a herdr pane,
# the usage watcher pushes cache % / TTFT / TPS / token counts into herdr's
# pane.report_metadata, rendered by the sidebar's Custom tokens. Declare those
# rows in ~/.config/herdr/config.toml so the metrics actually show up.
# (scripts/install-herdr-config.py is idempotent: appends the section when
# absent, merges into an existing rows array, never clobbers user rows.)
step "Adding usage metrics to the herdr sidebar"
if [ -f "$GROK_DIR/scripts/install-herdr-config.py" ] && command -v python3 >/dev/null 2>&1; then
  python3 "$GROK_DIR/scripts/install-herdr-config.py" \
    || warn "herdr sidebar config skipped — add the [ui.sidebar.agents] rows manually (see README 'herdr 适配')"
else
  warn "python3 missing — herdr sidebar config skipped (see README 'herdr 适配')"
fi

# --- 7. done -----------------------------------------------------------------
step "Done"
info "dsh-grok-tui is installed. grok-dsh is BRIDGE-ONLY:"
info "  1. start the official host:  dsh web"
info "  2. open the TUI:             grok-dsh"
info "  grok-dsh status | setup   — host bridge status / profile hookup"
info "Model/effort: DSH_GROK_MODEL=deepseek-v4-flash DSH_GROK_EFFORT=high grok-dsh"
info "dsh upgrades need nothing — every grok-dsh launch links the current dsh."
info "Re-run this installer only to update dsh-grok-tui itself."
