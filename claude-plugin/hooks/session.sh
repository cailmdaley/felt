#!/bin/bash
# SessionStart hook for the felt plugin.
#
# Thin shim: the binary owns the logic. `felt hook session` (added in
# v1.0.8) walks for the project root, lists active and recently-touched
# fibers, and emits the SessionStart additionalContext envelope. Keeping
# behavior in the binary means `brew upgrade felt` refreshes hook
# behavior; the plugin only needs refreshing when skill content changes.
#
# Defensive probe: if felt is missing OR is an older binary without the
# `hook` subcommand, fall back to a minimal envelope instead of letting
# the hook fail. This handles the transition window where users have a
# newer plugin against an older binary (or vice versa).
#
# Wired into both Claude Code (via hooks.json) and Codex (via
# ~/.codex/hooks.json, pointing at the symlinked copy).

set -e

if command -v felt >/dev/null 2>&1 && felt hook --help >/dev/null 2>&1; then
    exec felt hook session
fi

# Fallback: emit a minimal envelope. Two distinct cases collapse into the
# same message — either felt isn't installed, or it's pre-1.0.8 and lacks
# the hook subcommand — and the user-facing fix is the same: get a newer
# felt onto PATH.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "# Felt Workflow Context\n\n*The installed `felt` binary is missing or too old (needs >= v1.0.8 for the `felt hook session` subcommand). Run `brew upgrade felt` or install from https://github.com/cailmdaley/felt to restore active-fiber listings.*\n"
  }
}
EOF
