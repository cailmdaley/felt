#!/bin/bash
# PreToolUse hook for the felt plugin.
#
# Thin shim: the binary owns the gate. `felt hook pretool` reads the
# PreToolUse payload from stdin and emits either a deny envelope (felt
# skill not yet activated in a felt-enabled project) or nothing (pass
# through). See `felt hook pretool --help` for the full rule set.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so this script always runs against a matching binary.

set -e

# Claude emits session_id first. Only optimize this unambiguous canonical
# prefix; other JSON layouts still go through the Go decoder. Read stdin with
# a shell builtin and replay it without cat/jq/dirname or a binary probe.
input=
IFS= read -r -d '' input || true
session_prefix='^[[:space:]]*\{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9_-]+)"[[:space:]]*[,}]'
if [[ $input =~ $session_prefix ]] &&
   [[ -f ${TMPDIR:-/tmp}/felt-reminded-${BASH_REMATCH[1]} ]]; then
  exit 0
fi

source "${0%/*}/felt-bin.sh"

# A missing or old felt binary should lose the reminder gate, not block every
# tool call in the session.
if felt_hook_available; then
  "$FELT_BIN" hook pretool <<<"$input" 2>/dev/null || true
fi

exit 0
