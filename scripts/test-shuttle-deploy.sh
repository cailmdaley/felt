#!/usr/bin/env bash
# Deploy verification against isolated version receipts; no daemon is contacted.
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
python3 - "$repo/bin/shuttle-deploy" "$root/functions" <<'PY'
import sys
source = open(sys.argv[1]).read()
names = ('version_ready', 'version_launch_health', 'wait_for_sha', 'verify_and_release')
with open(sys.argv[2], 'w') as out:
    for name in names:
        start = source.find(name + '() {')
        if start >= 0:
            end = source.index('\n}', start) + 2
            out.write(source[start:end] + '\n')
PY
source "$root/functions"
TARGET_SHA=abc123
EXPECTED_RELEASE=/generation-a
DEPLOY_STARTED_AT=2026-01-01T00:00:00
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=0
SHUTTLE_DEPLOY_READY_POLL_INTERVAL_SECONDS=1
base='"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","release_path":"/generation-a","incarnation":"a","ready":true'
version_json() { printf '{%s,%s}\n' "$base" "$fixture_health"; }
release_verified_deploy() { echo finished >> "$root/finished"; }
for reason in contract migration unavailable; do
  case "$reason" in
    contract) fixture_health='"contract":{"ok":false,"reason":"CLI skew"},"reconciliation_hold":null'; diagnostic='CLI skew' ;;
    migration) fixture_health='"contract":{"ok":true},"reconciliation_hold":{"reason":"backend conflict"}'; diagnostic='backend conflict' ;;
    unavailable) fixture_health='"contract":{"ok":null,"reason":"poller_unavailable"},"reconciliation_hold":null'; diagnostic='poller_unavailable' ;;
  esac
  if verify_and_release >"$root/out" 2>&1; then
    echo "FAIL: deploy accepted $reason hold" >&2; exit 1
  fi
  grep -q "$diagnostic" "$root/out" || { echo "FAIL: missing $reason diagnostic"; exit 1; }
  [ ! -f "$root/finished" ] || { echo 'FAIL: held deploy reached release/pruning'; exit 1; }
  echo "PASS: $reason hold refuses completion"
done
fixture_health='"contract":{"ok":true},"reconciliation_hold":null'
saved_base=$base
base='"git_short_sha":"abc123","booted_at":"2026-01-02T00:00:00Z","release_path":"/generation-a","ready":true'
if verify_and_release >"$root/out" 2>&1; then
  echo 'FAIL: receipt without incarnation completed' >&2; exit 1
fi
grep -q 'automated rollback requires incarnation-bound release support' "$root/out" || { echo 'FAIL: rollback floor is not explained'; exit 1; }
[ ! -f "$root/finished" ] || { echo 'FAIL: unsupported rollback reached release/pruning'; exit 1; }
base=$saved_base
echo 'PASS: unsupported rollback refuses release with its protocol floor'
verify_and_release
[ -s "$root/finished" ]
echo 'PASS: healthy receipt completes'
rm "$root/finished"
# A recovering Poller is retried; only the final healthy incarnation is retained.
SHUTTLE_DEPLOY_READY_TIMEOUT_SECONDS=10
version_json() {
  if [ ! -f "$root/first" ]; then
    touch "$root/first"
    printf '{%s,"contract":{"ok":true},"reconciliation_hold":"recovering"}\n' "$base"
  else
    printf '{%s,%s}\n' "$base" "$fixture_health"
  fi
}
sleep() { :; }
verify_and_release
[ -s "$root/finished" ]
echo 'PASS: transient recovery completes after a healthy receipt'
