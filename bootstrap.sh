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
#   1. prerequisites   — honest check (go, elixir/OTP, node, tmux; jq optional)
#   2. felt CLI        — go install . → ~/.local/bin/felt (the daemon shells to it)
#   3. daemon escript  — mix deps.get + escript build → bin/shuttle
#   4. ui/dist         — the served kanban board (built with npm; rsync'd to hosts without Node)
#   5. event stream    — the plugin hook (`felt hook event`) the daemon reads
#   6. keep-alive      — launchd LaunchAgent (macOS) / systemd user unit (Linux),
#                        falling back to the shuttle-daemon tmux respawn loop
#
# `felt shuttle install <fiber>` already means "install a fiber as a dispatch
# role", so the system bootstrap deliberately is NOT that verb. It is reached
# via `make install` (which runs this script) or `./bootstrap.sh` directly.
#
# Usage:
#   ./bootstrap.sh                 full bootstrap for this host
#   ./bootstrap.sh --dry-run       check prerequisites + print the plan, change nothing
#   ./bootstrap.sh --skip-ui       don't build ui/dist (default when Node isn't on PATH — rsync it instead)
#   ./bootstrap.sh --build-ui      force the ui/dist build (default when Node is on PATH)
#   ./bootstrap.sh --skip-hook     don't touch the event-stream step
#   ./bootstrap.sh --skip-cli      don't (re)build/install the felt CLI (it's already on PATH)
#   ./bootstrap.sh --with-tunnels  also (re)install the autossh tunnels to remotes (macOS hub)
#   ./bootstrap.sh -h | --help     this help

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OS="$(uname -s)"
CLI_INSTALL_DIR="${FELT_INSTALL_DIR:-$HOME/.local/bin}"
have() { command -v "$1" >/dev/null 2>&1; }

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

# Resolve UI default: build it here if Node is on PATH, else skip (rsync
# ui/dist from a host that has Node — see AGENTS.md). npm run build needs no
# private checkout; the ambient src/paper/lightcone.d.ts declarations satisfy
# its typecheck and the Vite build drops the paper entry when the optional
# lightcone-ui renderer source isn't present.
if [ "$UI_MODE" = auto ]; then
  have node && have npm && UI_MODE=build || UI_MODE=skip
fi

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
        "install Erlang/OTP 27+ and Elixir 1.19+ (brew install elixir / asdf)."
require "escript"     escript "the daemon is an escript; needs Erlang/OTP on PATH." \
        "comes with Erlang/OTP."
require "tmux"        tmux    "workers run in tmux, as does the Linux respawn-loop keep-alive." \
        "brew install tmux  /  apt install tmux."
if [ "$SKIP_CLI" = 1 ]; then
  require "felt"      felt    "the daemon shells out to felt for every store walk." \
          "drop --skip-cli to build it from this checkout, or put it on PATH (~/.local/bin)."
fi

if [ "$UI_MODE" = build ]; then
  require "node"  node "needed to build the served ui/dist board." "install Node 22+ (brew install node / nvm)."
  require "npm"   npm  "needed to build the served ui/dist board." "ships with Node."
fi

# jq is a nicety now, not a dependency: the event stream is written by the felt
# binary, and the SessionStart hook falls back to `felt hook session` when jq is
# absent. It only pretty-prints the SessionStart envelope.
optional "jq" jq "only used to pretty-print the SessionStart envelope; session.sh falls back to \`felt hook session\`." \
         "brew install jq  /  apt install jq."

# ── plan / dry-run ───────────────────────────────────────────────────────
have_systemd_user() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

