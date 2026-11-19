#!/bin/sh
# scratch-daemon.sh — run this checkout's daemon release in a private world.
#
#   make daemon && scripts/scratch-daemon.sh [port]     # port defaults to 4190
#
# Boots bin/rel-built on 127.0.0.1:<port> with its own HOME, host id
# (verify-scratch), operator files, ledgers and one-fiber felt store, with the
# checkout's ./felt and ./shuttle first on PATH. tmux, rex, codex, tailscale,
# hark and ps are stubs, so it can neither see nor launch a real worker, and
# the host's own daemon, stores and operator files are never read or written.
# It prints the URL, the root, a file to source so the CLIs address the same
# world, and how to stop it; the daemon keeps running after the script exits.
set -eu

port=${1:-4190}
repo=$(cd "$(dirname "$0")/.." && pwd)
release="$repo/bin/rel-built/bin/shuttled"
for need in "$release" "$repo/felt" "$repo/shuttle"; do
  [ -x "$need" ] || { echo "scratch-daemon: $need is missing; run make daemon first" >&2; exit 1; }
done
if curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null 2>&1; then
  echo "scratch-daemon: port $port already answers; pass another port" >&2
  exit 1
fi

tmp=${TMPDIR:-/tmp}
root=$(mktemp -d "${tmp%/}/scratch-daemon.XXXXXX")
mkdir -p "$root/bin" "$root/store"
cp "$repo/felt" "$repo/shuttle" "$root/bin/"
for stub in tmux rex codex tailscale hark; do
  printf '#!/bin/sh\nexit 1\n' >"$root/bin/$stub"
done
printf '#!/bin/sh\nexit 0\n' >"$root/bin/ps"
chmod +x "$root"/bin/*

cat >"$root/env" <<EOF
export HOME='$root' PATH='$root/bin':"\$PATH" SHUTTLE_HOST=verify-scratch SHUTTLE_PORT=$port
export SHUTTLE_DATA_DIR='$root/data' SHUTTLE_HOST_CONFIG_FILE='$root/host.json' SHUTTLE_VOICE_FILE='$root/voice.json' HARK_DIR='$root/hark'
export SHUTTLE_STORES_FILE='$root/stores.json' SHUTTLE_PROJECTS_FILE='$root/projects.json' SHUTTLE_REMOTES_FILE='$root/remotes.json' SHUTTLE_AGENTS_FILE='$root/agents.json'
export SHUTTLE_SESSIONS_FILE='$root/sessions.jsonl' SHUTTLE_COMMITS_FILE='$root/commits.jsonl' SHUTTLE_EVENTS_FILE='$root/events.jsonl'
export CODEX_HOME='$root/codex' CLAUDE_CONFIG_DIR='$root/claude' PI_CODING_AGENT_DIR='$root/pi' TMUX_TMPDIR='$root/tmux'
unset SHUTTLE_STORES SHUTTLE_PROJECTS SHUTTLE_LISTEN TMUX
EOF
printf '{"class":"single-user","terminal":"tmux"}\n' >"$root/host.json"
printf '{}\n' >"$root/remotes.json"
printf '{"felt_stores":["%s"]}\n' "$root/store" >"$root/stores.json"

. "$root/env"
(cd "$root/store" && git init -q && felt init >/dev/null &&
  felt add demo "Scratch constitution" >/dev/null &&
  shuttle install demo --disabled >/dev/null)

nohup "$release" start >"$root/daemon.log" 2>&1 &
pid=$!
tries=0
until curl -sf "http://127.0.0.1:$port/api/v1/version" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -gt 120 ] || ! kill -0 "$pid" 2>/dev/null; then
    echo "scratch-daemon: no answer on port $port; log:" >&2
    tail -20 "$root/daemon.log" >&2
    kill "$pid" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

cat <<EOF
url:   http://127.0.0.1:$port
root:  $root   (store: $root/store, fiber: demo, log: $root/daemon.log)
cli:   . '$root/env'   then felt and shuttle address this world
stop:  kill $pid && rm -rf '$root'
EOF
