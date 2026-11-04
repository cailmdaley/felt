#!/bin/bash
# The Go CLI owns payload decoding and transcript-bound activation state.
# Keep this adapter stable across binary upgrades.
source "${0%/*}/felt-bin.sh"
if felt_hook_available; then
  "$FELT_BIN" hook pretool 2>/dev/null || true
fi
exit 0
