#!/bin/sh
# Poll GitHub with the host's credentials and queue red main runs at a desk.
# Usage: ci-notice.sh OWNER/REPO STORE DESK STATE_DIR SINCE
# SINCE is a fixed ISO-8601 activation time; pagination covers every newer run.
# Run serially from a host scheduler. Delivery is at least once across
# a crash between queueing a message and recording its acknowledgement.
set -eu
if [ "$#" -ne 5 ]; then
  echo "usage: $0 OWNER/REPO STORE DESK STATE_DIR SINCE" >&2
  exit 2
fi
repo=$1 store=$2 desk=$3 state=$4 since=$5
mkdir -p "$state"
runs=$(gh api --paginate --method GET "repos/$repo/actions/workflows/ci.yml/runs" \
  -f branch=main -f event=push -f status=failure -f per_page=100 -f "created=>=$since" \
  --jq '.workflow_runs[] | [.id, .run_attempt, .head_sha, .html_url, .display_title] | @tsv')
tab=$(printf '\t')
while IFS="$tab" read -r id attempt sha url title; do
  [ -n "$id" ] || continue
  case "$id-$attempt" in *[!0-9-]*) echo "invalid CI run identity: $id-$attempt" >&2; exit 1 ;; esac
  marker="$state/$id-$attempt"
  [ ! -f "$marker" ] || continue
  message="CI failed on main in $repo at $sha ($title).
Run $id, attempt $attempt: $url
Inspect all failing jobs with: gh run view $id --repo $repo --log-failed
This notice was queued by scripts/ci-notice.sh."
  shuttle -C "$store" message "$desk" "$message"
  # A failed queue write leaves no acknowledgement and retries on the next run.
  touch "$marker"
  printf 'Notified %s of %s run %s attempt %s\n' "$desk" "$repo" "$id" "$attempt"
done <<EOF
$runs
EOF
