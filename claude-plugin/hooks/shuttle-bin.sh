#!/bin/bash
# Resolve the shuttle executable for Shuttle-owned hooks.
#
# Callers source this file and use SHUTTLE_BIN instead of invoking a bare
# `shuttle`, which may be missing from GUI-launched agent processes' PATH.

SHUTTLE_BIN="${SHUTTLE_BIN:-}"

if [ -n "$SHUTTLE_BIN" ] && [ -x "$SHUTTLE_BIN" ]; then
  :
else
  SHUTTLE_BIN="$(command -v shuttle 2>/dev/null || true)"
  if [ -z "$SHUTTLE_BIN" ] && [ -n "${HOME:-}" ]; then
    for candidate in \
      "$HOME/.local/bin/shuttle" \
      "/opt/homebrew/bin/shuttle" \
      "/usr/local/bin/shuttle"; do
      if [ -x "$candidate" ]; then
        SHUTTLE_BIN="$candidate"
        break
      fi
    done
  fi
fi

shuttle_hook_available() {
  [ -n "$SHUTTLE_BIN" ] && "$SHUTTLE_BIN" hook --help >/dev/null 2>&1
}
