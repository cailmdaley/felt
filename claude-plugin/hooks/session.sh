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

if command -v jq >/dev/null 2>&1; then
  felt session | jq -Rs '{
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: .
    }
  }'
else
  exec felt hook session
fi
