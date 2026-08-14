#!/bin/bash
# Resolve the felt executable for GUI-launched agent processes.
#
# Codex and Claude Code may start without a login shell, so ~/.local/bin is
# not guaranteed to be on PATH even when felt is installed there. Callers
# source this file and use FELT_BIN instead of invoking bare `felt`.

FELT_BIN="${FELT_BIN:-}"

if [ -n "$FELT_BIN" ] && [ -x "$FELT_BIN" ]; then
  :
else
  FELT_BIN="$(command -v felt 2>/dev/null || true)"
  if [ -z "$FELT_BIN" ] && [ -n "${HOME:-}" ]; then
    for candidate in \
      "$HOME/.local/bin/felt" \
      "$HOME/loom/bin/felt" \
      "/opt/homebrew/bin/felt" \
      "/usr/local/bin/felt"; do
      if [ -x "$candidate" ]; then
        FELT_BIN="$candidate"
        break
      fi
    done
  fi
fi

felt_hook_available() {
  [ -n "$FELT_BIN" ] && "$FELT_BIN" hook --help >/dev/null 2>&1
}
