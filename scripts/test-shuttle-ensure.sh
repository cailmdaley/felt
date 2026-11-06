#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/felt-ensure-test.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home/.local/bin" "$WORK/home/.shuttle" "$WORK/home/.local/state/tailscale" "$WORK/sessions"
printf 'owner\n' > "$WORK/home/.shuttle/owner-node"
printf 'state\n' > "$WORK/home/.local/state/tailscale/tailscaled.state"
printf 'owner\n' > "$WORK/node"
: > "$WORK/created"
: > "$WORK/systemctl-calls"
: > "$WORK/recovery-args"
: > "$WORK/loop-checks"
: > "$WORK/completed"
: > "$WORK/calls"

cat > "$WORK/bin/hostname" <<'STUB'
#!/bin/sh
cat "$SHUTTLE_TEST_NODE"
STUB
cat > "$WORK/bin/tmux" <<'STUB'
#!/bin/sh
[ -d "$SHUTTLE_TEST_SESSIONS/$3" ]
STUB
cat > "$WORK/bin/tailscaled-launch" <<'STUB'
#!/bin/sh
if mkdir "$SHUTTLE_TEST_SESSIONS/tailscaled" 2>/dev/null; then
  printf '%s\n' tailscaled >> "$SHUTTLE_TEST_CREATED"
fi
STUB
cat > "$WORK/bin/shuttle" <<'STUB'
#!/bin/sh
printf '%s\n' checked >> "$SHUTTLE_TEST_LOOP_CHECKS"
if [ "$SHUTTLE_TEST_LOOP_COHORT" -gt 0 ]; then
  for _ in $(seq 1 100); do
    [ "$(wc -l < "$SHUTTLE_TEST_LOOP_CHECKS")" -ge "$SHUTTLE_TEST_LOOP_COHORT" ] && break
    sleep 0.05
  done
fi
[ -d "$SHUTTLE_TEST_SESSIONS/shuttle-daemon" ]
STUB
cat > "$WORK/bin/systemctl" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "$SHUTTLE_TEST_SYSTEMCTL_CALLS"
case "$SHUTTLE_TEST_SYSTEMD_MODE:$*" in
  active:--user\ is-active\ --quiet\ shuttle-daemon.service)
    printf '%s\n' active-complete >> "$SHUTTLE_TEST_SYSTEMCTL_CALLS"
    exit 0
    ;;
  inactive:--user\ is-enabled\ --quiet\ shuttle-daemon.service) exit 0 ;;
esac
exit 1
STUB
cat > "$WORK/bin/shuttle-launch" <<'STUB'
#!/bin/sh
printf '%s\n' attempted >> "$SHUTTLE_TEST_CALLS"
printf '%s\n' "$*" >> "$SHUTTLE_TEST_RECOVERY_ARGS"
sleep 2
if mkdir "$SHUTTLE_TEST_SESSIONS/shuttle-daemon" 2>/dev/null; then
  printf '%s\n' shuttle >> "$SHUTTLE_TEST_CREATED"
fi
printf '%s\n' complete >> "$SHUTTLE_TEST_COMPLETED"
STUB
chmod +x "$WORK/bin/"*
cp "$REPO/bin/shuttle-ensure" "$WORK/home/.local/bin/shuttle-ensure"
cp "$WORK/bin/tailscaled-launch" "$WORK/home/.local/bin/tailscaled-launch"
cp "$WORK/bin/shuttle-launch" "$WORK/home/.local/bin/shuttle-launch"

run_ensure() {
  env HOME="$WORK/home" PATH="$WORK/bin:$WORK/home/.local/bin:/usr/bin:/bin" \
    SHUTTLE_TEST_NODE="$WORK/node" SHUTTLE_TEST_SESSIONS="$WORK/sessions" \
    SHUTTLE_TEST_CALLS="$WORK/calls" SHUTTLE_TEST_CREATED="$WORK/created" \
    SHUTTLE_TEST_SYSTEMCTL_CALLS="$WORK/systemctl-calls" \
    SHUTTLE_TEST_RECOVERY_ARGS="$WORK/recovery-args" \
    SHUTTLE_TEST_LOOP_CHECKS="$WORK/loop-checks" SHUTTLE_TEST_COMPLETED="$WORK/completed" \
    SHUTTLE_TEST_LOOP_COHORT="${LOOP_COHORT:-0}" \
    SHUTTLE_TEST_SYSTEMD_MODE="${SYSTEMD_MODE:-inactive}" \
    "$WORK/home/.local/bin/shuttle-ensure"
}
line_count() { wc -l < "$1" | tr -d ' '; }

