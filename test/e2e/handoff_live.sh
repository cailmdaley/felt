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
# STATUS (Stage 4a, felt-registry migration): BROKEN, needs a felt-side rewire.
# The fake-claude agent was injected by patching the daemon's compile-time
# `share/agents.json`. That file is gone — felt now owns the registry and the
# daemon reads the already-resolved record off `shuttle.resolved.agent`. To
# revive this gate, inject the fake agent into felt's registry (so felt emits it
# under resolved.agent) instead of editing a daemon-embedded JSON. Until then the
# guard below exits non-zero with this explanation rather than failing obscurely
# on the missing file.
#
# Determinism: every dispatch is driven by `POST /dispatch {force:true}`
# (force_dispatch_eligible? — host-match only), and the probe fibers are born
# `status: open` so the autonomous 30s poll tick NEVER races us.
#
# Usage:  test/e2e/handoff_live.sh
#   FELT=<path>          override the felt binary (default: `felt` on PATH)
#   SHUTTLE_E2E_PORT=<n> override the daemon port (default: 4071)
#
# SAFETY: an isolated SHUTTLE_DATA_DIR + a temp FELT_STORES + a private port keep
# this fully separate from any production daemon on :4000. All tmux sessions,
# the daemon, and temp dirs are torn down on EXIT.
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
AGENTS_JSON="$REPO/share/agents.json"
AGENTS_BAK="$WORK/agents.json.bak"
DEV_EXS="$REPO/config/dev.exs"
DEV_BAK="$WORK/dev.exs.bak"
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
  # Restore the patched tracked files no matter what (registry got the fake
  # agent; dev.exs got the private port).
  [ -f "$AGENTS_BAK" ] && cp "$AGENTS_BAK" "$AGENTS_JSON"
  [ -f "$DEV_BAK" ] && cp "$DEV_BAK" "$DEV_EXS"
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -n "$FELT_BIN" ] || { echo "felt not found (set FELT=<path>)"; exit 2; }

# Stage 4a guard: the fake-agent injection below patches a daemon-embedded
# share/agents.json that no longer exists (felt owns the registry now). Fail
# fast with the rewire note rather than cp-ing a missing file. See the header.
if [ ! -f "$AGENTS_JSON" ]; then
  echo "handoff_live.sh is BROKEN by the felt-registry migration (Stage 4a):" >&2
  echo "  the fake agent was injected into the daemon's compile-time" >&2
  echo "  share/agents.json, which is gone — felt owns the registry now." >&2
  echo "  Rewire: inject the fake agent into felt's registry so it appears" >&2
  echo "  under shuttle.resolved.agent. See this script's header." >&2
  exit 2
fi

mkdir -p "$BIN" "$DATA"

# Pick a free port (baked into the escript below). Default 4071; bump if busy,
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

# ── 3. Patch the agent registry with the fake, build the escript, restore ────
info "injecting fake test agent + private port :$PORT, building daemon escript"
cp "$AGENTS_JSON" "$AGENTS_BAK"
cp "$DEV_EXS" "$DEV_BAK"
# dev.exs hardcodes `port: 4000` + `server: true` (which makes the runtime
# SHUTTLE_PORT fallback a no-op). The escript bundles this config at build, so
# bake our private port in for this build, then restore.
sed -i '' "s/port: 4000/port: $PORT/" "$DEV_EXS"
grep -q "port: $PORT" "$DEV_EXS" || { echo "FATAL: could not bake private port into dev.exs (no 'port: 4000' literal?)"; exit 2; }
python3 - "$AGENTS_JSON" "$FAKE_CLAUDE" <<'PY'
import json, sys
path, wrapper = sys.argv[1], sys.argv[2]
agents = json.load(open(path))
agents.append({
    "id": "shuttle-e2e-stub",
    "cli": "claude",
    "wrapper": wrapper,
    "model": "sonnet",
    "extra_flags": "",
    "effort_levels": ["low", "medium", "high", "xhigh", "max"],
    "default_effort": "low",
    "headless": True,
    "chrome_capable": False,
    "cost_class": "standard",
    "aliases": [],
    "default": False,
})
json.dump(agents, open(path, "w"), indent=2)
PY
( cd "$REPO" && mix escript.build >/dev/null 2>&1 ) || { echo "escript build failed"; exit 2; }
cp "$REPO/bin/shuttle" "$DAEMON"
rm -f "$REPO/bin/shuttle"          # don't leave a test-contaminated binary behind
cp "$AGENTS_BAK" "$AGENTS_JSON"    # restore tracked files immediately (escript already embedded them)
cp "$DEV_BAK" "$DEV_EXS"

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
SHUTTLE_PORT="$PORT" FELT_STORES="$STORE" SHUTTLE_HOST="$HOST" SHUTTLE_DATA_DIR="$DATA" \
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
