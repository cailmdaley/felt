#!/bin/bash
# SessionStart hook for the felt plugin.
#
# Thin shim: the binary owns the logic. `felt hook session` walks for the
# project root, lists active and recently-touched fibers, and emits the
# SessionStart additionalContext envelope.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so a session that runs this script also has the matching
# binary on PATH. Wired into both Claude Code (via hooks.json) and Codex
# (via ~/.codex/hooks.json, pointing at the symlinked copy).

set -e
exec felt hook session
