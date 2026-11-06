#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/felt-tailscaled-launch.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home/.shuttle"
printf 'owner\n' > "$WORK/home/.shuttle/owner-node"

cat > "$WORK/bin/hostname" <<'STUB'
#!/bin/sh
printf '%s\n' "$TEST_NODE"
STUB
cat > "$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_WORK/systemctl-calls"
case "$*" in
  '--user is-enabled --quiet tailscaled.service') [ "$TEST_UNIT" = enabled ] ;;
  '--user is-active --quiet tailscaled.service') [ "$TEST_UNIT" = active ] ;;
  '--user start tailscaled.service'|'--user restart tailscaled.service') exit "$TEST_STATUS" ;;
  *) exit 99 ;;
esac
STUB
cat > "$WORK/bin/tmux" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_WORK/tmux-calls"
case "$1" in
  has-session) [ "$TEST_TMUX" = active ] ;;
  kill-session|new-session) exit 0 ;;
  *) exit 99 ;;
esac
STUB
chmod +x "$WORK/bin/"*

run_launcher() {
  env HOME="$WORK/home" PATH="$WORK/bin:/usr/bin:/bin" \
    SHUTTLE_OWNER_NODE_FILE="$WORK/home/.shuttle/owner-node" \
    TAILSCALED_STATE="$WORK/state" TAILSCALED_HTTP_PROXY= TAILSCALED_SOCKS5= \
    TEST_WORK="$WORK" TEST_NODE="${NODE:-owner}" TEST_UNIT="$UNIT" \
    TEST_STATUS="${STATUS:-0}" TEST_TMUX="${TMUX_STATE:-absent}" \
    /bin/sh "$REPO/bin/tailscaled-launch" "$@" > "$WORK/output" 2>&1
}
reset_calls() {
  : > "$WORK/systemctl-calls"
  : > "$WORK/tmux-calls"
}
assert_action() {
  [ "$(grep -Ec '^--user (start|restart) tailscaled.service$' "$WORK/systemctl-calls")" = 1 ]
  grep -Fxq -- "--user $1 tailscaled.service" "$WORK/systemctl-calls"
  [ ! -s "$WORK/tmux-calls" ]
  [ ! -e "$WORK/state" ]
}

# Enabled-but-inactive and active-but-disabled units both own launch/restart.
# Service routing needs neither the fallback binary nor its state directory.
for UNIT in enabled active; do
  for action in start restart; do
    set --
    [ "$action" != restart ] || set -- --restart
    reset_calls
    run_launcher "$@"
    assert_action "$action"

    # A selected supervisor's failure propagates exactly; tmux never takes over.
    reset_calls
    status=0
    STATUS=37 run_launcher "$@" || status=$?
    [ "$status" = 37 ]
    assert_action "$action"
  done
done

# The shared-home owner gate runs before any service probing or tmux calls.
UNIT=enabled
for action in start restart; do
  set --
  [ "$action" != restart ] || set -- --restart
  reset_calls
  NODE=other run_launcher "$@"
  [ ! -s "$WORK/systemctl-calls" ]
  [ ! -s "$WORK/tmux-calls" ]
  grep -Fq "belongs to login node 'owner'" "$WORK/output"
done

# The fallback runs only a stub binary, never the host's tailscaled.
cat > "$WORK/bin/tailscaled" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$TEST_WORK/tailscaled-calls"
STUB
# End the foreground loop at its first backoff, without any real daemon.
cat > "$WORK/bin/sleep" <<'STUB'
#!/bin/sh
kill -TERM "$PPID"
STUB
chmod +x "$WORK/bin/tailscaled" "$WORK/bin/sleep"
UNIT=absent
reset_calls
run_launcher
grep -Fxq -- '--user is-enabled --quiet tailscaled.service' "$WORK/systemctl-calls"
grep -Fxq -- '--user is-active --quiet tailscaled.service' "$WORK/systemctl-calls"
grep -Fxq 'has-session -t tailscaled' "$WORK/tmux-calls"
grep -Fq 'new-session -d -s tailscaled ' "$WORK/tmux-calls"
grep -Fq "'$REPO/bin/tailscaled-launch' --loop" "$WORK/tmux-calls"
if grep -Eq '^--user (start|restart) ' "$WORK/systemctl-calls"; then
  echo 'absent service received a start/restart' >&2
  exit 1
fi

reset_calls
TMUX_STATE=active run_launcher
[ "$(cat "$WORK/tmux-calls")" = 'has-session -t tailscaled' ]
reset_calls
TMUX_STATE=active run_launcher --restart
grep -Fxq 'kill-session -t tailscaled' "$WORK/tmux-calls"
grep -Fq 'new-session -d -s tailscaled ' "$WORK/tmux-calls"

# Explicit --loop bypasses even an enabled service, avoiding supervisor recursion.
UNIT=enabled
reset_calls
status=0
run_launcher --loop || status=$?
[ "$status" = 143 ]
[ ! -s "$WORK/systemctl-calls" ]
[ ! -s "$WORK/tmux-calls" ]
grep -Fq -- '--tun=userspace-networking' "$WORK/tailscaled-calls"
printf 'PASS: service start/restart, failure propagation, owner guard, tmux fallback, and explicit loop\n'
