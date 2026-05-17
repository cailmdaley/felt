#!/bin/bash
# SessionStart hook for the felt plugin.
#
# Thin shim: the binary owns the logic. `felt hook session` walks for the
# project root, lists active and recently-touched fibers, and emits the
# SessionStart additionalContext envelope. Keeping behavior in the binary
# means `brew upgrade felt` refreshes hook behavior; the plugin only needs
# refreshing when skill content changes.
#
# Wired into both Claude Code (via hooks.json) and Codex (via
# ~/.codex/hooks.json, pointing at the symlinked copy).

set -e

if command -v felt >/dev/null 2>&1; then
    exec felt hook session
fi

# felt binary missing: emit a minimal envelope so the session still starts
# and the user is told how to fix it. No active-fibers listing; the binary
# is where that lives.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Felt Workflow Context\n\n*The `felt` binary is not on PATH. Install via `brew install cailmdaley/tap/felt` or see https://github.com/cailmdaley/felt.*\n"
  }
}
EOF
