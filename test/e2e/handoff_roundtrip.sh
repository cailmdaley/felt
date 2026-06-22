#!/usr/bin/env bash
# Standalone mechanical gate for the shed-history continuation write path.
#
# Proves, against the REAL `felt shuttle handoff` and a REAL felt round-trip (no
# daemon, no tmux), that the handoff verb surgically stamps
# shuttle.handed_off_at while PRESERVING the daemon-written session_uuid /
# dispatched_at, the rest of the shuttle: block, non-shuttle frontmatter, and the
# body — and that it is idempotent (no whitespace accretion) and fails loudly on
# a fiber with no shuttle: block.
#
# This covers the byte-level half of the "handoff invariant" gate. The other
# half — a live daemon deciding fresh-vs-resume off the stamped fields, with a
# real worker in tmux — is exercised separately.
#
# Usage:  test/e2e/handoff_roundtrip.sh
#   FELT=<path>  overrides the felt binary (defaults to `felt` on PATH; any felt
#                works — the shuttle: block is opaque frontmatter it round-trips).
#
# SAFETY: handoff's endOwnTmuxSession kills $TMUX session if set. Every handoff
# call here runs under `env -u TMUX` so it can never kill the caller's session.
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=$(mktemp -d /tmp/shuttle-handoff-e2e.XXXXXX)
FELT=${FELT:-felt}
FAIL=0
pass() { printf '\033[32mPASS\033[0m %s\n' "$*"; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*"; FAIL=1; }
trap 'rm -rf "$WORK"' EXIT

command -v "$FELT" >/dev/null || { echo "felt not found (set FELT=<path>)"; exit 2; }

# The handoff verb is `felt shuttle handoff` (the old standalone shuttle-ctl
# shim is retired). CTL is the verb prefix; callers append `handoff <id>`.
CTL=("$FELT" shuttle)

STORE="$WORK/store"
FIBER_DIR="$STORE/.felt/demo/worker-fiber"
mkdir -p "$FIBER_DIR"
MD="$FIBER_DIR/worker-fiber.md"

DISPATCHED_AT="2026-06-20T10:00:00Z"
SESSION_UUID="11111111-2222-3333-4444-555555555555"
# Post-dispatch state: daemon already stamped session_uuid + dispatched_at.
# Single blank line separates frontmatter from body (the writer's normal form),
# so a clean handoff must leave the body byte-identical.
cat > "$MD" <<EOF
---
id: demo/worker-fiber
name: Worker fiber
status: active
tags:
  - demo
outcome: A oneshot mid-loop.
shuttle:
  kind: oneshot
  host: testhost
  project_dir: /tmp
  agent: claude-opus
  session_uuid: $SESSION_UUID
  dispatched_at: $DISPATCHED_AT
custom_field: must-survive
---

This is the fiber body. It must survive the handoff write byte-for-byte.

## Desired State

Prose with a [[wikilink]] and special chars: é, "quotes", \$dollar.
EOF

body_of() { awk 'f==2{print} /^---[[:space:]]*$/{f++}' "$1"; }
sh_field() { printf '%s' "$1" | python3 -c "import sys,json;print(json.load(sys.stdin).get('shuttle',{}).get('$2',''))"; }

body_before=$(body_of "$MD")

echo "== CASE 1: clean handoff preserves daemon fields + siblings + body =="
env -u TMUX SHUTTLE_FIBER_PATH="$MD" "${CTL[@]}" handoff demo/worker-fiber >/dev/null
J=$("$FELT" -C "$STORE" show demo/worker-fiber -j)
[ -n "$(sh_field "$J" handed_off_at)" ] && pass "handed_off_at stamped" || fail "handed_off_at missing"
[ "$(sh_field "$J" session_uuid)" = "$SESSION_UUID" ] && pass "session_uuid preserved" || fail "session_uuid lost"
[ "$(sh_field "$J" dispatched_at)" = "$DISPATCHED_AT" ] && pass "dispatched_at preserved" || fail "dispatched_at lost"
[ "$(sh_field "$J" kind)" = "oneshot" ] && pass "sibling shuttle key preserved" || fail "kind lost"
[ "$(printf '%s' "$J" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("custom_field",""))')" = "must-survive" ] \
  && pass "non-shuttle frontmatter preserved" || fail "custom_field lost"
[ "$(body_of "$MD")" = "$body_before" ] && pass "body byte-identical" || fail "body changed"

HOFF=$(sh_field "$J" handed_off_at)
python3 - "$DISPATCHED_AT" "$HOFF" <<'PY' && pass "handed_off_at >= dispatched_at → decision FRESH" || fail "handoff not after dispatch"
import sys, re
from datetime import datetime
# The Go writer emits RFC3339Nano (variable-precision fractional seconds, trailing
# zeros trimmed); normalize to 6 digits so older datetime.fromisoformat accepts it.
def p(s):
    s = s.strip().replace('Z', '+00:00')
    s = re.sub(r'\.(\d+)', lambda m: '.' + (m.group(1) + '000000')[:6], s)
    return datetime.fromisoformat(s)
sys.exit(0 if p(sys.argv[2]) >= p(sys.argv[1]) else 1)
PY

echo "== CASE 2: idempotent — repeated handoff does not accrete whitespace =="
lines1=$(wc -l < "$MD")
env -u TMUX SHUTTLE_FIBER_PATH="$MD" "${CTL[@]}" handoff demo/worker-fiber >/dev/null
env -u TMUX SHUTTLE_FIBER_PATH="$MD" "${CTL[@]}" handoff demo/worker-fiber >/dev/null
lines2=$(wc -l < "$MD")
[ "$lines1" = "$lines2" ] && pass "line count stable across re-handoffs ($lines1)" || fail "file grew: $lines1 → $lines2"
[ "$(body_of "$MD")" = "$body_before" ] && pass "body still byte-identical after re-handoffs" || fail "body drifted on re-handoff"

echo "== CASE 3: no shuttle: block → errors loudly, no silent corruption =="
NS="$STORE/.felt/demo/no-shuttle/no-shuttle.md"; mkdir -p "$(dirname "$NS")"
printf -- '---\nid: demo/no-shuttle\nname: NS\nstatus: open\n---\nBody untouched.\n' > "$NS"
if env -u TMUX SHUTTLE_FIBER_PATH="$NS" "${CTL[@]}" handoff demo/no-shuttle >/dev/null 2>&1; then
  fail "handoff on a fiber with no shuttle: block should error"
else
  pass "handoff errors on missing shuttle: block"
fi
grep -q "Body untouched." "$NS" && pass "no-shuttle fiber body untouched" || fail "no-shuttle fiber corrupted"

echo
[ "$FAIL" = 0 ] && { echo "ALL GREEN"; exit 0; } || { echo "SOME FAILURES"; exit 1; }
