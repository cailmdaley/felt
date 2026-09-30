#!/bin/bash
# Activity-stream hook for the felt plugin — registered on every event the
# Shuttle daemon ranks on.
#
# Thin shim: `shuttle hook event` reads the payload from stdin and appends one
# JSON line to the host-local stream (~/.shuttle/events.jsonl by default). It
# also offers queued peer context on supported Claude and Codex hooks, without
# continuing Stop events. It exits 0 on every path and writes nothing at all on
# a host with no Shuttle state directory. See `shuttle hook event --help`.

set -e

source "$(dirname "$0")/shuttle-bin.sh"

# Hooks must not make every agent event fail when the optional CLI is absent
# or predates the `hook` subcommand.
if shuttle_hook_available; then
  exec "$SHUTTLE_BIN" hook event
fi

exit 0
