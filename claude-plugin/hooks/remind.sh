#!/bin/bash
# PreToolUse hook for the felt plugin.
#
# Thin shim: the binary owns the gate. `felt hook pretool` reads the
# PreToolUse payload from stdin and emits either a deny envelope (felt
# skill not yet activated in a felt-enabled project) or nothing (pass
# through). See `felt hook pretool --help` for the full rule set.
#
# Keeping behavior in the binary means `brew upgrade felt` refreshes hook
# behavior; the plugin only needs refreshing when skill content changes.

set -e

if command -v felt >/dev/null 2>&1; then
    exec felt hook pretool
fi

# felt binary missing: silent pass. Better to lose the gate than block every
# tool call when the user's PATH is misconfigured.
exit 0
