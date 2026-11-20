#!/bin/bash
# Antigravity CLI (agy) hook for the felt plugin `felt setup antigravity`
# installs, registered on every event Shuttle follows.
#
# Thin shim: `shuttle hook antigravity` reads agy's payload from stdin, records
# it on the host-local activity stream and answers in agy's shape. Only a JSON
# answer belongs on stdout: agy reads any JSON a PreToolUse hook prints as a
# decision (`{}` denies the tool), and an older shuttle without this verb may
# print help. It exits 0 on every path.

source "${0%/*}/shuttle-bin.sh"

if shuttle_hook_available; then
  output="$("$SHUTTLE_BIN" hook antigravity 2>/dev/null)" || output=
  if [[ $output == \{* ]]; then printf '%s\n' "$output"; fi
fi

exit 0
