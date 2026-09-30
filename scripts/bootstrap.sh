#!/usr/bin/env bash
#
# felt + shuttle from-source bootstrap — stand up the full local surface on a
# fresh machine with a single command.
#
# This is the FLEET / dev installer: it builds everything from this checkout.
# End users can install both Go CLIs from a release instead:
#   curl -fsSL https://raw.githubusercontent.com/cailmdaley/felt/main/install.sh | sh
#
# Composes what were separate manual steps into one bootstrap:
#
#   1. prerequisites   — check (go, elixir/OTP, node, tmux; jq optional)
#   2. CLI pair        — make cli-install → ~/.local/bin/{felt,shuttle}
#   3. daemon release  — mix deps.get + mix release → bin/rel (launched by shuttle)
#   4. ui/dist         — the served kanban board (built locally with npm)
#   5. event stream    — the plugin hook (`shuttle hook event`) the daemon reads
#   6. keep-alive      — launchd LaunchAgent (macOS) / systemd user unit (Linux),
#                        falling back to the shuttle-daemon tmux respawn loop
#
# `shuttle install <fiber>` means "install a fiber as a dispatch role", so the
# system bootstrap deliberately is NOT that verb. It is reached via `make install`
# or `./scripts/bootstrap.sh` directly.
#
# Usage:
#   ./scripts/bootstrap.sh                 full bootstrap for this host
#   ./scripts/bootstrap.sh --dry-run       check prerequisites + print the plan, change nothing
#   ./scripts/bootstrap.sh --skip-hook     don't touch the event-stream step
#   ./scripts/bootstrap.sh --skip-cli      don't (re)build/install either CLI (both are already on PATH)
#   ./scripts/bootstrap.sh --with-tunnels  also (re)install the autossh tunnels to remotes (hub-side)
#   ./scripts/bootstrap.sh -h | --help     this help

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! shopt -q login_shell; then
  exec bash -l "$REPO/scripts/bootstrap.sh" "$@"
fi

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
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --skip-hook)    SKIP_HOOK=1 ;;
    --skip-cli)     SKIP_CLI=1 ;;
    --with-tunnels) WITH_TUNNELS=1 ;;
    -h|--help)      usage ;;
    *) die "unknown argument: $arg (try --help)" ;;
  esac
done

printf '%s\n' "${BOLD}felt + shuttle bootstrap${RESET}  ${DIM}($OS · $REPO)${RESET}"

# ── 1. prerequisites ───────────────────────────────────────────────────────
# Check prerequisites before changing the installation.
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
  require "go"        go      "needed to build both Go CLIs (felt and shuttle)." \
          "install the Go version declared in go.mod (brew install go / asdf)."
fi
require "elixir/mix"  mix     "needed to build the daemon release." \
        "install Erlang/OTP 28+ and Elixir 1.19+ (brew install elixir / asdf)."
require "tmux"        tmux    "workers run in tmux, as does the Linux respawn-loop keep-alive." \
        "brew install tmux  /  apt install tmux."
if [ "$SKIP_CLI" = 1 ]; then
  require "felt"    felt    "the daemon shells out to felt for fiber data." \
          "drop --skip-cli to build both CLIs from this checkout, or put felt on PATH."
  require "shuttle" shuttle "the daemon shells out to shuttle for orchestration." \
          "drop --skip-cli to build both CLIs from this checkout, or put shuttle on PATH."
fi

require "node"  node "needed to build the served ui/dist board." "install Node 22+ (brew install node / nvm)."
require "npm"   npm  "needed to build the served ui/dist board." "ships with Node."

# jq is a nicety, not a dependency: the SessionStart hook falls back to
# `felt hook session` when jq is absent. It only pretty-prints that envelope.
optional "jq" jq "only used to pretty-print the SessionStart envelope; session.sh falls back to \`felt hook session\`." \
         "brew install jq  /  apt install jq."

# ── plan / dry-run ───────────────────────────────────────────────────────
have_systemd_user() { have systemctl && systemctl --user show-environment >/dev/null 2>&1; }

