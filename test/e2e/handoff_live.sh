#!/usr/bin/env bash
# LIVE end-to-end gate for the shed-history continuation invariant — the
# non-negotiable load-bearing thing the whole change must protect:
#
#   clean exit  → next dispatch starts FRESH   (new session, reads ## Status)
#   dirty death → next dispatch RESUMES         (re-enters the in-flight transcript)
#
# Where handoff_roundtrip.sh covers the BYTE level (the Go writer in isolation,
# hand-set SHUTTLE_FIBER_PATH, no daemon), this covers the LIVE level: a REAL
# daemon on a temp port, REAL tmux workers, the daemon's SHUTTLE_FIBER_PATH
# export exercised end-to-end, and the full loop —
#
#   daemon stamps session_uuid + dispatched_at  (async Task, real felt write)
#     → worker runs in real tmux, sources the daemon-exported SHUTTLE_FIBER_PATH
#     → real `felt shuttle handoff` stamps handed_off_at (clean) / nothing (dirty)
#     → daemon reads the fiber back off `felt show -j`
#     → decide_continuation builds `--session-id <new>` (fresh) or `--resume <old>`
#
# The worker is a FAKE claude (a controllable stand-in wired in as a test agent
# whose `wrapper` is an absolute path — sidestepping the real `claude` shell
# function and the compile-time agent registry). It logs its full argv — the
# command the daemon DECIDED to build — and, per a per-fiber `mode` file, either
# hands off cleanly or sleeps to be killed mid-thought. The argv line is the gold
# observable; we cross-check it against the fiber's stamped frontmatter.
#
# The fake agent reaches the run through felt's USER agent registry: a temp
# $FELT_AGENTS_FILE holding one `shuttle-e2e-stub` record whose `wrapper` is the
# absolute path to the stand-in. felt merges it over the built-ins and emits it
# under `shuttle.resolved.agent`; the daemon launches what it is handed. So this
# gate patches nothing tracked in the repo, and it cannot inherit the operator's
# own registry.
#
# Determinism: every dispatch is driven by `POST /dispatch {force:true}`
# (force_dispatch_eligible? — host-match only), and the probe fibers are born
# `status: open` so the autonomous 30s poll tick NEVER races us.
#
# Usage:  test/e2e/handoff_live.sh
#   FELT=<path>          override the felt binary (default: `felt` on PATH)
#   SHUTTLE_E2E_PORT=<n> override the daemon port (default: 4071)
#
# SAFETY: an isolated SHUTTLE_DATA_DIR, a temp FELT_STORES, a temp
# FELT_AGENTS_FILE and a private port keep this fully separate from any
# production daemon on :4000. All tmux sessions, the daemon, and temp dirs are
# torn down on EXIT.
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
FELT=${FELT:-felt}
PORT=${SHUTTLE_E2E_PORT:-4071}
HOST=e2e-host
WORK=$(mktemp -d /tmp/shuttle-handoff-live.XXXXXX)
STORE="$WORK/store"
BIN="$WORK/bin"
DATA="$WORK/data"
DAEMON_LOG="$WORK/daemon.log"
AGENTS_FILE="$WORK/agents.json"     # temp user agent registry (holds the fake agent)
FAKE_CLAUDE="$BIN/fake-claude"
DAEMON="$WORK/shuttle"
FELT_BIN=$(command -v "$FELT" || true)
# The worker's handoff verb is `felt shuttle handoff` (the standalone shuttle-ctl
# shim is retired). CTL is the verb prefix the fake worker appends `handoff` to.
CTL=("$FELT" shuttle)

FAIL=0
DAEMON_PID=""
pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
info() { printf '\033[36m••••\033[0m %s\n' "$*"; }

cleanup() {
  # Kill any probe tmux sessions first (independent of the daemon).
  tmux ls 2>/dev/null | grep -Eo '^shuttle-e2e/[^:]+' | while read -r s; do
    tmux kill-session -t "$s" 2>/dev/null || true
  done
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  # Nothing tracked to restore: the fake agent rides a temp FELT_AGENTS_FILE and
  # the private port rides SHUTTLE_PORT, so this run never edits the repo.
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -n "$FELT_BIN" ] || { echo "felt not found (set FELT=<path>)"; exit 2; }

mkdir -p "$BIN" "$DATA"

