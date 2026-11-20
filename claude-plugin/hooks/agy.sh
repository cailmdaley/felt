#!/bin/bash
# Antigravity CLI (agy) hook for the felt plugin `felt setup antigravity`
# installs, registered on every event Shuttle follows; the tool events run it
# as `agy.sh tool`.
#
# Thin shim: `shuttle hook antigravity` reads agy's payload from stdin, records
# it on the host-local activity stream and answers in agy's shape. agy reads
# any JSON a tool hook prints as a decision (`{}` denies the tool), so a tool
# event prints nothing at all; any other event prints shuttle's answer only
# when it is a whole JSON object (an older shuttle without this verb prints
# help; one cut off mid-write leaves a fragment). shuttle gets five seconds,
# well inside the hook's timeout in hooks.json, so a stuck call cannot hold
# agy. It exits 0 on every path.

source "${0%/*}/shuttle-bin.sh"

# Runs shuttle on this hook's stdin, killed after five seconds. The watchdog
# takes its sleep down with it when shuttle finishes first.
bounded_hook() {
  "$SHUTTLE_BIN" hook antigravity 0<&0 2>/dev/null &
  local pid=$!
  (trap 'kill $!; exit' TERM; sleep 5 & wait $!; kill "$pid") >/dev/null 2>&1 &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  kill "$watchdog" 2>/dev/null
}

if shuttle_hook_available; then
  if [[ ${1:-} == tool ]]; then
    bounded_hook >/dev/null
  else
    output="$(bounded_hook)"
    if [[ $output == \{*\} ]]; then printf '%s\n' "$output"; fi
  fi
fi

exit 0
