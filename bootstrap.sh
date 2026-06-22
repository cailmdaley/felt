#!/usr/bin/env bash
#
# felt + shuttle from-source bootstrap — stand up the full local surface on a
# fresh machine with a single command, branching by host type.
#
# This is the FLEET / dev installer: it builds everything from this checkout.
# (End users who only want the `felt` CLI use the release installer instead:
#  curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh)
#
# Composes what were separate manual steps into one bootstrap:
#
#   1. prerequisites   — honest check (go, elixir/OTP, node, tmux, jq)
#   2. felt CLI        — go install . → ~/.local/bin/felt (the daemon shells to it)
#   3. daemon escript  — mix deps.get + escript build → bin/shuttle
#   4. ui/dist         — the served kanban board (built on macOS; rsync'd to clusters)
#   5. loom hook       — the Claude Code event stream the daemon reads
#   6. keep-alive      — launchd LaunchAgent (macOS) / shuttle-daemon respawn loop (clusters)
#
# `felt shuttle install <fiber>` already means "install a fiber as a dispatch
# role", so the system bootstrap deliberately is NOT that verb. It is reached
# via `make install` (which runs this script) or `./bootstrap.sh` directly.
#
# Usage:
#   ./bootstrap.sh                 full bootstrap for this host
#   ./bootstrap.sh --dry-run       check prerequisites + print the plan, change nothing
#   ./bootstrap.sh --skip-ui       don't build ui/dist (default on clusters — rsync it instead)
#   ./bootstrap.sh --build-ui      force the ui/dist build (default on macOS)
#   ./bootstrap.sh --skip-hook     don't touch the loom hook step
#   ./bootstrap.sh --skip-cli      don't (re)build/install the felt CLI (it's already on PATH)
#   ./bootstrap.sh --with-tunnels  also (re)install the autossh tunnels to remotes (macOS hub)
#   ./bootstrap.sh -h | --help     this help

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
CLI_INSTALL_DIR="${FELT_INSTALL_DIR:-$HOME/.local/bin}"

# ── presentation ─────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  RED=$'\033[31m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; BLUE=''; RESET=''
fi
step() { printf '\n%s▸ %s%s\n' "$BOLD$BLUE" "$1" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '  %s⚠%s %s\n' "$YELLOW" "$RESET" "$1"; }
bad()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
note() { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
die()  { printf '\n%s✗ %s%s\n' "$RED$BOLD" "$1" "$RESET" >&2; exit 1; }

# Print the leading comment block (the doc header), shebang stripped, `# ` peeled.
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0; }

# ── flags ────────────────────────────────────────────────────────────────
DRY_RUN=0; SKIP_HOOK=0; SKIP_CLI=0; WITH_TUNNELS=0
UI_MODE=auto   # auto | build | skip
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --skip-ui)      UI_MODE=skip ;;
    --build-ui)     UI_MODE=build ;;
    --skip-hook)    SKIP_HOOK=1 ;;
    --skip-cli)     SKIP_CLI=1 ;;
    --with-tunnels) WITH_TUNNELS=1 ;;
    -h|--help)      usage ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

# Resolve UI default by host: macOS builds it (the renderer deps resolve from a
# sibling lightcone-ui); the clusters cannot build it from a source-only clone,
# so the bundle is built once on a Mac and rsync'd over (see AGENTS.md).
if [ "$UI_MODE" = auto ]; then
  [ "$OS" = Darwin ] && UI_MODE=build || UI_MODE=skip
fi

have() { command -v "$1" >/dev/null 2>&1; }

printf '%s\n' "${BOLD}felt + shuttle bootstrap${RESET}  ${DIM}($OS · $REPO)${RESET}"

# ── 1. prerequisites ───────────────────────────────────────────────────────
# "Honest about prerequisites" — name what's missing AND how to get it, rather
# than failing opaquely deep in a build.
step "Prerequisites"
MISSING_REQUIRED=0
require() { # name, command, why, hint
  if have "$2"; then ok "$1 ($(command -v "$2"))"
  else bad "$1 — MISSING. $3"; note "$4"; MISSING_REQUIRED=1; fi
}
optional() { # name, command, why, hint
  if have "$2"; then ok "$1 ($(command -v "$2"))"
  else warn "$1 — missing. $3"; note "$4"; fi
}

if [ "$SKIP_CLI" = 0 ]; then
  require "go"        go      "needed to build the felt CLI (the daemon shells out to it)." \
          "install Go 1.23+ (brew install go / asdf)."
fi
require "elixir/mix"  mix     "needed to build the daemon escript." \
        "install Erlang/OTP 26+ and Elixir 1.16+ (brew install elixir / asdf)."
