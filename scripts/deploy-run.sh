#!/usr/bin/env bash
# A disconnected observer does not cancel the host-owned deployment. The run's
# log and result remain available independently of the SSH session.
set -u
umask 077
run="$HOME/.shuttle/deploy/runs/$RUN_ID"
mkdir -p "${run%/*}" && mkdir "$run" || exit 1
printf '%s\n' "$BOOTSTRAP" > "$run/start.sh" || exit 1
: > "$run/log"
SHUTTLE_DEPLOY_RUN_DIR="$run" nohup bash "$run/start.sh" > "$run/log" 2>&1 < /dev/null &
pid=$!
printf '%s\n' "$pid" > "$run/pid"
printf '  %s: host-owned run %s (pid %s); SSH disconnect does not cancel it\n' "$HOST" "$run" "$pid" >&2

# Snapshot complete lines so appends cannot be duplicated or lost between polls.
# The runner closes its log with a newline before publishing the result.
seen=0
stream_log() {
  local lines
  lines=$(wc -l < "$run/log") || return 1
  if [ "$lines" -gt "$seen" ]; then
    sed -n "$((seen + 1)),${lines}p" "$run/log" || return 1
    seen=$lines
  fi
}
while :; do
  stream_log || exit 1
  if [ -f "$run/result" ]; then
    stream_log || exit 1
    exit "$(cat "$run/result")"
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    stream_log
    printf '  %s: runner exited without a result; inspect %s\n' "$HOST" "$run" >&2
    exit 1
  fi
  sleep 1
done
