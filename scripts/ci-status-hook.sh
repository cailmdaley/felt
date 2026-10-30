#!/bin/sh
# SessionStart reads the local cache, then refreshes it off the hook path.
# An optional deployment SHA gets a synchronous, advisory query of its own.
command -v node >/dev/null 2>&1 || exit 0
cd "$(dirname "$0")/.." 2>/dev/null || exit 0
node scripts/ci-status.mjs "$@" 2>/dev/null || true
