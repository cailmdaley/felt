#!/bin/bash
# Optional Node adapter; a missing runtime or broken transcript never blocks tools.
node_bin="$(command -v node 2>/dev/null)"
if [ -z "$node_bin" ]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then node_bin="$candidate"; break; fi
  done
fi
if [ -n "$node_bin" ]; then
  "$node_bin" "$(dirname "$0")/handoff.mjs" 2>/dev/null || true
fi
exit 0