keepalive_desc() {
  if [ "$OS" = Darwin ]; then echo "launchd LaunchAgent (make install-agent: build + render plist + load)"
  elif have_systemd_user; then echo "systemd user unit (make install-agent: render + enable --now shuttle-daemon.service)"
  else echo "shuttle-daemon respawn loop (tmux: while true; shuttle daemon start --force) — no systemd user session here"; fi
}
cli_desc() {
  if [ "$SKIP_CLI" = 1 ]; then echo "SKIP (--skip-cli; felt and shuttle already on PATH)"
  else echo "make cli-install → $CLI_INSTALL_DIR/{felt,shuttle}"; fi
}

if [ "$DRY_RUN" = 1 ]; then
  step "Plan (dry-run — nothing will change)"
  note "2. CLI pair : $(cli_desc)"
  note "3. daemon   : make daemon (fetch deps + build) → bin/rel (launched by shuttle)"
  note "4. ui/dist  : make ui (npm ci when the lockfile moved, then npm run build) → ui/dist"
  note "5. events   : $([ "$SKIP_HOOK" = 1 ] && echo SKIP || echo 'felt setup claude/codex (plugin hooks) + probe shuttle hook event')"
  note "6. keepalive: $(keepalive_desc)"
  [ "$WITH_TUNNELS" = 1 ] && note "+  tunnels  : shuttle tunnels install"
  if [ "$MISSING_REQUIRED" = 1 ]; then
    printf '\n%s✗ required prerequisites missing — install them before a real run.%s\n' "$RED$BOLD" "$RESET"; exit 1
  fi
  printf '\n%s✓ prerequisites satisfied; re-run without --dry-run to install.%s\n' "$GREEN$BOLD" "$RESET"; exit 0
fi

[ "$MISSING_REQUIRED" = 1 ] && die "required prerequisites missing (see above) — install them and re-run."

# ── 2. CLI pair ──────────────────────────────────────────────────────────────
# Build and install both CLIs from this checkout. The daemon needs felt for
# fiber data and shuttle for orchestration; both live in the same install dir.
step "felt + shuttle CLIs"
FELT_BIN=""
SHUTTLE_BIN=""
if [ "$SKIP_CLI" = 1 ]; then
  FELT_BIN="$(command -v felt)"
  SHUTTLE_BIN="$(command -v shuttle)"
  ok "skipped (--skip-cli); felt is at $FELT_BIN, shuttle at $SHUTTLE_BIN."
else
  mkdir -p "$CLI_INSTALL_DIR"
  make -C "$REPO" cli-install INSTALL_DIR="$CLI_INSTALL_DIR" || die "make cli-install failed."
  FELT_BIN="$CLI_INSTALL_DIR/felt"
  SHUTTLE_BIN="$CLI_INSTALL_DIR/shuttle"
  [ -x "$FELT_BIN" ] || die "felt was not installed to $FELT_BIN."
  [ -x "$SHUTTLE_BIN" ] || die "shuttle was not installed to $SHUTTLE_BIN."
  ok "felt installed → $FELT_BIN."
  ok "shuttle installed → $SHUTTLE_BIN."
  case ":${PATH}:" in
    *":${CLI_INSTALL_DIR}:"*) ;;
    *) warn "$CLI_INSTALL_DIR is not on your PATH."
       note "add it:  export PATH=\"$CLI_INSTALL_DIR:\$PATH\"  (the supervisor uses its own captured PATH)";;
  esac
fi

case ":${PATH}:" in
  *":${CLI_INSTALL_DIR}:"*) ;;
  *) PATH="$CLI_INSTALL_DIR:$PATH"; export PATH ;;
esac
"$FELT_BIN" --version >/dev/null 2>&1 || die "felt CLI is not runnable."
"$SHUTTLE_BIN" --version >/dev/null 2>&1 || die "shuttle CLI is not runnable."

# ── 3. daemon release ──────────────────────────────────────────────────────
step "Build the daemon release"
make -C "$REPO" daemon SKIP_CLI=1 || die "daemon release build failed."
ok "daemon release built → bin/rel."

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
make -C "$REPO" ui || die "UI bundle build failed."
ok "ui/dist built."

# ── 5. event stream ─────────────────────────────────────────────────────────
# The daemon derives per-session activity + the sent-files trail from this
# host's own hook stream (~/.shuttle/events.jsonl). The shuttle binary writes it
# (`shuttle hook event`) and the bundled plugin registers it, so this step is
# self-contained: install/refresh the plugin, then prove the writer works here.
#
# The plugin hook is gated on ~/.shuttle existing — step 3 created it, so the
# writer is already enabled on every bootstrapped host.
step "Event stream (plugin hook → ~/.shuttle/events.jsonl)"
if [ "$SKIP_HOOK" = 1 ]; then
  warn "skipped (--skip-hook)."
