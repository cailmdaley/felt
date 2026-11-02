#!/usr/bin/env bash
set -euo pipefail

codex_bin="$(type -P codex || true)"
if [[ -z "$codex_bin" ]]; then
  echo "codex executable not found on PATH" >&2
  exit 1
fi
command -v tmux >/dev/null || { echo "tmux is required" >&2; exit 1; }

source_home="${CODEX_HOME:-$HOME/.codex}"
if [[ ! -f "$source_home/auth.json" ]]; then
  echo "Codex auth file not found at $source_home/auth.json" >&2
  exit 1
fi

tmp="$(mktemp -d "/tmp/shuttle-codex-tui.XXXXXX")"
tmp="$(cd "$tmp" && pwd -P)"
private_home="$tmp/home"
workdir="$tmp/work"
socket="$tmp/tmux.sock"
capture="$tmp/capture.txt"
session="codex-tui-check"
mkdir -m 700 "$private_home" "$workdir"
cp "$source_home/auth.json" "$private_home/auth.json"
chmod 600 "$private_home/auth.json"

cleanup() {
  local rc=$?
  local daemon_rc=0
  trap - EXIT
  if [[ -S "$socket" ]]; then
    if tmux -f /dev/null -S "$socket" has-session -t "$session" 2>/dev/null; then
      tmux -f /dev/null -S "$socket" send-keys -t "$session" -l '/exit' 2>/dev/null || true
      sleep 0.5
      tmux -f /dev/null -S "$socket" send-keys -t "$session" Enter 2>/dev/null || true
      local exit_deadline=$((SECONDS + 2))
      while (( SECONDS < exit_deadline )) && [[ ! -f "$private_home/exit-status" ]]; do
        sleep 0.25
      done
    fi
    tmux -f /dev/null -S "$socket" kill-server >/dev/null 2>&1 || true
  fi
  CODEX_HOME="$private_home" "$codex_bin" app-server daemon stop > "$tmp/daemon-stop.log" 2>&1 || daemon_rc=$?
  # Codex's PID updater can outlive its managed daemon. Match only this
  # private home's executable and helper role, after its terminal is closed.
  while read -r helper_pid helper_command; do
    case "$helper_command" in
      "$private_home"/packages/*/bin/codex\ app-server\ daemon\ pid-update-loop*)
        current="$(ps -p "$helper_pid" -o args= 2>/dev/null || true)"
        [[ "$current" == "$helper_command" ]] || continue
        kill -TERM "$helper_pid" 2>/dev/null || true
        helper_deadline=$((SECONDS + 5))
        while (( SECONDS < helper_deadline )); do
          current="$(ps -p "$helper_pid" -o args= 2>/dev/null || true)"
          [[ "$current" == "$helper_command" ]] || break
          sleep 0.25
        done
        if [[ "$current" == "$helper_command" ]]; then
          echo "Private Codex PID updater $helper_pid did not stop." >&2
          daemon_rc=1
        fi
        ;;
    esac
  done < <(ps -u "$(id -u)" -o pid=,args=)
  if [[ $daemon_rc -ne 0 ]]; then
    echo "Could not stop Codex's private managed app-server (exit $daemon_rc)." >&2
    rc=1
  fi
  if [[ $rc -ne 0 && -f "$capture" ]]; then
    echo "Codex TUI capture:" >&2
    cat "$capture" >&2
  fi
  if [[ $rc -ne 0 ]]; then
    echo "Private canary files retained at $tmp for inspection and cleanup." >&2
    exit "$rc"
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

cat >"$tmp/run-codex" <<'RUN'
#!/usr/bin/env bash
private_home="$1"
workdir="$2"
codex_bin="$3"
export CODEX_HOME="$private_home"
cd "$workdir"
set +e
env -u TMUX -u TMUX_PANE "$codex_bin"
status=$?
printf '%s\n' "$status" > "$private_home/exit-status"
read -r _
exit "$status"
RUN
chmod 700 "$tmp/run-codex"
tmux_cmd="$(printf '%q ' "$tmp/run-codex" "$private_home" "$workdir" "$codex_bin")"
tmux -f /dev/null -S "$socket" new-session -d -s "$session" "$tmux_cmd"

deadline=$((SECONDS + 30))
ready=0
stable_prompt=0
while (( SECONDS < deadline )); do
  if ! tmux -f /dev/null -S "$socket" has-session -t "$session" 2>/dev/null; then
    break
  fi
  tmux -f /dev/null -S "$socket" capture-pane -p -t "$session" > "$capture" 2>/dev/null || true
  if grep -Eq 'OpenAI Codex' "$capture" && grep -Eq '^[[:space:]]*› ' "$capture" && grep -Fq "$workdir" "$capture"; then
    stable_prompt=$((stable_prompt + 1))
    if (( stable_prompt >= 4 )); then
      ready=1
      break
    fi
  else
    stable_prompt=0
  fi
  sleep 0.25
done
if [[ "$ready" != 1 ]]; then
  echo "Codex did not render its banner and input composer within 30 seconds" >&2
  exit 1
fi

echo "Native Codex TUI rendered its input composer."
