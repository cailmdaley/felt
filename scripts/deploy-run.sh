#!/usr/bin/env bash
# Read the framed bootstrap before a login profile can read stdin. FD 7 carries
# only observer lifetime; the login shell and every build see /dev/null on stdin.
# Heartbeats expire after 60 seconds even when a lost transport stays open.
set -u
TOKEN=$1
child= watcher= logger= tmp=
finish() {
  status=$?
  trap - EXIT
  trap '' TERM INT HUP
  trap ':' PIPE
  if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" || true; fi
  [ -z "$watcher" ] || kill "$watcher" 2>/dev/null || true
  printf '\n%s LOG_END\n' "$TOKEN" >&8 2>/dev/null || true
  exec 8>&-
  [ -z "$logger" ] || wait "$logger" || true
  rm -rf "$tmp" || status=1
  exit "$status"
}
trap finish EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
mkdir -p "$HOME/.shuttle/deploy/tools" || exit 1
tmp=$(mktemp -d "$HOME/.shuttle/deploy/tools/lock.XXXXXX") || exit 1
log="$HOME/.shuttle/deploy/last-run.log"
(umask 077; : > "$tmp/log") || exit 1
exec 9>> "$tmp/log"
mv -f "$tmp/log" "$log" || exit 1
log_stream() {
  trap '' PIPE
  while IFS= read -r line || [ -n "$line" ]; do
    [ "$line" != "$TOKEN LOG_END" ] || break
    printf '%s\n' "$line" >&9
    printf '%s\n' "$line" 2>/dev/null || true
    case "$line" in "$TOKEN "[0-9]*) break;; esac
  done
}
mkfifo "$tmp/output" || exit 1
log_stream < "$tmp/output" &
logger=$!
exec 8> "$tmp/output"
exec 9>&-
IFS= read -r size || exit 1
case "$size" in ''|*[!0-9]*) echo 'deploy: invalid bootstrap frame' >&8; exit 1;; esac
dd bs=1 count="$size" of="$tmp/bootstrap.sh" 2>/dev/null || exit 1
[ "$(wc -c < "$tmp/bootstrap.sh")" -eq "$size" ] || exit 1
owner=$$
mkfifo "$tmp/lifetime" || exit 1
(while IFS= read -r -t 60 line; do printf '\n'; done; kill -TERM "$owner") <&0 > "$tmp/lifetime" &
watcher=$!
exec 7< "$tmp/lifetime"
SHUTTLE_DEPLOY_TMP="$tmp" SHUTTLE_DEPLOY_TOKEN="$TOKEN" bash -lc 'exec bash "$1"' bootstrap "$tmp/bootstrap.sh" 7<&7 </dev/null >&8 2>&1 8>&- &
child=$!
exec 7<&-
wait "$child"
status=$?
child=
exit "$status"