else
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
    | SHUTTLE_EVENTS_FILE="$PROBE" SHUTTLE_EVENTS= "$SHUTTLE_BIN" hook event >/dev/null 2>&1
  if [ "$(wc -l < "$PROBE" | tr -d ' ')" = "1" ] && grep -q '"type":"session_start"' "$PROBE"; then
    ok "shuttle hook event writes a well-formed line on this host."
  else
    warn "shuttle hook event probe failed — activity ranking + sent-files will stay empty."
    note "reproduce:  echo '{\"hook_event_name\":\"SessionStart\"}' | SHUTTLE_EVENTS_FILE=/tmp/e.jsonl shuttle hook event"
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
    note "to cycle to the freshly-built release, kill the :4000 listener — the loop respawns it:"
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
  make -C "$REPO" install-agent INSTALL_DIR="$CLI_INSTALL_DIR" || die "make install-agent failed."
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

  # tailscaled-launch goes alongside it, for hosts that front their daemon
  # with an unprivileged (userspace-networking) tailscaled instead of an SSH
  # tunnel. Installing it is inert on a host that never joins a tailnet: the
  # script itself only starts a tmux respawn loop for a tailscaled binary,
  # and does nothing unless someone runs it or the daemon's recovery cascade
  # does. That cascade only ever revives an instance on a host that already
  # has tailscaled state on disk ($HOME/.local/state/tailscale/tailscaled.state).
  # That file proves tailscaled has RUN here at least once — it is written on
  # first start, before and independent of `tailscale up` — so the gate is
  # "somebody deliberately started this", not "somebody approved this device".
  # Either way a host that never touched Tailscale has no such file, so the
  # daemon never invokes this script there, regardless of whether it happens
  # to be installed.
  cp "$REPO/bin/tailscaled-launch" "$HOME/.local/bin/tailscaled-launch" \
    && chmod +x "$HOME/.local/bin/tailscaled-launch" \
    || die "failed to install tailscaled-launch to ~/.local/bin."
  ok "tailscaled-launch installed to ~/.local/bin."

  if have_systemd_user; then
    # Same Makefile target as macOS, systemd arm: it captures the login PATH
    # and renders daemon/share/io.shuttle.daemon.service.template. Stores come
    # from the editable registry. The respawn loop remains the fallback when
    # supervisor installation fails.
    if make -C "$REPO" install-agent INSTALL_DIR="$CLI_INSTALL_DIR"; then
      ok "systemd user unit enabled (Restart=always + starts at login)."
      note "survive logout and start at boot:  loginctl enable-linger $(id -un)"
    else
      warn "make install-agent failed (see above) — falling back to the tmux respawn loop."
      note "retry supervisor installation:  make install-agent"
      start_respawn_loop
    fi
  else
    warn "no systemd user session here; using the tmux respawn loop instead."
    note "systemd would give you Restart=always + start at boot; a login node often has neither."
    start_respawn_loop
  fi
fi

# ── optional: remote tunnels (hub-side) ──────────────────────────────────────
# `shuttle tunnels install` picks the host's own supervisor — launchd
# LaunchAgents on macOS, systemd --user units on Linux — and refuses on a Linux
# host with no user session rather than writing units nothing would start.
if [ "$WITH_TUNNELS" = 1 ]; then
  step "Remote tunnels"
  shuttle tunnels install && ok "autossh tunnels (re)installed." \
    || warn "shuttle tunnels install failed (configure remotes first)."
fi

# ── footer ───────────────────────────────────────────────────────────────
step "Done"
note "verify:   curl -s http://127.0.0.1:4000/api/v1/version"
note "board:    http://127.0.0.1:4000/"
note "logs:     make logs"
note "workers:  shuttle ps"
# The trailing guard must not decide the script's exit code: a false test here
# would make a fully successful bootstrap exit 1, so the explicit `exit 0`
# below closes it out (caught by the clean-container acceptance run).
if [ "$WITH_TUNNELS" = 0 ]; then
  note "remotes:  ./scripts/bootstrap.sh --with-tunnels  (or: shuttle tunnels install)"
fi
exit 0