printf 'other\n' > "$WORK/node"
# Login-shell output also carries machine-readable SSH replies such as a
# deploy worktree path, so the login path prints nothing on either stream.
output=$(run_ensure 2> "$WORK/notice")
[ -z "$output" ]
[ ! -s "$WORK/notice" ]
[ ! -s "$WORK/created" ]
[ "$(SHUTTLE_TEST_NODE="$WORK/node" HOME="$WORK/home" PATH="$WORK/bin:$WORK/home/.local/bin:/usr/bin:/bin" "$REPO/bin/shuttle-launch" --recover)" = "shuttle-launch: this host belongs to login node 'owner'; leaving it alone" ]
[ "$(SHUTTLE_TEST_NODE="$WORK/node" HOME="$WORK/home" PATH="$WORK/bin:$WORK/home/.local/bin:/usr/bin:/bin" "$REPO/bin/tailscaled-launch")" = "tailscaled-launch: this host belongs to login node 'owner'; leaving it alone" ]
[ ! -s "$WORK/created" ]

printf 'owner\n' > "$WORK/node"
SECONDS=0
output=$(LOOP_COHORT=3 run_ensure 2> "$WORK/notice")
[ -z "$output" ]
[ ! -s "$WORK/notice" ]
LOOP_COHORT=3 run_ensure >/dev/null & second=$!
LOOP_COHORT=3 run_ensure >/dev/null & third=$!
wait "$second"
wait "$third"
[ "$SECONDS" -lt 2 ] || { echo 'login ensure waited for supervisor recovery' >&2; exit 1; }
for _ in $(seq 1 45); do
  [ "$(line_count "$WORK/loop-checks")" -ge 3 ] \
    && [ "$(line_count "$WORK/recovery-args")" -ge 3 ] \
    && [ "$(line_count "$WORK/completed")" -ge 3 ] && break
  sleep 0.1
done
[ "$(line_count "$WORK/loop-checks")" = 3 ]
[ "$(line_count "$WORK/recovery-args")" = 3 ]
[ "$(line_count "$WORK/completed")" = 3 ]
[ "$(grep -c '^shuttle$' "$WORK/created")" = 1 ]
[ "$(grep -c '^tailscaled$' "$WORK/created")" = 1 ]

# An active service manager is already the daemon owner; ensure does not call
# the fallback launcher. Inactive recovery delegates to shuttle-launch.
: > "$WORK/calls"
: > "$WORK/systemctl-calls"
: > "$WORK/loop-checks"
SYSTEMD_MODE=active run_ensure >/dev/null
for _ in $(seq 1 20); do
  grep -Fxq active-complete "$WORK/systemctl-calls" && break
  sleep 0.05
done
[ "$(grep -c '^active-complete$' "$WORK/systemctl-calls")" = 1 ]
[ ! -s "$WORK/calls" ]
[ ! -s "$WORK/loop-checks" ]

rm -rf "$WORK/sessions/shuttle-daemon"
: > "$WORK/recovery-args"
: > "$WORK/completed"
SYSTEMD_MODE=inactive run_ensure >/dev/null
for _ in $(seq 1 45); do
  grep -Fxq -- '--recover' "$WORK/recovery-args" \
    && grep -Fxq complete "$WORK/completed" \
    && [ -d "$WORK/sessions/shuttle-daemon" ] && break
  sleep 0.1
done
grep -Fxq -- '--recover' "$WORK/recovery-args"
grep -Fxq complete "$WORK/completed"
printf 'PASS: owner guard, nonblocking recovery, one concurrent supervisor, and systemd paths\n'
