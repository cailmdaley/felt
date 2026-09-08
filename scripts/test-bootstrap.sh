#!/usr/bin/env bash
# Exercise bootstrap's login PATH and fail-fast boundaries without installing
# binaries, registering harnesses, or touching the caller's home/services.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/felt-bootstrap-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
BASH_BIN=$(command -v bash)
ENV_BIN=$(command -v env)
mkdir -p "$WORK/bin" "$WORK/node-bin" "$WORK/home"

# The inherited PATH deliberately has no node/npm. The actual login shell
# reads our disposable .bash_profile and gains them only in the first case.
for tool in dirname mkdir; do
  ln -s "$(command -v "$tool")" "$WORK/bin/$tool"
done
ln -s "$BASH_BIN" "$WORK/bin/bash"
cat > "$WORK/bin/uname" <<'STUB'
#!/bin/bash
printf 'Darwin\n'
STUB
for tool in mix tmux felt node npm; do
  cat > "$WORK/bin/$tool" <<'STUB'
#!/bin/bash
exit 0
STUB
done
mv "$WORK/bin/node" "$WORK/bin/npm" "$WORK/node-bin/"
cat > "$WORK/bin/make" <<'STUB'
#!/bin/bash
printf '%s\n' "$*" >> "$BOOTSTRAP_TEST_CALLS"
if [[ " $* " == *' ui '* && "${BOOTSTRAP_TEST_FAIL_UI:-0}" == 1 ]]; then
  exit 42
fi
STUB
chmod +x "$WORK/bin/uname" "$WORK/bin/mix" "$WORK/bin/tmux" \
  "$WORK/bin/felt" "$WORK/bin/make" "$WORK/node-bin/"*

login_path() {
  printf 'export PATH=%q\n' "$1" > "$WORK/home/.bash_profile"
}
run_bootstrap() {
  "$ENV_BIN" -i HOME="$WORK/home" PATH="$WORK/bin" \
    BOOTSTRAP_TEST_CALLS="$WORK/calls" BOOTSTRAP_TEST_FAIL_UI="${FAIL_UI:-0}" \
    "$BASH_BIN" "$REPO/scripts/bootstrap.sh" --skip-cli --skip-hook "$@" \
    > "$WORK/output" 2>&1
}
fail() { cat "$WORK/output" >&2; printf 'FAIL: %s\n' "$*" >&2; exit 1; }

login_path "$WORK/bin:$WORK/node-bin"
run_bootstrap --dry-run || fail 'login shell did not find node/npm'
grep -F "node ($WORK/node-bin/node)" "$WORK/output" >/dev/null \
  || fail 'node did not resolve through the login profile'
[ ! -e "$WORK/calls" ] && [ ! -e "$WORK/home/.shuttle" ] \
  || fail 'dry run changed installation state'
printf 'PASS: login shell finds Node absent from inherited PATH\n'

login_path "$WORK/bin"
if run_bootstrap; then fail 'missing Node allowed installation'; fi
grep -F 'node — MISSING' "$WORK/output" >/dev/null || fail 'missing Node not diagnosed'
[ ! -e "$WORK/calls" ] && [ ! -e "$WORK/home/.shuttle" ] \
  || fail 'missing Node reached installation writes'
printf 'PASS: missing Node fails before installation writes\n'

login_path "$WORK/bin:$WORK/node-bin"
FAIL_UI=1
if run_bootstrap; then fail 'UI build failure reported success'; fi
grep -F 'UI bundle build failed.' "$WORK/output" >/dev/null || fail 'UI failure not diagnosed'
[ "$(wc -l < "$WORK/calls" | tr -d ' ')" = 2 ] || fail 'unexpected build or service operation'
grep -F ' daemon SKIP_CLI=1' "$WORK/calls" >/dev/null || fail 'daemon build not exercised'
grep -F ' ui' "$WORK/calls" >/dev/null || fail 'UI build not exercised'
printf 'PASS: failed UI build aborts before harness/service installation\n'