require "escript"     escript "the daemon is an escript; needs Erlang/OTP on PATH." \
        "comes with Erlang/OTP."
require "tmux"        tmux    "workers and the cluster respawn loop run in tmux." \
        "brew install tmux  /  apt install tmux."
if [ "$SKIP_CLI" = 1 ]; then
  require "felt"      felt    "the daemon shells out to felt for every store walk." \
          "drop --skip-cli to build it from this checkout, or put it on PATH (~/.local/bin)."
fi

if [ "$UI_MODE" = build ]; then
  require "node"  node "needed to build the served ui/dist board." "install Node 22+ (brew install node / nvm)."
  require "npm"   npm  "needed to build the served ui/dist board." "ships with Node."
fi

optional "jq" jq "the loom hook needs jq; without it activity-ranking + sent-files stay empty (board still serves)." \
         "brew install jq  /  apt install jq."

# ── plan / dry-run ───────────────────────────────────────────────────────
keepalive_desc() {
  if [ "$OS" = Darwin ]; then echo "launchd LaunchAgent (make install-agent: build + render plist + load)"
  else echo "shuttle-daemon respawn loop (tmux: while true; ./bin/shuttle start)"; fi
}
ui_desc() {
  case "$UI_MODE" in
    build) echo "cd ui && npm run build  → ui/dist" ;;
    skip)  echo "SKIP (rsync ui/dist from a macOS build host — see AGENTS.md)" ;;
  esac
}
cli_desc() {
  if [ "$SKIP_CLI" = 1 ]; then echo "SKIP (--skip-cli; felt already on PATH)"
  else echo "go install . → $CLI_INSTALL_DIR/felt"; fi
}

if [ "$DRY_RUN" = 1 ]; then
  step "Plan (dry-run — nothing will change)"
  note "2. felt CLI : $(cli_desc)"
  note "3. daemon   : mix deps.get && make daemon → bin/shuttle"
  note "4. ui/dist  : $(ui_desc)"
  note "5. loom hook: $([ "$SKIP_HOOK" = 1 ] && echo SKIP || echo 'detect registration; guide to ~/loom/setup.sh if absent')"
  note "6. keepalive: $(keepalive_desc)"
  [ "$WITH_TUNNELS" = 1 ] && note "+  tunnels  : felt shuttle tunnels install"
  if [ "$MISSING_REQUIRED" = 1 ]; then
    printf '\n%s✗ required prerequisites missing — install them before a real run.%s\n' "$RED$BOLD" "$RESET"; exit 1
  fi
  printf '\n%s✓ prerequisites satisfied; re-run without --dry-run to install.%s\n' "$GREEN$BOLD" "$RESET"; exit 0
fi

[ "$MISSING_REQUIRED" = 1 ] && die "required prerequisites missing (see above) — install them and re-run."

# ── 2. felt CLI ─────────────────────────────────────────────────────────────
# Build + install the CLI from THIS checkout — it's the source of truth now, and
# the daemon shells out to `felt` for every store walk. Installed to ~/.local/bin
# so the launchd plist's captured login PATH finds it at runtime.
step "felt CLI"
if [ "$SKIP_CLI" = 1 ]; then
  ok "skipped (--skip-cli); using felt at $(command -v felt)."
else
  ( cd "$REPO" && GOBIN="$CLI_INSTALL_DIR" go install . ) || die "go install . (felt CLI) failed."
  if "$CLI_INSTALL_DIR/felt" --version >/dev/null 2>&1; then
    ok "felt CLI installed → $CLI_INSTALL_DIR/felt ($("$CLI_INSTALL_DIR/felt" --version 2>/dev/null | head -1))."
  else
    ok "felt CLI installed → $CLI_INSTALL_DIR/felt."
  fi
  case ":${PATH}:" in
    *":${CLI_INSTALL_DIR}:"*) ;;
    *) warn "$CLI_INSTALL_DIR is not on your PATH."
       note "add it:  export PATH=\"$CLI_INSTALL_DIR:\$PATH\"  (the launchd daemon uses its own captured PATH)";;
  esac
fi

# ── 3. daemon escript ──────────────────────────────────────────────────────
step "Build the daemon escript"
( cd "$REPO" && mix deps.get ) || die "mix deps.get failed."
make -C "$REPO" daemon || die "escript build failed."
ok "bin/shuttle built."