# Pick a free port (passed to the daemon as SHUTTLE_PORT). Default 4071; bump if busy,
# so a coincidental listener never masquerades as a daemon-boot failure.
port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
if command -v lsof >/dev/null && port_busy "$PORT"; then
  for p in 4072 4073 4074 4081 4082 4091; do port_busy "$p" || { PORT=$p; break; }; done
fi

# ── 1. The real worker handoff verb is `felt shuttle handoff` ────────────────
# Nothing to build — the shim is retired; the fake worker shells the felt binary
# resolved above directly.

# ── 2. Write the fake claude worker ──────────────────────────────────────────
# Derives its per-fiber argv log + mode file from SHUTTLE_FIBER_PATH (the daemon
# exports it). `mode`=clean → real handoff (stamp + end own tmux session);
# anything else → sleep so the harness can kill it mid-thought.
cat > "$FAKE_CLAUDE" <<FAKE
#!/usr/bin/env bash
# A controllable stand-in for the claude harness. Args reach us exactly as the
# daemon built them (--session-id <new> for fresh, --resume <old> for resume).
DIR=\$(dirname "\${SHUTTLE_FIBER_PATH:-/dev/null}")
printf '%s\n' "\$*" >> "\$DIR/argv.log"
MODE=\$(cat "\$DIR/mode" 2>/dev/null || echo clean)
# A real worker takes seconds to boot + reason before exiting; sleep briefly so
# the daemon's async dispatch-stamp lands first (matches production ordering).
sleep 1
if [ "\$MODE" = clean ]; then
  "${CTL[@]}" handoff probe   # SHUTTLE_FIBER_PATH wins; the arg is ignored
else
  sleep 600              # stay alive to be killed mid-thought
fi
FAKE
chmod +x "$FAKE_CLAUDE"

# ── 3. Register the fake agent, build the escript ────────────────────────────
# One USER-layer record in a temp registry. Exporting FELT_AGENTS_FILE covers
# every felt in this run — the ones this script calls and the ones the daemon
# shells — and shadows the operator's own registry, so the gate is reproducible
# on any machine.
info "registering fake test agent (wrapper=$FAKE_CLAUDE)"
cat > "$AGENTS_FILE" <<AGENTS
{
  "version": 1,
  "builtins": "merge",
  "agents": [
    {
      "id": "shuttle-e2e-stub",
      "cli": "claude",
      "wrapper": "$FAKE_CLAUDE",
      "model": "sonnet",
      "effort_levels": ["low", "medium", "high", "xhigh", "max"],
      "default_effort": "low",
      "cost_class": "standard"
    }
  ]
}
AGENTS
export FELT_AGENTS_FILE="$AGENTS_FILE"
"$FELT" shuttle agents resolve shuttle-e2e-stub --json >/dev/null || {
  echo "FATAL: felt does not resolve shuttle-e2e-stub from $AGENTS_FILE" >&2
  exit 2
}

info "building daemon escript (port comes from SHUTTLE_PORT at run time)"
# No config patching. config/dev.exs no longer decides the port —
# Shuttle.Application.configure_endpoint/0 reads SHUTTLE_PORT at boot, so the
# private port is passed to the daemon in step 5 like any other runtime value.
# This script therefore patches no tracked file at all.
( cd "$REPO" && mix escript.build >/dev/null 2>&1 ) || { echo "escript build failed"; exit 2; }
cp "$REPO/bin/shuttle" "$DAEMON"
rm -f "$REPO/bin/shuttle"          # don't leave a test-contaminated binary behind

# ── 4. Create the temp store + two probe fibers ──────────────────────────────
make_fiber() {  # make_fiber <slug> <mode>
  local slug=$1 mode=$2
  local dir="$STORE/.felt/e2e/$slug"
  mkdir -p "$dir"
  cat > "$dir/$slug.md" <<EOF
---
id: e2e/$slug
name: Live handoff probe ($slug)
status: open
tags:
  - e2e
outcome: Live handoff gate probe.
shuttle:
  kind: oneshot
  host: $HOST
  project_dir: $WORK
  agent: shuttle-e2e-stub
---

Probe fiber for the live handoff gate. The fake worker reads ./mode.
EOF
  printf '%s' "$mode" > "$dir/mode"
}
make_fiber probe-clean clean
make_fiber probe-dirty dirty

# ── 5. Start the daemon (isolated port / store / data dir / host) ────────────
info "starting daemon on :$PORT (store=$STORE host=$HOST)"
SHUTTLE_PORT="$PORT" FELT_STORES="$STORE" FELT_AGENTS_FILE="$AGENTS_FILE" \
  SHUTTLE_HOST="$HOST" SHUTTLE_DATA_DIR="$DATA" \
  nohup "$DAEMON" start --force >"$DAEMON_LOG" 2>&1 &
