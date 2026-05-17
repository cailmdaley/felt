#!/bin/bash
# PreToolUse hook for the felt plugin.
#
# Thin shim: the binary owns the gate. `felt hook pretool` (added in
# v1.0.8) reads the PreToolUse payload from stdin and emits either a
# deny envelope (felt skill not yet activated in a felt-enabled project)
# or nothing (pass through). See `felt hook pretool --help` for the full
# rule set.
#
# Defensive probe: if felt is missing OR is an older binary without the
# `hook` subcommand, pass silently. Better to lose the gate than block
# every tool call when the binary is out of date.
#
# Keeping behavior in the binary means `brew upgrade felt` refreshes hook
# behavior; the plugin only needs refreshing when skill content changes.

set -e

if command -v felt >/dev/null 2>&1 && felt hook --help >/dev/null 2>&1; then
    exec felt hook pretool
fi

exit 0
