#!/bin/sh
# Run a full test suite while holding this machine's one suite slot, so the
# suites of several workers on one host take turns instead of loading it
# together until the daemon stops answering. The slot is a directory under
# ~/.shuttle (mkdir is atomic everywhere the fleet runs) recording its holder's
# pid and checkout; a slot whose holder is gone is taken over. A suite started
# under a held slot runs directly. A waiter is told who holds the slot, since
# pushing and letting CI run the suite is the other way through.
set -eu
[ -n "${SHUTTLE_SUITE_SLOT_HELD:-}" ] && exec "$@"
slot="${SHUTTLE_SUITE_SLOT:-$HOME/.shuttle/suite.slot}"
mkdir -p "$(dirname "$slot")"
waited=0
while ! mkdir "$slot" 2>/dev/null; do
  holder=$(cat "$slot/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$slot"
    continue
  fi
  if [ "$waited" -eq 0 ]; then
    echo "suite-slot: pid ${holder:-?} is running a suite from $(cat "$slot/dir" 2>/dev/null || echo '?'); waiting for this machine's slot (or interrupt, push, and let CI run it)" >&2
  fi
  waited=$((waited + 1))
  if [ "$waited" -ge 1800 ]; then
    echo "suite-slot: gave up after 30 min; remove $slot if no suite is running" >&2
    exit 1
  fi
  sleep 1
done
echo $$ > "$slot/pid"
pwd > "$slot/dir"
trap 'rm -rf "$slot"' EXIT INT TERM
SHUTTLE_SUITE_SLOT_HELD=1 "$@"
