#!/bin/bash
# PostToolUse hook for the felt plugin, on Bash calls.
#
# Thin shim: the binary owns the logic. `felt hook commit` reads the
# PostToolUse payload from stdin and, when the Bash call ran a `git commit`,
# appends one JSON line to the host-local commit ledger
# (~/.shuttle/commits.jsonl by default) pairing the commit with the session
# that made it. It prints nothing, exits 0 on every path, and writes nothing at
# all on a host with no Shuttle state directory. See `felt hook commit --help`.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so this script always runs against a matching binary.

set -e

source "$(dirname "$0")/felt-bin.sh"

# A missing or old felt binary should lose the ledger entry, not fail the Bash
# call that just committed.
if felt_hook_available; then
  exec "$FELT_BIN" hook commit
fi

exit 0
