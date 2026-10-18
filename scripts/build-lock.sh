#!/bin/sh
# Run a command while holding this checkout's build lock, so two builds in one
# checkout (two agents deploying at once) take turns instead of overwriting each
# other's ui/dist and bin/rel.next. The lock is a directory, which mkdir creates
# atomically on every platform and filesystem the fleet uses (flock is absent on
# macOS, lockf on Linux). A holder records its pid; a lock whose holder is gone
# is broken. Nested invocations under a held lock run directly.
set -eu
[ -n "${SHUTTLE_BUILD_LOCK_HELD:-}" ] && exec "$@"
root=$(cd "$(dirname "$0")/.." && pwd)
lock="$root/bin/.build.lock"
mkdir -p "$root/bin"
waited=0
while ! mkdir "$lock" 2>/dev/null; do
  holder=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -rf "$lock"
    continue
  fi
  if [ "$waited" -eq 0 ]; then
    echo "build-lock: another build holds $lock (pid ${holder:-?}); waiting" >&2
  fi
  waited=$((waited + 1))
  if [ "$waited" -ge 1800 ]; then
    echo "build-lock: gave up after 30 min; remove $lock if no build is running" >&2
    exit 1
  fi
  sleep 1
done
echo $$ > "$lock/pid"
trap 'rm -rf "$lock"' EXIT INT TERM
SHUTTLE_BUILD_LOCK_HELD=1 "$@"
