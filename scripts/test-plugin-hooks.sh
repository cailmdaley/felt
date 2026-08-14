#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
hooks="$repo_root/claude-plugin/hooks"
tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/felt-plugin-hooks.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

minimal_env=(env -i HOME="$tmp_dir/home" PATH="/usr/bin:/bin" FELT_BIN=)

session_output="$("${minimal_env[@]}" "$hooks/session.sh")"
grep -q '"hookEventName": "SessionStart"' <<<"$session_output"

for hook in event.sh remind.sh touch.sh; do
  "${minimal_env[@]}" "$hooks/$hook" </dev/null
done

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

args_file="$tmp_dir/args"
printf '%s\n' '{}' | env -i \
  HOME="$tmp_dir/home" PATH="/usr/bin:/bin" FELT_BIN= FELT_TEST_ARGS="$args_file" \
  "$hooks/event.sh"
grep -q '^hook event$' "$args_file"

grep -q '\${CLAUDE_PLUGIN_ROOT:-\$PLUGIN_ROOT}' "$hooks/hooks.json"
echo "plugin hook tests passed"