# ── 4. ui/dist ─────────────────────────────────────────────────────────────
step "UI bundle (ui/dist)"
if [ "$UI_MODE" = build ]; then
  ( cd "$REPO/ui" && { [ -d node_modules ] || npm ci || npm install; } && npm run build ) \
    && ok "ui/dist built." \
    || { warn "ui/dist build failed."
         note "on a host without the lightcone-ui renderer deps, build ui/dist on a Mac and rsync it:"
         note "  rsync -az --delete ui/dist/ <host>:$REPO/ui/dist/"; }
else
  if [ -d "$REPO/ui/dist" ]; then ok "ui/dist present (not rebuilt)."
  else warn "ui/dist absent and not built on this host."
       note "build it on a Mac and rsync it over:  rsync -az --delete ui/dist/ <host>:$REPO/ui/dist/"; fi
fi

# ── 5. loom hook ────────────────────────────────────────────────────────────
# The daemon derives per-session activity + the sent-files trail from its OWN
# Claude Code hook stream (~/.shuttle/events.jsonl), fed by ~/loom/hooks/shuttle-hook.sh.
# That hook is registered by loom/setup.sh — loom owns it (the same script wires
# every loom→.claude link, plugins, felt skills). We do NOT re-run all of that
# or reimplement its settings.json merge here; we verify the dependency and
# point at the canonical registrar when it's missing.
step "Loom hook (event stream)"
if [ "$SKIP_HOOK" = 1 ]; then
  warn "skipped (--skip-hook)."
else
  SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$SETTINGS" ] && grep -q 'shuttle-hook.sh' "$SETTINGS" 2>/dev/null; then
    ok "shuttle-hook.sh registered in ~/.claude/settings.json."
  elif [ -x "$HOME/loom/setup.sh" ]; then
    warn "shuttle-hook.sh not registered yet."
    note "run loom's canonical setup to register it (wires the whole loom→.claude surface):"
    note "  ~/loom/setup.sh"
  else
    warn "~/loom not found — the event stream won't be fed."
    note "sync loom to ~/loom, then run ~/loom/setup.sh. Without it: no activity ranking /"
    note "sent-files trail (the board still serves)."
  fi
fi

# ── 6. keep-alive ───────────────────────────────────────────────────────────
step "Keep-alive ($([ "$OS" = Darwin ] && echo launchd || echo 'respawn loop'))"
if [ "$OS" = Darwin ]; then
  # The launchd path lives in the Makefile: it captures the real login PATH and
  # the persistent ssh-agent socket, renders the plist, and (re)loads the agent.
  # Reuse it rather than duplicating that subtle env capture here.
  make -C "$REPO" install-agent || die "make install-agent failed."
  ok "launchd agent loaded (KeepAlive + RunAtLoad)."
else
  # Clusters have no launchd; the durable surface is a respawn loop in a named
  # tmux session that re-execs the foreground daemon whenever it exits.
  # `start --force` matches the launchd path (plist) and is load-bearing here:
  # bare `start` HTTP-probes :4000 and halt(1)s if a daemon answers, so during
  # the documented "kill the :4000 listener to cycle" procedure it would
  # busy-respawn every 2s until the old listener dies. --force skips that guard
  # so a restart never refuses.
  if tmux has-session -t shuttle-daemon 2>/dev/null; then
    ok "respawn loop already running (tmux session 'shuttle-daemon')."
    note "to cycle to the freshly-built escript, kill the :4000 listener — the loop respawns it:"
    note "  lsof -ti:4000 -sTCP:LISTEN | xargs kill"
  else
    tmux new-session -d -s shuttle-daemon \
      "cd '$REPO' && while true; do ./bin/shuttle start --force; echo '[respawn] daemon exited; restarting in 2s'; sleep 2; done" \
      && ok "respawn loop started (tmux session 'shuttle-daemon')." \
      || die "failed to start respawn loop."
  fi
fi

# ── optional: remote tunnels (macOS hub) ─────────────────────────────────────
if [ "$WITH_TUNNELS" = 1 ]; then
  step "Remote tunnels"
  if [ "$OS" != Darwin ]; then
    warn "tunnels are installed on the macOS hub only; skipping on $OS."
  else
    felt shuttle tunnels install && ok "autossh tunnels (re)installed." \
      || warn "felt shuttle tunnels install failed (configure remotes first)."
  fi
fi

# ── footer ───────────────────────────────────────────────────────────────
step "Done"
note "verify:   curl -s http://127.0.0.1:4000/api/v1/version"
note "board:    http://127.0.0.1:4000/"
note "logs:     make logs"
note "workers:  felt shuttle ps"
[ "$WITH_TUNNELS" = 0 ] && [ "$OS" = Darwin ] && \
  note "remotes:  ./bootstrap.sh --with-tunnels  (or: felt shuttle tunnels install)"
