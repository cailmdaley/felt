#!/usr/bin/env bash
# Build felt and shuttle at two revisions and run the CLI differential
# between them.
#
#   scripts/cli-differential/run.sh <baseline-rev> [candidate-rev] [harness flags...]
#
# The candidate defaults to the working tree. Each revision is built from a
# detached worktree with identical flags; the worktrees are removed after.
# Results land in $OUT (default: a fresh temp directory): report.txt, the
# corpus, the verb trees, and a/b records for every differing invocation.
set -euo pipefail

repo=$(git rev-parse --show-toplevel)
base=${1:?usage: run.sh <baseline-rev> [candidate-rev] [harness flags...]}
shift
cand=""
if [[ $# -gt 0 && $1 != -* ]]; then
	cand=$1
	shift
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/cli-differential.XXXXXX")
out=${OUT:-$work/out}
trees=()
cleanup() {
	for tree in "${trees[@]}"; do
		git -C "$repo" worktree remove --force "$tree" >/dev/null 2>&1 || true
	done
}
trap cleanup EXIT

ldflags="-X main.version=difftest -X main.commit=difftest -X main.date=difftest"
build() { # build <rev or empty> <out dir>
	local src=$repo
	if [[ -n $1 ]]; then
		src=$work/src-$(basename "$2")
		git -C "$repo" worktree add --detach "$src" "$1" >/dev/null
		trees+=("$src")
	fi
	mkdir -p "$2"
	(cd "$src" && go build -trimpath -ldflags "$ldflags" -o "$2/" ./cmd/felt ./cmd/shuttle)
	# The variables either revision reads, to vary one at a time.
	git -C "$src" grep -hoE '"[A-Z][A-Z0-9_]*[A-Z0-9]"' -- 'internal/*.go' 'cmd/*.go' ':!*_test.go' |
		tr -d '"' | grep -E '^(SHUTTLE|FELT|CODEX|CLAUDE|XDG|TMUX|AGENT|PI|SSH|HOME|PATH|SHELL|USER|LOGNAME|TMPDIR|HTTPS?_PROXY|NO_PROXY|AI_AGENT)' >>"$work/env-names.raw" || true
}

build "$base" "$work/a"
build "$cand" "$work/b"
printf '%s\n' XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME HTTP_PROXY HTTPS_PROXY NO_PROXY LANG TZ >>"$work/env-names.raw"
sort -u "$work/env-names.raw" >"$work/env-names"

mkdir -p "$out"
(cd "$repo" && go run ./scripts/cli-differential -a "$work/a" -b "$work/b" -out "$out" -env-names "$work/env-names" "$@")
