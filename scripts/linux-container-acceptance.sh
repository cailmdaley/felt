#!/usr/bin/env bash
# Acceptance test: clean-Linux-container bootstrap.sh run (the stranger test).
# Runs inside elixir:1.19 (debian) as an unprivileged user with no systemd,
# no node — exercising the honest degradation paths.
set -euo pipefail

fail() { echo "ACCEPTANCE-FAIL: $1"; exit 1; }

echo "=== [1/5] prerequisites a stranger would install ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null || fail "apt update"
apt-get install -y -qq tmux git jq curl ca-certificates procps >/dev/null || fail "apt install"

ARCH="$(dpkg --print-architecture)"   # amd64 | arm64
GO_VERSION="$(awk '$1 == "go" { minimum = $2 } $1 == "toolchain" { preferred = substr($2, 3) } END { print preferred ? preferred : minimum }' /src/go.mod)"
[ -n "$GO_VERSION" ] || fail "could not read Go version from /src/go.mod"
GO_TGZ="go${GO_VERSION}.linux-${ARCH}.tar.gz"
curl -fsSL "https://go.dev/dl/${GO_TGZ}" -o /tmp/go.tgz || fail "go download"
GO_ROOT="/opt/go-${GO_VERSION}"
mkdir -p "$GO_ROOT"
tar --strip-components=1 -C "$GO_ROOT" -xzf /tmp/go.tgz || fail "go untar"
export PATH="$GO_ROOT/bin:$PATH"
ln -sf "$GO_ROOT/bin/go" /usr/local/bin/go
go version || fail "go broken"

useradd -m ada || fail "useradd"

echo "=== [2/5] clone as the stranger ==="
# The bind mount is owned by the host user, while the test clone runs as ada;
# recent Git therefore rejects /src as a dubious repository. Scope the
# exception to this read-only source path and this one clone command. Git's
# local transport starts a child process while cloning, so put the exact path
# in ada's temporary container-local config rather than relying on `-c`.
su - ada -c 'git config --global --add safe.directory /src && git config --global --add safe.directory /src/.git && git clone -q /src /home/ada/felt' || fail "clone"

echo "=== [3/5] bootstrap.sh --dry-run ==="
su - ada -c 'cd ~/felt && ./scripts/bootstrap.sh --dry-run' || fail "dry-run exited nonzero"

echo "=== [4/5] bootstrap.sh (full) ==="
su - ada -c 'cd ~/felt && ./scripts/bootstrap.sh' || fail "bootstrap exited nonzero"

echo "=== [5/5] post-conditions ==="
su - ada -c 'test -x ~/.local/bin/felt' || fail "felt CLI not installed"
su - ada -c '~/.local/bin/felt --help >/dev/null' || fail "felt CLI does not run"
su - ada -c 'test -x ~/felt/bin/rel/bin/shuttled' || fail "daemon release not built"
su - ada -c 'test -f ~/.shuttle/repo && grep -q "/home/ada/felt" ~/.shuttle/repo' || fail "~/.shuttle/repo state file missing/wrong"
su - ada -c 'test -x ~/.local/bin/shuttle-launch' || fail "shuttle-launch not installed"

# keep-alive: no systemd here -> respawn loop expected. Poll the documented
# readiness endpoint instead of sleeping a fixed amount; a cold BEAM can need
# longer than 15 seconds, while a warm one should not make this test wait.
VERSION_JSON=""
for _ in $(seq 1 90); do
  if VERSION_JSON="$(su - ada -c 'curl -fsS -m 2 http://127.0.0.1:4000/api/v1/version')"; then
    break
  fi
  VERSION_JSON=""
  sleep 1
done
[ -n "$VERSION_JSON" ] || fail "daemon not answering on the documented verify URL"
su - ada -c 'tmux has-session -t shuttle-daemon' || fail "no tmux respawn session"
printf '%s\n' "$VERSION_JSON"
printf '%s\n' "$VERSION_JSON" | jq -e '.contract.ok == true and .contract.expected == .contract.observed' >/dev/null \
  || fail "CLI/daemon contract skew at boot (felt not on daemon PATH)"

echo "ACCEPTANCE-PASS"
