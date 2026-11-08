#!/bin/bash
# SessionStart hook for the felt plugin.
#
# `felt session` owns the human-readable context text. This script is the
# Claude/Codex adapter: wrap that text in the SessionStart additionalContext
# envelope the harness expects.
#
# Without jq, `felt hook session` builds the same envelope in the binary.

set -e
set -o pipefail

source "${0%/*}/felt-bin.sh"

if [ -n "$FELT_BIN" ] && command -v jq >/dev/null 2>&1; then
  if context="$("$FELT_BIN" session 2>/dev/null)"; then
    printf '%s\n' "$context" | jq -Rs '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: .
      }
    }' || true
    exit 0
  fi
elif felt_hook_available; then
  if "$FELT_BIN" hook session 2>/dev/null; then exit 0; fi
fi

# Keep SessionStart non-blocking when felt is absent or too old. Reached only
# when neither branch above produced context: each exits once it has.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Felt Workflow Context\n\n*The installed `felt` binary is missing or too old for this hook. Add it to PATH or install it at ~/.local/bin/felt to restore active-fiber listings.*\n"
  }
}
EOF
