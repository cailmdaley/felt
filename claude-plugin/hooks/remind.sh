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

# Read and replay stdin using builtins only. Optimize canonical Claude JSON;
# ambiguous/escaped keys and paths fall through to Go's authoritative decoder.
input=
IFS= read -r -d '' input || true
session_prefix='^[[:space:]]*\{[[:space:]]*"session_id"[[:space:]]*:[[:space:]]*"([A-Za-z0-9_-]+)"[[:space:]]*[,}]'
transcript_field='"transcript_path"[[:space:]]*:[[:space:]]*"([^"\\]*)"[[:space:]]*[,}]'
single_field() {
  local field="\"$1\"[[:space:]]*:" rest
  [[ $input =~ $field ]] || return 1
  rest=${input#*"${BASH_REMATCH[0]}"}
  [[ ! $rest =~ $field ]]
}
# encoding/json accepts case-insensitive keys and uses the last occurrence.
# Reject duplicates (including nested ones) rather than choosing the first.
# Unicode escapes can hide another occurrence, so defer those payloads too.
shopt -s nocasematch
if [[ $input != *'\u'* ]] && single_field session_id &&
   single_field transcript_path && [[ $input =~ $session_prefix ]]; then
  session_id=${BASH_REMATCH[1]}
  if [[ $input =~ $transcript_field ]]; then
    transcript_path=${BASH_REMATCH[1]}
    # Marker values and paths must compare case-sensitively, like Go.
    shopt -u nocasematch
    marker=
    if [[ -n $transcript_path && -f ${TMPDIR:-/tmp}/felt-reminded-$session_id ]]; then
      IFS= read -r -d '' marker < "${TMPDIR:-/tmp}/felt-reminded-$session_id" || true
      if [[ $marker == "v1:\"$transcript_path\""$'\n' ]]; then exit 0; fi
    fi
  fi
fi
shopt -u nocasematch

source "${0%/*}/felt-bin.sh"

# A missing or old felt binary should lose the reminder gate, not block every
# tool call in the session.
if felt_hook_available; then
  "$FELT_BIN" hook pretool <<<"$input" 2>/dev/null || true
fi

exit 0
