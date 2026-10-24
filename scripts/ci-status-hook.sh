#!/bin/sh
# SessionStart hook: tells a session in this checkout when the latest
# completed CI run on main failed. Silent when CI is green or gh is
# unavailable, so it never blocks a session.
command -v gh >/dev/null 2>&1 || exit 0
if command -v timeout >/dev/null 2>&1; then t() { timeout 8 "$@"; }; else t() { "$@"; }; fi
run=$(t gh run list --branch main --workflow CI --status completed -L 1 \
  --json conclusion,headSha,displayTitle,url,databaseId \
  --jq '.[0] | select(.conclusion == "failure") | "\(.databaseId)\t\(.headSha[0:8])\t\(.displayTitle)\t\(.url)"' 2>/dev/null) || exit 0
[ -n "$run" ] || exit 0
id=$(printf '%s' "$run" | cut -f1)
sha=$(printf '%s' "$run" | cut -f2)
title=$(printf '%s' "$run" | cut -f3)
url=$(printf '%s' "$run" | cut -f4)
jobs=$(t gh run view "$id" --json jobs \
  --jq '[.jobs[] | select(.conclusion == "failure") | .name] | join("; ")' 2>/dev/null)
echo "CI is red on main: the latest completed CI run ($sha \"$title\") failed${jobs:+ in: $jobs}."
echo "Run: $url — failing tests: gh run view $id --log-failed | grep -E '[0-9]\) (test|property)|--- FAIL'"
echo "Fixing red CI takes priority over landing more changes on main."
