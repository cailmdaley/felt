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
for tool in dirname mkdir cat grep id; do
  ln -s "$(command -v "$tool")" "$WORK/bin/$tool"
done
ln -s "$BASH_BIN" "$WORK/bin/bash"
cat > "$WORK/bin/uname" <<'STUB'
#!/bin/bash
printf 'Darwin\n'
STUB
cat > "$WORK/bin/hostname" <<'STUB'
#!/bin/bash
printf 'login-a\n'
STUB
for tool in mix tmux felt shuttle node npm; do
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
chmod +x "$WORK/bin/uname" "$WORK/bin/hostname" "$WORK/bin/mix" "$WORK/bin/tmux" \
  "$WORK/bin/felt" "$WORK/bin/shuttle" "$WORK/bin/make" "$WORK/node-bin/"*

login_path() {
  printf 'export PATH=%q\n' "$1" > "$WORK/home/.bash_profile"
}
run_bootstrap() {
  "$ENV_BIN" -i HOME="$WORK/home" PATH="$WORK/bin" \
    SHELL=/bin/bash \
    SHUTTLE_OWNER_NODE="${SHUTTLE_OWNER_NODE:-}" \
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

login_path "$WORK/bin:$WORK/node-bin"
mv "$WORK/bin/shuttle" "$WORK/shuttle-stub"
if run_bootstrap --dry-run; then fail 'missing shuttle allowed dry-run'; fi
grep -F 'shuttle — MISSING' "$WORK/output" >/dev/null || fail 'missing shuttle not diagnosed'
[ ! -e "$WORK/calls" ] && [ ! -e "$WORK/home/.shuttle" ] \
  || fail 'missing shuttle reached installation writes'
mv "$WORK/shuttle-stub" "$WORK/bin/shuttle"
printf 'PASS: --skip-cli requires both felt and shuttle\n'

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

# Exercise the Linux installation with an existing link to the source itself.
unset FAIL_UI
for tool in cp chmod rm; do ln -s "$(command -v "$tool")" "$WORK/bin/$tool"; done
printf '#!/bin/bash\nprintf "Linux\\n"\n' > "$WORK/bin/uname"
printf '#!/bin/bash\nexit 0\n' > "$WORK/bin/systemctl"
chmod +x "$WORK/bin/systemctl"
mkdir -p "$WORK/home/.local/bin"
ln -s "$REPO/bin/shuttle-launch" "$WORK/home/.local/bin/shuttle-launch"
ln -s "$REPO/bin/tailscaled-launch" "$WORK/home/.local/bin/tailscaled-launch"
ln -s "$REPO/bin/shuttle-ensure" "$WORK/home/.local/bin/shuttle-ensure"
rm -f "$WORK/home/.bash_profile"
printf 'export PATH=%q\n' "$WORK/bin:$WORK/node-bin" > "$WORK/home/.profile"
run_bootstrap || fail 'Linux bootstrap could not replace a link to shuttle-launch'
[ ! -L "$WORK/home/.local/bin/shuttle-launch" ] || fail 'launcher remains a symlink'
[ ! -L "$WORK/home/.local/bin/tailscaled-launch" ] || fail 'tailscaled launcher remains a symlink'
[ ! -L "$WORK/home/.local/bin/shuttle-ensure" ] || fail 'ensure remains a symlink'
cmp "$REPO/bin/shuttle-launch" "$WORK/home/.local/bin/shuttle-launch" || fail 'launcher differs from source'
cmp "$REPO/bin/shuttle-ensure" "$WORK/home/.local/bin/shuttle-ensure" || fail 'ensure differs from source'
[ "$(cat "$WORK/home/.shuttle/owner-node")" = login-a ] || fail 'owner login node was not recorded'
grep -F '# shuttle-ensure' "$WORK/home/.profile" >/dev/null || fail 'existing login profile does not invoke ensure'
SHUTTLE_OWNER_NODE=login-b run_bootstrap || fail 'bootstrap could not update owner-node override'
[ "$(cat "$WORK/home/.shuttle/owner-node")" = login-b ] || fail 'owner-node override did not replace recorded node'
! grep -F 'install-agent' "$WORK/calls" >/dev/null || fail 'bootstrap started a supervisor from the non-owner node'
printf 'PASS: Linux bootstrap replaces a launcher symlink to its source\n'
