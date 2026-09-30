#!/usr/bin/env bash
# test-linux.sh — run the Go suite on Linux from a Mac, the way CI runs it.
#
#   scripts/test-linux.sh                          # go test ./...
#   scripts/test-linux.sh ./internal/shuttlecli -run Deploy
#   scripts/test-linux.sh --shell                  # a shell in the same container
#
# macOS and CI's Ubuntu runner disagree where the code meets the OS: /bin/sh
# is bash on macOS and dash on Debian/Ubuntu, and /proc, systemd and tmux
# behave differently. This runs the Go suite (where those differences live)
# in a Debian container with CI's Go version, as a non-root user, with tmux
# and procps installed as on the runner.
#
# Runtime: Apple's `container` CLI when installed (one lightweight VM per
# container, no resident desktop app), else `docker`. Arguments go to
# `go test` (default ./...). Module and build caches persist on the host under
# ${XDG_CACHE_HOME:-~/.cache}/felt-test-linux, so repeat runs are fast.

set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if command -v container >/dev/null 2>&1; then
  runtime=container
  container system status >/dev/null 2>&1 || container system start >/dev/null
elif command -v docker >/dev/null 2>&1; then
  runtime=docker
else
  echo "test-linux: needs Apple's container CLI (brew install container) or docker" >&2
  exit 1
fi

go_version=$(awk '$1 == "toolchain" { t = substr($2, 3) } $1 == "go" { g = $2 } END { print t ? t : g }' "$repo/go.mod")
uid=$(id -u)
image="felt-test-linux:go${go_version}-u${uid}"

if ! "$runtime" image inspect "$image" >/dev/null 2>&1; then
  echo "test-linux: building $image with $runtime" >&2
  "$runtime" build -t "$image" -f - "$repo/scripts" >&2 <<EOF
FROM golang:${go_version}
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tmux procps git >/dev/null \
 && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u ${uid} -s /bin/bash tester
USER tester
ENV GOFLAGS=-buildvcs=false GOTOOLCHAIN=local
EOF
fi

cache="${XDG_CACHE_HOME:-$HOME/.cache}/felt-test-linux"
mkdir -p "$cache"

tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-it)

if [ "${1:-}" = "--shell" ]; then
  cmd=(bash)
else
  [ $# -gt 0 ] || set -- ./...
  cmd=(go test "$@")
fi

exec "$runtime" run --rm ${tty[@]+"${tty[@]}"} \
  -v "$repo":/src -w /src \
  -v "$cache":/cache -e GOMODCACHE=/cache/gomod -e GOCACHE=/cache/gobuild \
  "$image" "${cmd[@]}"
