#!/bin/bash
# Optional Go adapter; an absent/old binary or broken transcript never blocks.
source "${0%/*}/shuttle-bin.sh"
if shuttle_hook_available; then
  # Older Cobra command trees can print help and exit 0 for an unknown child.
  # Only a hook envelope belongs on stdout; never inject that help into Claude.
  output="$("$SHUTTLE_BIN" hook handoff 2>/dev/null)" || output=
  if [[ $output == \{* ]]; then printf '%s\n' "$output"; fi
fi
exit 0
