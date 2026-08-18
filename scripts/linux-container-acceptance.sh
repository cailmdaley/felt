#!/usr/bin/env bash
# Acceptance test: clean-Linux-container bootstrap.sh run (the stranger test).
# Runs inside elixir:1.19 (debian) as an unprivileged user with no systemd,
# no node — exercising the honest degradation paths.
set -uo pipefail

fail() { echo "ACCEPTANCE-FAIL: $1"; exit 1; }

echo "=== [1/5] prerequisites a stranger would install ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null || fail "apt update"
apt-get install -y -qq tmux git jq curl ca-certificates procps >/dev/null || fail "apt install"

ARCH="$(dpkg --print-architecture)"   # amd64 | arm64
GO_TGZ="go1.23.4.linux-${ARCH}.tar.gz"
curl -fsSL "https://go.dev/dl/${GO_TGZ}" -o /tmp/go.tgz || fail "go download"
tar -C /usr/local -xzf /tmp/go.tgz || fail "go untar"
ln -s /usr/local/go/bin/go /usr/local/bin/go
go version || fail "go broken"

useradd -m ada || fail "useradd"

echo "=== [2/5] clone as the stranger ==="
su - ada -c 'git clone -q /src /home/ada/felt' || fail "clone"

echo "=== [3/5] bootstrap.sh --dry-run ==="
su - ada -c 'cd ~/felt && ./bootstrap.sh --dry-run' || fail "dry-run exited nonzero"

echo "=== [4/5] bootstrap.sh (full) ==="
su - ada -c 'cd ~/felt && ./bootstrap.sh' || fail "bootstrap exited nonzero"

echo "=== [5/5] post-conditions ==="
su - ada -c 'test -x ~/.local/bin/felt' || fail "felt CLI not installed"
su - ada -c '~/.local/bin/felt --help >/dev/null' || fail "felt CLI does not run"
su - ada -c 'test -x ~/felt/bin/rel/bin/shuttled' || fail "daemon release not built"
su - ada -c 'test -f ~/.shuttle/repo && grep -q "/home/ada/felt" ~/.shuttle/repo' || fail "~/.shuttle/repo state file missing/wrong"
su - ada -c 'test -x ~/.local/bin/shuttle-launch' || fail "shuttle-launch not installed"

# keep-alive: no systemd here -> respawn loop expected; give the daemon a moment
sleep 15
su - ada -c 'tmux ls' || fail "no tmux respawn session"
su - ada -c 'curl -fsS -m 5 http://127.0.0.1:4000/api/v1/version' || fail "daemon not answering on the documented verify URL"
echo
if su - ada -c 'grep -q "contract skew" ~/.shuttle/shuttle.log'; then
  su - ada -c 'grep "contract skew" ~/.shuttle/shuttle.log'
  fail "CLI/daemon contract skew at boot (felt not on daemon PATH)"
fi

echo "ACCEPTANCE-PASS"