keepalive_desc() {
  if [ "$OS" = Darwin ]; then echo "launchd LaunchAgent (make install-agent: build + render plist + load)"
  elif have_systemd_user; then echo "systemd user unit (make install-agent: render + enable --now shuttle-daemon.service)"
  else echo "shuttle-daemon respawn loop (tmux: while true; ./bin/shuttle start) — no systemd user session here"; fi
}
ui_desc() {
  case "$UI_MODE" in
    build) echo "cd ui && npm run build  → ui/dist" ;;
    skip)  echo "SKIP (rsync ui/dist from a host with Node — see AGENTS.md)" ;;
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
  note "5. events   : $([ "$SKIP_HOOK" = 1 ] && echo SKIP || echo 'felt setup claude/codex (plugin hooks) + probe felt hook event')"
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
make -C "$REPO" daemon SKIP_CLI="$SKIP_CLI" || die "escript build failed."
ok "bin/shuttle built."

# Record the bootstrapped checkout in ~/.shuttle (alongside the daemon's other
# state: events.jsonl, tmux.sock). bin/shuttle-launch resolves its repo as
# $SHUTTLE_DIR > ~/.shuttle/repo > script location, so this state file is what
# lets a bare `~/.local/bin/shuttle-launch` (remote revival — remote_registry.ex
# invoking it over SSH, no env) find this checkout.
mkdir -p "$HOME/.shuttle" \
  && printf '%s\n' "$REPO" > "$HOME/.shuttle/repo" \
  || die "failed to record checkout path in ~/.shuttle/repo."
ok "checkout recorded → ~/.shuttle/repo ($REPO)."

# ── 4. ui/dist ─────────────────────────────────────────────────────────────
step "UI bundle (ui/dist)"
if [ "$UI_MODE" = build ]; then
  ( cd "$REPO/ui" && { [ -d node_modules ] || npm ci || npm install; } && npm run build ) \
    && ok "ui/dist built." \
    || { warn "ui/dist build failed."
         note "build ui/dist on a host with Node and rsync it over:"
         note "  rsync -az --delete ui/dist/ <host>:$REPO/ui/dist/"; }
else
  if [ -d "$REPO/ui/dist" ]; then ok "ui/dist present (not rebuilt)."
  else warn "ui/dist absent and not built on this host."
       note "build it on a host with Node and rsync it over:  rsync -az --delete ui/dist/ <host>:$REPO/ui/dist/"; fi
fi

# ── 5. event stream ─────────────────────────────────────────────────────────
# The daemon derives per-session activity + the sent-files trail from this
# host's own hook stream (~/.shuttle/events.jsonl). The felt binary writes it
# (`felt hook event`) and the bundled plugin registers it, so this step is
# self-contained: install/refresh the plugin, then prove the writer works here.
#
# The plugin hook is gated on ~/.shuttle existing — step 3 created it, so the
# writer is already enabled on every bootstrapped host.
step "Event stream (plugin hook → ~/.shuttle/events.jsonl)"
if [ "$SKIP_HOOK" = 1 ]; then
  warn "skipped (--skip-hook)."
else
  FELT_BIN="$([ "$SKIP_CLI" = 1 ] && command -v felt || echo "$CLI_INSTALL_DIR/felt")"

  if [ -d "$HOME/.shuttle" ]; then
    ok "~/.shuttle present — the stream is enabled on this host."
  else
    warn "~/.shuttle missing; the hook writes nothing until it exists."
  fi

  # Register the plugin from THIS checkout so hooks and binary always match.
  # Both are idempotent; both need their harness CLI on PATH.
  for harness in claude codex; do
    if have "$harness"; then
      "$FELT_BIN" setup "$harness" --source "$REPO" >/dev/null 2>&1 \
        && ok "felt plugin registered for $harness." \
        || warn "felt setup $harness failed — run it by hand to see why."
    else
      note "$harness CLI not on PATH; skipping its plugin registration."
    fi
  done

  # Probe the writer end-to-end: no jq, no perl, no tmux required. An explicit
  # SHUTTLE_EVENTS_FILE overrides the directory gate, so this never touches the
  # real stream.
  # Explicit template, not `mktemp -t`: BSD mktemp appends XXXXXX to a -t
  # prefix, GNU mktemp requires the template to carry it and errors without.
  PROBE="$(mktemp "${TMPDIR:-/tmp}/shuttle-events-probe.XXXXXX")"
  printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"bootstrap-probe","cwd":"'"$REPO"'"}' \
    | SHUTTLE_EVENTS_FILE="$PROBE" SHUTTLE_EVENTS= "$FELT_BIN" hook event >/dev/null 2>&1
  if [ "$(wc -l < "$PROBE" | tr -d ' ')" = "1" ] && grep -q '"type":"session_start"' "$PROBE"; then
    ok "felt hook event writes a well-formed line on this host."
  else
    warn "felt hook event probe failed — activity ranking + sent-files will stay empty."
    note "reproduce:  echo '{\"hook_event_name\":\"SessionStart\"}' | SHUTTLE_EVENTS_FILE=/tmp/e.jsonl felt hook event"
  fi
  rm -f "$PROBE"

