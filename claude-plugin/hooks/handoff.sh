#!/bin/bash
# Optional Go adapter; an absent/old binary or broken transcript never blocks.
source "${0%/*}/shuttle-bin.sh"
if shuttle_hook_available; then
  "$SHUTTLE_BIN" hook handoff 2>/dev/null || true
fi
exit 0
