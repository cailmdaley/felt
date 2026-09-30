#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hooks="$repo_root/claude-plugin/hooks"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/felt-plugin-hooks.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

bare_path="$tmp_dir/bare-path"
mkdir -p "$bare_path"
ln -s "$(command -v dirname)" "$bare_path/dirname"
ln -s "$(command -v cat)" "$bare_path/cat"
base_env=(env -i PATH="$bare_path" FELT_BIN= SHUTTLE_BIN=)

write_fake() {
  local binary="$1"
  local args_file="$2"
  mkdir -p "$(dirname "$binary")"
  cat > "$binary" <<EOF
#!/bin/bash
if [ "\${1:-}" = "hook" ] && [ "\${2:-}" = "--help" ]; then
  exit 0
fi
printf '%s\\n' "\$*" >> "$args_file"
/bin/cat >/dev/null
EOF
  chmod +x "$binary"
}

has_system_binary() {
  local binary="$1"
  [ -x "/opt/homebrew/bin/$binary" ] || [ -x "/usr/local/bin/$binary" ]
}

assert_arg() {
  local file="$1"
  local expected="$2"
  grep -Fxq -- "$expected" "$file" || {
    echo "expected '$expected' in $file" >&2
    return 1
  }
}

# ── shuttle present, felt absent ─────────────────────────────────────────
# This isolates each missing-binary behavior; a machine-wide Felt install at
# one of the fixed absolute probes makes the felt-absent branch unreachable.
shuttle_home="$tmp_dir/home-shuttle-only"
shuttle_args="$tmp_dir/shuttle-only-args"
write_fake "$shuttle_home/.local/bin/shuttle" "$shuttle_args"
shuttle_only_env=(env -i HOME="$shuttle_home" PATH="$bare_path" FELT_BIN= SHUTTLE_BIN=)
printf '%s\n' '{}' | "${shuttle_only_env[@]}" "$hooks/event.sh"
printf '%s\n' '{}' | "${shuttle_only_env[@]}" "$hooks/commit.sh"
assert_arg "$shuttle_args" 'hook event'
assert_arg "$shuttle_args" 'hook commit'

if ! has_system_binary felt; then
  session_output="$("${base_env[@]}" HOME="$shuttle_home" "$hooks/session.sh" </dev/null)"
  grep -q 'missing or too old' <<<"$session_output"
  for hook in remind.sh touch.sh; do
    output="$("${base_env[@]}" HOME="$shuttle_home" "$hooks/$hook" </dev/null 2>&1)"
    [ -z "$output" ]
  done
else
  echo "note: felt absence is unreachable because a fixed system probe has felt; its independent absent case is skipped"
fi

# ── felt present, shuttle absent ─────────────────────────────────────────
# A machine-wide Shuttle install likewise makes this absence unreachable.
felt_home="$tmp_dir/home-felt-only"
felt_args="$tmp_dir/felt-only-args"
write_fake "$felt_home/.local/bin/felt" "$felt_args"
printf '%s\n' '{}' | "${base_env[@]}" HOME="$felt_home" FELT_TEST_ARGS="$felt_args" "$hooks/session.sh" >/dev/null
printf '%s\n' '{}' | "${base_env[@]}" HOME="$felt_home" FELT_TEST_ARGS="$felt_args" "$hooks/remind.sh"
printf '%s\n' '{}' | "${base_env[@]}" HOME="$felt_home" FELT_TEST_ARGS="$felt_args" "$hooks/touch.sh"
assert_arg "$felt_args" 'hook session'
assert_arg "$felt_args" 'hook pretool'
assert_arg "$felt_args" 'hook posttool'

if ! has_system_binary shuttle; then
  for hook in event.sh commit.sh; do
    output="$("${base_env[@]}" HOME="$felt_home" "$hooks/$hook" </dev/null 2>&1)"
    [ -z "$output" ]
  done
else
  echo "note: shuttle absence is unreachable because a fixed system probe has shuttle; its independent absent case is skipped"
fi

# ── both binaries present ─────────────────────────────────────────────────
both_home="$tmp_dir/home-both"
felt_args="$tmp_dir/both-felt-args"
shuttle_args="$tmp_dir/both-shuttle-args"
write_fake "$both_home/.local/bin/felt" "$felt_args"
write_fake "$both_home/.local/bin/shuttle" "$shuttle_args"
both_env=(env -i HOME="$both_home" PATH="$bare_path" FELT_BIN= SHUTTLE_BIN= FELT_TEST_ARGS="$felt_args" SHUTTLE_TEST_ARGS="$shuttle_args")

printf '%s\n' '{}' | "${both_env[@]}" "$hooks/event.sh"
printf '%s\n' '{}' | "${both_env[@]}" "$hooks/commit.sh"
printf '%s\n' '{}' | "${both_env[@]}" "$hooks/remind.sh"
printf '%s\n' '{}' | "${both_env[@]}" "$hooks/touch.sh"

# With no jq available, session.sh uses Felt's hook adapter.
session_output="$("${both_env[@]}" "$hooks/session.sh" </dev/null)"
! grep -q 'missing or too old' <<<"$session_output"
assert_arg "$felt_args" 'hook session'
assert_arg "$felt_args" 'hook pretool'
assert_arg "$felt_args" 'hook posttool'
assert_arg "$shuttle_args" 'hook event'
assert_arg "$shuttle_args" 'hook commit'
! grep -Eq '^hook (event|commit)$' "$felt_args"
! grep -Eq '^hook (pretool|posttool|session)$' "$shuttle_args"

# With jq available, SessionStart takes the felt session-context route and
# emits exactly one harness envelope.
jq_path="$tmp_dir/jq-path"
mkdir -p "$jq_path"
ln -s "$(command -v dirname)" "$jq_path/dirname"
cat > "$jq_path/jq" <<'EOF'
#!/bin/bash
/bin/cat >/dev/null
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"stub"}}\n'
EOF
chmod +x "$jq_path/jq"
jq_output="$(env -i HOME="$both_home" PATH="$jq_path:$bare_path" FELT_BIN= SHUTTLE_BIN= FELT_TEST_ARGS="$felt_args" SHUTTLE_TEST_ARGS="$shuttle_args" "$hooks/session.sh" </dev/null)"
[ "$(grep -c hookEventName <<<"$jq_output")" = 1 ]
assert_arg "$felt_args" 'session'

# Hook registrations stay in the combined plugin; only the binary owner changes.
grep -q '\${CLAUDE_PLUGIN_ROOT:-\$PLUGIN_ROOT}' "$hooks/hooks.json"
echo "plugin hook tests passed"