DAEMON_PID=$!

# Wait for the HTTP surface to bind.
deadline=$(( $(date +%s) + 60 ))
until curl -s -o /dev/null "http://127.0.0.1:$PORT/api/v1/version" 2>/dev/null; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "daemon never bound :$PORT"; sed -n '1,40p' "$DAEMON_LOG"; exit 2; }
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "daemon exited during boot"; sed -n '1,40p' "$DAEMON_LOG"; exit 2; }
  sleep 0.5
done
pass "daemon bound :$PORT"

# ── helpers ──────────────────────────────────────────────────────────────────
sh_field() {  # sh_field <fiber-id> <key>
  "$FELT" -C "$STORE" show "$1" -j 2>/dev/null \
    | python3 -c "import sys,json;print(json.load(sys.stdin).get('shuttle',{}).get('$2',''))" 2>/dev/null
}
dispatch() {  # dispatch <fiber-id> → echoes tmux_session
  curl -s -X POST "http://127.0.0.1:$PORT/api/v1/dispatch" \
    -H 'content-type: application/json' -d "{\"fiber_id\":\"$1\",\"force\":true}" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('tmux_session',''))" 2>/dev/null
}
wait_until() {  # wait_until <timeout_s> <desc> <cmd...>
  local t=$1 desc=$2; shift 2
  local dl=$(( $(date +%s) + t ))
  while [ "$(date +%s)" -lt "$dl" ]; do "$@" >/dev/null 2>&1 && return 0; sleep 0.3; done
  fail "TIMEOUT: $desc"; return 1
}
has_session()  { tmux has-session -t "$1" 2>/dev/null; }
no_session()   { ! tmux has-session -t "$1" 2>/dev/null; }
has_uuid()     { [ -n "$(sh_field "$1" session_uuid)" ]; }
has_handoff()  { [ -n "$(sh_field "$1" handed_off_at)" ]; }
lastargv()     { tail -n1 "$STORE/.felt/e2e/$1/argv.log" 2>/dev/null; }
argv_lines()   { wc -l < "$STORE/.felt/e2e/$1/argv.log" 2>/dev/null | tr -d ' ' || echo 0; }
# True once the fiber's argv.log has grown beyond <baseline> — i.e. the NEW
# dispatch's worker has logged the command the daemon built for it. Guards
# against reading a STALE argv line from the prior dispatch.
argv_grew()    { [ "$(argv_lines "$1")" -gt "$2" ]; }

# ════════════════════════════════════════════════════════════════════════════
# SCENARIO A — clean exit → FRESH
# ════════════════════════════════════════════════════════════════════════════
echo
echo "== SCENARIO A: clean handoff → next dispatch is FRESH =="
S1=$(dispatch e2e/probe-clean)
[ -n "$S1" ] && pass "dispatch #1 → tmux $S1" || fail "dispatch #1 returned no session"
wait_until 15 "daemon stamps session_uuid (#1)" has_uuid e2e/probe-clean || true
U1=$(sh_field e2e/probe-clean session_uuid); D1=$(sh_field e2e/probe-clean dispatched_at)
[ -n "$U1" ] && pass "daemon stamped session_uuid=$U1" || fail "session_uuid never stamped"
[ -n "$D1" ] && pass "daemon stamped dispatched_at=$D1" || fail "dispatched_at never stamped"

# The clean worker hands off: stamps handed_off_at and ends its own tmux session.
wait_until 20 "worker stamps handed_off_at (#1)" has_handoff e2e/probe-clean || true
wait_until 20 "worker ends its own tmux session (#1)" no_session "$S1" || true
H1=$(sh_field e2e/probe-clean handed_off_at)
[ -n "$H1" ] && pass "worker stamped handed_off_at=$H1 (real felt shuttle handoff, daemon-exported path)" || fail "handed_off_at never stamped"
no_session "$S1" && pass "endOwnTmuxSession killed $S1" || fail "tmux session survived handoff"
python3 - "$D1" "$H1" <<'PY' && pass "handed_off_at >= dispatched_at → decision domain is FRESH" || fail "handoff not after dispatch"
import sys, re
from datetime import datetime
# Both writers emit variable-precision fractional seconds (Elixir to_iso8601 /
# Go RFC3339Nano both trim trailing zeros), so normalize to 6 digits — older
# datetime.fromisoformat rejects anything but 3 or 6.
def p(s):
    s = s.strip().replace('Z', '+00:00')
    s = re.sub(r'\.(\d+)', lambda m: '.' + (m.group(1) + '000000')[:6], s)
    return datetime.fromisoformat(s)
