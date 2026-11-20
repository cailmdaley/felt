#!/bin/bash
# Activity-stream hook for the felt plugin — registered on every event the
# Shuttle daemon ranks on.
#
# Thin shim: `shuttle hook event` reads the payload from stdin and appends one
# JSON line to the host-local stream (~/.shuttle/events.jsonl by default). It
# also offers queued peer context on supported Claude and Codex hooks, without
# continuing Stop events. It exits 0 on every path and writes nothing at all on
# a host with no Shuttle state directory. See `shuttle hook event --help`.
#
# The first argument names the harness running the hook: hooks.json passes
# `claude`, and the Codex bundle's copy passes `codex`. It reaches shuttle as
# SHUTTLE_HOOK_HARNESS, which a shuttle that predates it ignores.

set -e

source "${0%/*}/shuttle-bin.sh"

# Hooks must not make every agent event fail when the optional CLI is absent
# or predates the `hook` subcommand.
if shuttle_hook_available; then
  SHUTTLE_HOOK_HARNESS="${1:-}" "$SHUTTLE_BIN" hook event 2>/dev/null || true
fi

exit 0
