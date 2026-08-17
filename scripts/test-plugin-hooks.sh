#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hooks="$repo_root/claude-plugin/hooks"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/felt-plugin-hooks.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

minimal_env=(env -i HOME="$tmp_dir/home" PATH="/usr/bin:/bin" FELT_BIN=)

# ── phase 1: felt absent ─────────────────────────────────────────────────
#
# The sandbox suppresses PATH and HOME, but felt-bin.sh also probes two
# absolute paths no environment can hide. On a host with felt installed at
# either one, the loop finds it and this phase would silently exercise the
# real-felt branch while still matching a bare hookEventName grep. So name the
# two cases and assert the one that is actually reachable.
if [ -x /opt/homebrew/bin/felt ] || [ -x /usr/local/bin/felt ]; then
  felt_absent=0
  echo "note: felt is installed at an absolute probe path — phase 1 covers the felt-present branch here"
else
  felt_absent=1
fi

session_output="$("${minimal_env[@]}" "$hooks/session.sh" </dev/null)"
grep -q '"hookEventName": "SessionStart"' <<<"$session_output"
if [ "$felt_absent" = 1 ]; then
  # The fallback envelope, identified by its own sentence rather than by the
  # envelope shape both branches share.
  grep -q 'missing or too old' <<<"$session_output"
fi

for hook in event.sh remind.sh touch.sh commit.sh; do
  "${minimal_env[@]}" "$hooks/$hook" </dev/null
done

# ── phase 2: felt present ────────────────────────────────────────────────
#
# $HOME/.local/bin is first in the candidate list, so this fake wins over any
# real felt the host happens to have — the felt-present branch is covered on
# purpose, not by accident of the runner's install layout.
mkdir -p "$tmp_dir/home/.local/bin"
cat > "$tmp_dir/home/.local/bin/felt" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "hook" ] && [ "${2:-}" = "--help" ]; then
  exit 0
fi
printf '%s\n' "$*" > "${FELT_TEST_ARGS:?}"
cat
EOF
chmod +x "$tmp_dir/home/.local/bin/felt"

felt_present_env=(env -i HOME="$tmp_dir/home" PATH="/usr/bin:/bin" FELT_BIN=)

args_file="$tmp_dir/args"
printf '%s\n' '{}' | "${felt_present_env[@]}" FELT_TEST_ARGS="$args_file" "$hooks/event.sh"
grep -q '^hook event$' "$args_file"

# session.sh takes one of two felt-present routes depending on whether jq is
# reachable — `felt session | jq` or `felt hook session`. Either way it must
# reach the binary and must NOT fall through to the missing-felt envelope.
session_args="$tmp_dir/session-args"
session_present="$("${felt_present_env[@]}" FELT_TEST_ARGS="$session_args" \
  "$hooks/session.sh" </dev/null)"
grep -qE '^(hook )?session$' "$session_args"
! grep -q 'missing or too old' <<<"$session_present"

grep -q '\${CLAUDE_PLUGIN_ROOT:-\$PLUGIN_ROOT}' "$hooks/hooks.json"
echo "plugin hook tests passed"
