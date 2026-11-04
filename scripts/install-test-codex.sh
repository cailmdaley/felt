#!/usr/bin/env bash
# Install the pinned real Codex test executable into an explicit private directory.
set -euo pipefail
version=0.166.0
case "$(uname -m)" in
  aarch64|arm64) target=aarch64-unknown-linux-musl; sha=94eb707605ec2646b2e05b7edf7c4e7b3ccf02b16237c34ae9beb8cfb7f810a9 ;;
  x86_64) target=x86_64-unknown-linux-musl; sha=a0bf572d2f93f056c6712a6da348e96078dc84f3885fd7be67807ef389cb3978 ;;
  *) echo 'test Codex: unsupported architecture' >&2; exit 1 ;;
esac
destination=${1:?usage: install-test-codex.sh DIRECTORY}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --retry 3 --silent --show-error \
  "https://github.com/openai/codex/releases/download/rust-v${version}/codex-${target}.tar.gz" -o "$work/codex.tar.gz"
printf '%s  %s\n' "$sha" "$work/codex.tar.gz" | sha256sum --check --status
tar -xzf "$work/codex.tar.gz" -C "$work"
mkdir -p "$destination"
install -m 0755 "$work/codex-${target}" "$destination/codex"
"$destination/codex" --version