fi

# ── 6. keep-alive ───────────────────────────────────────────────────────────
# Both macOS and Linux get a real supervisor: launchd there, a systemd user
# unit here. The tmux respawn loop remains the honest fallback for a Linux host
# with no systemd user session — an HPC login node usually has none.
start_respawn_loop() {
  if tmux has-session -t shuttle-daemon 2>/dev/null; then
    ok "respawn loop already running (tmux session 'shuttle-daemon')."
    note "to cycle to the freshly-built escript, kill the :4000 listener — the loop respawns it:"
    note "  lsof -ti:4000 -sTCP:LISTEN | xargs kill"
    note "to also pick up a new shuttle-launch: SHUTTLE_DIR='$REPO' ~/.local/bin/shuttle-launch"
  else
    SHUTTLE_DIR="$REPO" "$HOME/.local/bin/shuttle-launch" \
      && ok "respawn loop started (tmux session 'shuttle-daemon')." \
      || die "failed to start respawn loop."
  fi
}

if [ "$OS" = Darwin ]; then KEEPALIVE_KIND=launchd
elif have_systemd_user; then KEEPALIVE_KIND=systemd
else KEEPALIVE_KIND="respawn loop"; fi
step "Keep-alive ($KEEPALIVE_KIND)"
if [ "$OS" = Darwin ]; then
  # The launchd path lives in the Makefile: it captures the real login PATH and
  # the persistent ssh-agent socket, renders the plist, and (re)loads the agent.
  # Reuse it rather than duplicating that subtle env capture here.
  make -C "$REPO" install-agent || die "make install-agent failed."
  ok "launchd agent loaded (KeepAlive + RunAtLoad)."
else
  # bin/shuttle-launch goes to ~/.local/bin on every Linux host regardless of
  # which supervisor wins: remote revival (remote_registry.ex invokes
  # ~/.local/bin/shuttle-launch over SSH) must always find a current copy.
  mkdir -p "$HOME/.local/bin"
  cp "$REPO/bin/shuttle-launch" "$HOME/.local/bin/shuttle-launch" \
    && chmod +x "$HOME/.local/bin/shuttle-launch" \
    || die "failed to install shuttle-launch to ~/.local/bin."
  ok "shuttle-launch installed to ~/.local/bin."

  if have_systemd_user; then
    # Same Makefile target as macOS, systemd arm: it captures the login PATH
    # and renders share/io.shuttle.daemon.service.template. It needs
    # AGENT_FELT_STORES (make inherits it from this environment) — without one
    # it refuses, and the respawn loop is still a working keep-alive, so warn
    # and fall back rather than aborting a bootstrap that got this far.
    if make -C "$REPO" install-agent; then
      ok "systemd user unit enabled (Restart=always + starts at login)."
      note "survive logout and start at boot:  loginctl enable-linger $(id -un)"
    else
      warn "make install-agent failed (see above) — falling back to the tmux respawn loop."
      note "retry it with a store:  make install-agent AGENT_FELT_STORES=~/my-store"
      start_respawn_loop
    fi
  else
    warn "no systemd user session here; using the tmux respawn loop instead."
    note "systemd would give you Restart=always + start at boot; a login node often has neither."
    start_respawn_loop
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
