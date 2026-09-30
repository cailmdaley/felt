#!/bin/bash
# PostToolUse hook for the felt plugin, on Bash calls.
#
# Thin shim: `shuttle hook commit` reads the
# PostToolUse payload from stdin and, when the Bash call ran a `git commit`,
# appends one JSON line to the host-local commit ledger
# (~/.shuttle/commits.jsonl by default) pairing the commit with the session
# that made it. It prints nothing, exits 0 on every path, and writes nothing at
# all on a host with no Shuttle state directory. See `shuttle hook commit --help`.

set -e

source "$(dirname "$0")/shuttle-bin.sh"

# A missing or old shuttle binary should lose the ledger entry, not fail the
# Bash call that just committed.
if shuttle_hook_available; then
  exec "$SHUTTLE_BIN" hook commit
fi

exit 0
