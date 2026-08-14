#!/bin/bash
# SessionStart hook for the felt plugin.
#
# `felt session` owns the human-readable context text. This script is the
# Claude/Codex adapter: wrap that text in the SessionStart additionalContext
# envelope the harness expects.
#
# If jq is missing, fall back to `felt hook session`, the compatibility adapter
# kept in the binary for older installs and dependency-light environments.

set -e
set -o pipefail

source "$(dirname "$0")/felt-bin.sh"

if [ -n "$FELT_BIN" ] && command -v jq >/dev/null 2>&1; then
  "$FELT_BIN" session | jq -Rs '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: .
    }
  }'
elif felt_hook_available; then
  exec "$FELT_BIN" hook session
fi

# Keep SessionStart non-blocking when felt is absent or too old.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Felt Workflow Context\n\n*The installed `felt` binary is missing or too old for this hook. Add it to PATH or install it at ~/.local/bin/felt to restore active-fiber listings.*\n"
  }
}
EOF
