#!/bin/bash
# Activity-stream hook for the felt plugin — registered on every event the
# Shuttle daemon ranks on.
#
# Thin shim: the binary owns the logic. `felt hook event` reads the payload from
# stdin and appends one JSON line to the host-local stream
# (~/.shuttle/events.jsonl by default) that lib/shuttle/waiting_tracker.ex and
# lib/shuttle/sent_files.ex tail. It prints nothing, exits 0 on every path, and
# writes nothing at all on a host with no Shuttle state directory. See
# `felt hook event --help`.
#
# `felt update` and brew's post-install refresh both binary and plugin
# together, so this script always runs against a matching binary.

set -e
exec felt hook event