sys.exit(0 if p(sys.argv[2]) >= p(sys.argv[1]) else 1)
PY

# Redispatch — the daemon must DECIDE fresh and build a NEW --session-id.
NB=$(argv_lines probe-clean)
S2=$(dispatch e2e/probe-clean)
[ -n "$S2" ] && pass "dispatch #2 → tmux $S2" || fail "dispatch #2 returned no session"
wait_until 15 "redispatch worker logs its built command (#2)" argv_grew probe-clean "$NB" || true
A2=$(lastargv probe-clean)
U2=$(sh_field e2e/probe-clean session_uuid)
info "redispatch argv: $A2"
case "$A2" in
  *--resume*) fail "clean redispatch RESUMED — should be fresh (argv: $A2)" ;;
  *--session-id*) pass "clean redispatch built --session-id (FRESH), not --resume" ;;
  *) fail "clean redispatch argv has neither --session-id nor --resume: $A2" ;;
esac
[ -n "$U2" ] && [ "$U2" != "$U1" ] && pass "fresh minted a NEW session_uuid ($U1 → $U2)" || fail "session_uuid did not change on fresh ($U1 → $U2)"
case "$A2" in *"$U2"*) pass "argv --session-id matches the newly stamped uuid" ;; *) fail "argv uuid != stamped uuid" ;; esac
tmux kill-session -t "$S2" 2>/dev/null || true

# ════════════════════════════════════════════════════════════════════════════
# SCENARIO B — dirty death → RESUME
# ════════════════════════════════════════════════════════════════════════════
echo
echo "== SCENARIO B: killed mid-thought → next dispatch RESUMES =="
S3=$(dispatch e2e/probe-dirty)
[ -n "$S3" ] && pass "dispatch #1 → tmux $S3" || fail "dispatch #1 returned no session"
wait_until 15 "daemon stamps session_uuid (#1)" has_uuid e2e/probe-dirty || true
U3=$(sh_field e2e/probe-dirty session_uuid)
[ -n "$U3" ] && pass "daemon stamped session_uuid=$U3" || fail "session_uuid never stamped"

# Kill mid-thought — no handoff, no handed_off_at (the remote-machine death).
wait_until 10 "worker session is live before the kill" has_session "$S3" || true
tmux kill-session -t "$S3" 2>/dev/null || true
wait_until 10 "worker session is gone after the kill" no_session "$S3" || true
no_session "$S3" && pass "killed worker $S3 mid-thought (no handoff)" || fail "could not kill worker session"
HD=$(sh_field e2e/probe-dirty handed_off_at)
[ -z "$HD" ] && pass "handed_off_at absent (dirty death left no clean-exit marker)" || fail "handed_off_at unexpectedly present: $HD"

# Redispatch — the daemon must DECIDE resume and build --resume <U3>.
NB2=$(argv_lines probe-dirty)
S4=$(dispatch e2e/probe-dirty)
[ -n "$S4" ] && pass "dispatch #2 → tmux $S4" || fail "dispatch #2 returned no session"
wait_until 15 "resume redispatch worker logs its built command (#2)" argv_grew probe-dirty "$NB2" || true
A4=$(lastargv probe-dirty)
U4=$(sh_field e2e/probe-dirty session_uuid)
info "redispatch argv: $A4"
case "$A4" in
  *--resume*) pass "dirty redispatch built --resume (RESUME)" ;;
  *) fail "dirty redispatch did NOT resume (argv: $A4)" ;;
esac
case "$A4" in *"--resume $U3"*|*"--resume '$U3'"*) pass "resumed the SAME session_uuid the daemon stamped at dispatch #1 ($U3)" ;; *) fail "resume uuid != stamped uuid ($U3); argv: $A4" ;; esac
[ "$U4" = "$U3" ] && pass "resume preserved session_uuid (no re-stamp): $U4" || fail "session_uuid changed on resume ($U3 → $U4)"
tmux kill-session -t "$S4" 2>/dev/null || true

echo
if [ "$FAIL" = 0 ]; then echo "ALL GREEN — live handoff invariant holds end-to-end"; exit 0; else echo "SOME FAILURES"; exit 1; fi
