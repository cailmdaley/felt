#!/usr/bin/env bash
# test-colab.sh — run felt's core Linux CI suites on an ephemeral Google Colab VM.
#
#   scripts/test-colab.sh                                      # full go CI checks (ephemeral VM)
#   scripts/test-colab.sh go ./internal/feltcli -run TestDocs  # targeted Go tests
#   scripts/test-colab.sh elixir test/shuttle/poller_test.exs  # Elixir daemon tests
#   scripts/test-colab.sh ui                                   # board tests + vite/tsc build
#   scripts/test-colab.sh e2e                                  # Playwright browser journeys
#   scripts/test-colab.sh all                                  # go + ui + plugin-hooks + elixir
#   scripts/test-colab.sh --keep shell                         # interactive shell on a warm VM
#
# Uses google-colab-cli (`colab`) to allocate a `--high-mem` Linux VM, sync the
# local working tree (tracked + non-ignored untracked files, zero credentials,
# no local build caches), provision CI-matching toolchains as root, execute the
# suite as a non-root `tester` user, and stop the VM on exit unless `--keep` is set.

set -euo pipefail

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Toolchain versions matching .github/workflows/ci.yml and go.mod.
go_version=$(awk '$1 == "toolchain" { t = substr($2, 3) } $1 == "go" { g = $2 } END { print t ? t : g }' "$repo/go.mod")
otp_major="28"
elixir_minor="1.19"
node_major="22"

keep=0
session=""
session_explicit=0
gpu=""
dry_run=0

if [ -n "${COLAB_AUTH:-}" ]; then
  auth="$COLAB_AUTH"
elif [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ]; then
  auth="adc"
else
  auth="oauth2"
fi

usage() {
  cat <<EOF
Usage: scripts/test-colab.sh [OPTIONS] [SUITE] [ARGS...]

Run felt's core Linux CI suites on an ephemeral Google Colab VM via \`colab\`.
Allocates a --high-mem CPU VM, syncs the working tree (uncommitted changes
included, no credentials or build caches), provisions toolchains as root, runs
the suite as non-root user \`tester\`, and stops the VM on exit unless --keep.

Suites (default: go):
  go [go test args...]       Go ${go_version}, tmux, procps, git, pinned Codex.
                             Default runs build, plugin validate, \`go test ./...\`,
                             bootstrap test, and manifest version parity; with args
                             runs \`go test [args...]\`.
  elixir [mix test args...]  Go ${go_version} (installs felt/shuttle into a private bin
                             dir only for elixir), OTP ${otp_major}, Elixir ${elixir_minor};
                             runs \`mix deps.get\`, \`mix compile --warnings-as-errors\`,
                             \`mix test [args...]\`.
  ui [npm args...]           Node ${node_major} + Go ${go_version}; runs \`npm ci\`,
                             \`npm test\`, \`npm run build\` (or \`npm [args...]\`).
  e2e [npm script args...]   Node ${node_major} + Go ${go_version} + Playwright Chromium
                             and WebKit; runs \`npm run e2e\` (or \`npm run [args...]\`).
  all                        Run go, ui, \`make plugin-hooks-test\`, and elixir.
  shell                      Sync /content/felt and open an interactive bash shell.

Options:
  --keep                     Keep the VM running after exit (reuse with --session).
  --session <name>           Session name (default: felt-ci with --keep, else felt-ci-<pid>).
  --gpu <type>               GPU accelerator passed to \`colab new\` (e.g. T4, L4, A100).
  --auth <oauth2|adc>        Colab auth mode (default: ${auth}).
  --dry-run                  Print the execution plan without calling \`colab\`.
  -h, --help                 Show this help and exit.

Examples:
  scripts/test-colab.sh
  scripts/test-colab.sh go ./internal/feltcli -run 'TestHygiene|TestDocs'
  scripts/test-colab.sh --keep --session felt-warm elixir
  scripts/test-colab.sh --gpu L4 e2e
EOF
}

suite="go"
suite_args=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --keep)    keep=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --session)
      [ $# -ge 2 ] || { echo "test-colab: --session requires a value" >&2; exit 2; }
      session="$2"; session_explicit=1; shift 2 ;;
    --session=*)
      session="${1#*=}"; session_explicit=1; shift ;;
    --gpu)
      [ $# -ge 2 ] || { echo "test-colab: --gpu requires a value" >&2; exit 2; }
      gpu="$2"; shift 2 ;;
    --gpu=*)
      gpu="${1#*=}"; shift ;;
    --auth)
      [ $# -ge 2 ] || { echo "test-colab: --auth requires a value" >&2; exit 2; }
      auth="$2"; shift 2 ;;
    --auth=*)
      auth="${1#*=}"; shift ;;
    --)
      shift
      if [ $# -gt 0 ]; then suite="$1"; shift; suite_args=("$@"); fi
      break ;;
    -*)
      echo "test-colab: unknown option: $1 (pass options before SUITE; see --help)" >&2
      exit 2 ;;
    *)
      suite="$1"; shift; suite_args=("$@"); break ;;
  esac
done

case "$suite" in
  go|elixir|ui|e2e|all|shell) ;;
  *) echo "test-colab: unknown suite '$suite' (expected: go, elixir, ui, e2e, all, shell)" >&2; exit 2 ;;
esac

case "$auth" in
  oauth2|adc) ;;
  *) echo "test-colab: invalid --auth '$auth' (expected: oauth2 or adc)" >&2; exit 2 ;;
esac

if [ -z "$session" ]; then
  session=$([ "$keep" -eq 1 ] && echo "felt-ci" || echo "felt-ci-$$")
fi

# Always scrub PYTHONPATH so hosts with external Python stacks (e.g. CVMFS) do
# not shadow colab's bundled pydantic_core inside colab ssh's ProxyCommand.
run_colab() {
  env -u PYTHONPATH colab --auth="$auth" "$@"
}

stop_hint() {
  if [ "$auth" = "adc" ]; then
    printf 'colab --auth=adc stop -s %s' "$session"
  else
    printf 'colab stop -s %s' "$session"
  fi
}

head_sha=$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo "unknown")
dirty_state="clean"
[ -z "$(git -C "$repo" status --porcelain 2>/dev/null || true)" ] || dirty_state="dirty (uncommitted changes included)"
codex_pin=$(cksum < "$repo/scripts/install-test-codex.sh" | awk '{print $1}')

new_args=(new -s "$session" --high-mem)
if [ -n "$gpu" ]; then
  new_args+=(--gpu "$gpu")
fi

if [ "$dry_run" -eq 1 ]; then
  cat <<EOF
test-colab dry-run:
  repo:      $repo ($head_sha, $dirty_state)
  session:   $session ($([ "$keep" -eq 1 ] && echo "keep after exit" || echo "ephemeral, auto-stop on exit"))
  shape:     --high-mem${gpu:+ --gpu $gpu}
  auth:      $auth
  suite:     $suite${suite_args:+ (${suite_args[*]}) }
  runner:    non-root user 'tester' (Go $go_version, OTP $otp_major / Elixir $elixir_minor, Node $node_major on demand)
  commands:
    $([ "$keep" -eq 1 ] || [ "$session_explicit" -eq 1 ] && echo "[reuse if in \`colab --auth=$auth sessions\`, else] ")env -u PYTHONPATH colab --auth=$auth ${new_args[*]}
    env -u PYTHONPATH colab --auth=$auth upload -s $session <tmp>/felt-sync.tar.gz /tmp/felt-sync.tar.gz
    env -u PYTHONPATH colab --auth=$auth upload -s $session <tmp>/felt-colab-run.sh /tmp/felt-colab-run.sh
    env -u PYTHONPATH colab --auth=$auth ssh -s $session -- 'GIT_PAGER=cat PAGER=cat bash /tmp/felt-colab-run.sh'
    $([ "$keep" -eq 1 ] && echo "# keep running; stop later with: $(stop_hint)" || echo "env -u PYTHONPATH colab --auth=$auth stop -s $session  # on EXIT / INT / TERM")
EOF
  exit 0
fi

for req in colab git python3; do
  if ! command -v "$req" >/dev/null 2>&1; then
    if [ "$req" = "colab" ]; then
      echo "test-colab: 'colab' not found on PATH (install via: uv tool install google-colab-cli)" >&2
    else
      echo "test-colab: required command '$req' not found on PATH" >&2
    fi
    exit 1
  fi
done

work=$(mktemp -d "${TMPDIR:-/tmp}/felt-colab.XXXXXX")
vm_started=0
vm_should_stop=0

cleanup() {
  local rc=$?
  # Ignore INT/TERM during teardown so a second Ctrl-C cannot leave the VM running.
  trap '' INT TERM
  trap - EXIT
  rm -rf "$work"
  if [ "$vm_should_stop" -eq 1 ]; then
    echo "test-colab: stopping ephemeral session '$session'..." >&2
    if ! run_colab stop -s "$session" >&2; then
      echo "test-colab: WARNING: failed to stop session '$session' — stop manually with: $(stop_hint)" >&2
    fi
  elif [ "$vm_started" -eq 1 ]; then
    echo "test-colab: session '$session' left running. Stop it when done:" >&2
    echo "  $(stop_hint)" >&2
  fi
  exit "$rc"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap cleanup EXIT

# Pack tracked + non-ignored untracked files via Python tarfile so macOS and
# Linux produce identical, xattr-free archives with zero credentials or caches.
pack_working_tree() {
  local out_tar="$1"
  python3 - "$repo" "$out_tar" <<'PY'
import os, subprocess, sys, tarfile

repo, out_tar = sys.argv[1], sys.argv[2]
raw = subprocess.check_output(
    ["git", "-C", repo, "ls-files", "-z", "--cached", "--others", "--exclude-standard"]
)
excluded_prefixes = (
    ".git/", ".felt/", "ui/node_modules/", "daemon/_build/",
    "daemon/deps/", "site/", "bin/rel", "bin/.rel",
)
excluded_exact = {".git", ".felt", "felt", "shuttle", "felt-linux", "shuttle-linux"}

count = 0
with tarfile.open(out_tar, "w:gz", compresslevel=6) as tf:
    for entry in raw.split(b"\0"):
        if not entry:
            continue
        rel = entry.decode("utf-8", "surrogateescape")
        if rel in excluded_exact or any(rel.startswith(p) for p in excluded_prefixes):
            continue
        full = os.path.join(repo, rel)
        if not os.path.lexists(full):
            continue
        tf.add(full, arcname=rel, recursive=False)
        count += 1

print(f"test-colab: packed {count} files ({os.path.getsize(out_tar) / (1024 * 1024):.2f} MiB)", file=sys.stderr)
PY
}

# Generate the remote runner script locally so SUITE_ARGS preserve arbitrary
# quoting/regexes without nested SSH escaping.
write_remote_script() {
  local script_path="$1"
  {
    cat <<'HEADER'
#!/usr/bin/env bash
set -euo pipefail

export GIT_PAGER=cat
export PAGER=cat
export DEBIAN_FRONTEND=noninteractive
export GOTOOLCHAIN=local
BASE_PATH="/usr/local/elixir/bin:/usr/local/otp/bin:/usr/local/go/bin:/usr/local/node/bin:/opt/test-codex:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export PATH="$BASE_PATH"
TESTER_PATH="$BASE_PATH"
ELIXIR_CLI_BIN="/opt/felt-ci/elixir-bin"
HEADER

    printf 'SUITE=%q\n' "$suite"
    printf 'GO_VERSION=%q\n' "$go_version"
    printf 'CODEX_PIN=%q\n' "$codex_pin"
    printf 'OTP_MAJOR=%q\n' "$otp_major"
    printf 'ELIXIR_MINOR=%q\n' "$elixir_minor"
    printf 'NODE_MAJOR=%q\n' "$node_major"
    printf 'HEAD_SHA=%q\n' "$head_sha"
    printf 'SUITE_ARGS=('
    if [ "${#suite_args[@]}" -gt 0 ]; then
      printf ' %q' "${suite_args[@]}"
    fi
    printf ' )\n'

    cat <<'BODY'

# Colab's / and /tmp are overlayfs (writable & executable, unlike /dev/shm which
# is noexec). Keep TMPDIR on /tmp so test binaries and scripts execute normally.
export TMPDIR="${TMPDIR:-/tmp}"
mkdir -p "$TMPDIR"
chmod 1777 "$TMPDIR"

ensure_tester_user() {
  id -u tester >/dev/null 2>&1 || useradd -m -s /bin/bash tester
  mkdir -p /content/felt \
    /home/tester/go/pkg/mod \
    /home/tester/.cache/go-build \
    /home/tester/.cache/ms-playwright \
    /home/tester/.mix \
    /home/tester/.hex \
    /home/tester/.npm
  chown tester:tester /content/felt
  chown -R tester:tester /home/tester/go /home/tester/.cache /home/tester/.mix /home/tester/.hex /home/tester/.npm
}

run_as_tester() {
  runuser -u tester -- env \
    HOME=/home/tester \
    USER=tester \
    LOGNAME=tester \
    PATH="$TESTER_PATH" \
    TMPDIR="$TMPDIR" \
    GIT_PAGER=cat \
    PAGER=cat \
    GOTOOLCHAIN=local \
    GOPATH=/home/tester/go \
    GOMODCACHE=/home/tester/go/pkg/mod \
    GOCACHE=/home/tester/.cache/go-build \
    MIX_HOME=/home/tester/.mix \
    HEX_HOME=/home/tester/.hex \
    NPM_CONFIG_CACHE=/home/tester/.npm \
    PLAYWRIGHT_BROWSERS_PATH=/home/tester/.cache/ms-playwright \
    "$@"
}

sync_repo() {
  chmod 0644 /tmp/felt-sync.tar.gz
  run_as_tester bash -euo pipefail -c '
    cd /content/felt
    if [ -d .git ]; then
      # Remove only previously synced tracked files; preserve warm gitignored
      # caches (ui/node_modules, daemon/deps, daemon/_build).
      git ls-files -z | xargs -0 -r rm -rf --
    else
      git init -q
      git config user.name "colab-ci"
      git config user.email "colab-ci@example.invalid"
    fi
    tar -xzf /tmp/felt-sync.tar.gz -C /content/felt
    git add -A
    git commit --allow-empty -q -m "colab-sync $1"
  ' _ "$HEAD_SHA"
  rm -f /tmp/felt-sync.tar.gz
}

arch_detect() {
  case "$(uname -m)" in
    x86_64|amd64) echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    *) echo "test-colab: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

ensure_apt_packages() {
  local missing=()
  command -v tmux >/dev/null 2>&1 || missing+=(tmux)
  command -v ps >/dev/null 2>&1 || missing+=(procps)
  command -v git >/dev/null 2>&1 || missing+=(git)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v jq >/dev/null 2>&1 || missing+=(jq)
  command -v unzip >/dev/null 2>&1 || missing+=(unzip)
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "test-colab: installing apt packages: ${missing[*]}" >&2
    apt-get update -qq
    apt-get install -y -qq "${missing[@]}" >/dev/null
  fi
}

ensure_go() {
  if [ -x /usr/local/go/bin/go ] && /usr/local/go/bin/go version | grep -q "go${GO_VERSION} "; then
    return 0
  fi
  local arch tgz="/tmp/go${GO_VERSION}.tar.gz"
  arch=$(arch_detect)
  echo "test-colab: installing Go ${GO_VERSION} (${arch})..." >&2
  curl --fail --location --retry 3 --silent --show-error \
    "https://go.dev/dl/go${GO_VERSION}.linux-${arch}.tar.gz" -o "$tgz"
  rm -rf /usr/local/go
  tar -C /usr/local -xzf "$tgz"
  rm -f "$tgz"
  go version >&2
}

ensure_codex() {
  if [ -x /opt/test-codex/codex ] && [ -f /opt/test-codex/.pin ] && [ "$(cat /opt/test-codex/.pin)" = "$CODEX_PIN" ]; then
    return 0
  fi
  echo "test-colab: installing pinned test Codex..." >&2
  bash /content/felt/scripts/install-test-codex.sh /opt/test-codex >&2
  printf '%s\n' "$CODEX_PIN" > /opt/test-codex/.pin
}

ensure_node() {
  if [ -x /usr/local/node/bin/node ] && /usr/local/node/bin/node -v | grep -q "^v${NODE_MAJOR}\."; then
    return 0
  fi
  local arch node_arch base line sha filename archive
  arch=$(arch_detect)
  node_arch=$([ "$arch" = "amd64" ] && echo "x64" || echo "arm64")
  echo "test-colab: installing Node ${NODE_MAJOR}.x (${node_arch})..." >&2
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  line=$(curl --fail --location --retry 3 --silent --show-error "${base}/SHASUMS256.txt" \
    | grep "linux-${node_arch}\.tar\.xz$" | head -n 1)
  sha=$(printf '%s' "$line" | awk '{print $1}')
  filename=$(printf '%s' "$line" | awk '{print $2}')
  archive="/tmp/${filename}"
  curl --fail --location --retry 3 --silent --show-error "${base}/${filename}" -o "$archive"
  printf '%s  %s\n' "$sha" "$archive" | sha256sum --check --status
  rm -rf /usr/local/node
  mkdir -p /usr/local/node
  tar -xJf "$archive" -C /usr/local/node --strip-components=1
  rm -f "$archive"
  node -v >&2
}

ensure_beam() {
  local need_otp=1 need_elixir=1
  if [ -x /usr/local/otp/bin/erl ]; then
    local cur_otp
    cur_otp=$(/usr/local/otp/bin/erl -eval 'io:format("~s", [erlang:system_info(otp_release)]), halt().' -noshell 2>/dev/null || true)
    [ "$cur_otp" = "$OTP_MAJOR" ] && need_otp=0
  fi
  if [ -x /usr/local/elixir/bin/elixir ] && /usr/local/elixir/bin/elixir -v 2>/dev/null | grep -q "Elixir ${ELIXIR_MINOR}\."; then
    need_elixir=0
  fi

  if [ "$need_otp" -eq 1 ]; then
    local ubuntu_ver="22.04"
    if [ -r /etc/os-release ]; then
      # shellcheck disable=SC1091
      . /etc/os-release
      [ -n "${VERSION_ID:-}" ] && ubuntu_ver="$VERSION_ID"
    fi
    local otp_base="https://builds.hex.pm/builds/otp/ubuntu-${ubuntu_ver}"
    local otp_tag
    otp_tag=$(curl --fail --location --retry 3 --silent --show-error "${otp_base}/builds.txt" \
      | awk -v maj="$OTP_MAJOR" '$1 ~ ("^OTP-" maj "\\.[0-9]+(\\.[0-9]+)*$") {print $1}' \
      | sort -V | tail -n 1)
    [ -n "$otp_tag" ] || { echo "test-colab: failed to locate OTP ${OTP_MAJOR} for ubuntu-${ubuntu_ver}" >&2; exit 1; }
    echo "test-colab: installing ${otp_tag} (ubuntu-${ubuntu_ver})..." >&2
    local otp_tgz="/tmp/${otp_tag}.tar.gz"
    curl --fail --location --retry 3 --silent --show-error "${otp_base}/${otp_tag}.tar.gz" -o "$otp_tgz"
    rm -rf /usr/local/otp
    mkdir -p /usr/local/otp
    tar -xzf "$otp_tgz" -C /usr/local/otp --strip-components=1
    rm -f "$otp_tgz"
    /usr/local/otp/Install -minimal /usr/local/otp >/dev/null
  fi

  if [ "$need_elixir" -eq 1 ]; then
    local elixir_base="https://builds.hex.pm/builds/elixir"
    local elixir_tag
    elixir_tag=$(curl --fail --location --retry 3 --silent --show-error "${elixir_base}/builds.txt" \
      | awk -v min="$ELIXIR_MINOR" -v maj="$OTP_MAJOR" \
          '$1 ~ ("^v" min "\\.[0-9]+-otp-" maj "$") {print $1}' \
      | sort -V | tail -n 1)
    [ -n "$elixir_tag" ] || { echo "test-colab: failed to locate Elixir ${ELIXIR_MINOR} for OTP ${OTP_MAJOR}" >&2; exit 1; }
    echo "test-colab: installing Elixir ${elixir_tag}..." >&2
    local elixir_zip="/tmp/${elixir_tag}.zip"
    curl --fail --location --retry 3 --silent --show-error "${elixir_base}/${elixir_tag}.zip" -o "$elixir_zip"
    rm -rf /usr/local/elixir
    mkdir -p /usr/local/elixir
    unzip -q -o "$elixir_zip" -d /usr/local/elixir
    rm -f "$elixir_zip"
  fi

  run_as_tester mix local.hex --force --if-missing >/dev/null
  run_as_tester mix local.rebar --force --if-missing >/dev/null
  run_as_tester elixir -v >&2
}

ensure_ui_deps() {
  local lock_sha stamp="/content/felt/ui/node_modules/.colab-npm-ci-sha"
  lock_sha=$(sha256sum /content/felt/ui/package-lock.json | awk '{print $1}')
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$lock_sha" ]; then
    return 0
  fi
  echo "test-colab: running npm ci in ui/..." >&2
  run_as_tester bash -euo pipefail -c 'cd /content/felt/ui && npm ci && printf "%s\n" "$1" > node_modules/.colab-npm-ci-sha' _ "$lock_sha"
}

ensure_playwright() {
  local pw_ver stamp="/home/tester/.cache/ms-playwright/.colab-pw-stamp"
  pw_ver=$(node -e 'const p=require("/content/felt/ui/package.json"); console.log(p.devDependencies["playwright-core"] || "")')
  if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$pw_ver" ]; then
    return 0
  fi
  echo "test-colab: installing Playwright OS deps and Chromium/WebKit browsers..." >&2
  (cd /content/felt/ui && npx playwright-core install-deps chromium webkit)
  run_as_tester bash -euo pipefail -c '
    cd /content/felt/ui
    npx playwright-core install chromium webkit
    mkdir -p "$(dirname "$1")"
    printf "%s\n" "$2" > "$1"
  ' _ "$stamp" "$pw_ver"
}

run_go() {
  ensure_apt_packages
  ensure_go
  ensure_codex
  if [ "${#SUITE_ARGS[@]}" -gt 0 ]; then
    run_as_tester env FELT_REQUIRE_REAL_CODEX=1 bash -euo pipefail -c 'cd /content/felt && go test "$@"' _ "${SUITE_ARGS[@]}"
  else
    run_as_tester env FELT_REQUIRE_REAL_CODEX=1 bash -euo pipefail -c '
      cd /content/felt
      go build -v ./...
      go run ./cmd/felt setup validate --source .
      go test ./...
      bash scripts/test-bootstrap.sh
      claude=$(jq -r .version claude-plugin/.claude-plugin/plugin.json)
      codex=$(jq -r .version claude-plugin/.codex-plugin/plugin.json)
      if [ "$claude" != "$codex" ]; then
        echo "plugin manifest version drift: claude=$claude codex=$codex" >&2
        exit 1
      fi
    '
  fi
}

run_elixir() {
  ensure_apt_packages
  ensure_go
  ensure_beam
  mkdir -p "$ELIXIR_CLI_BIN"
  chown tester:tester "$ELIXIR_CLI_BIN"
  echo "test-colab: installing felt and shuttle to ${ELIXIR_CLI_BIN}..." >&2
  local saved_path="$TESTER_PATH"
  TESTER_PATH="${ELIXIR_CLI_BIN}:${BASE_PATH}"
  run_as_tester bash -euo pipefail -c '
    cd /content/felt
    GOBIN="$1" go install ./cmd/felt ./cmd/shuttle
    felt --version >&2
    shuttle --help >/dev/null
    cd /content/felt/daemon
    MIX_ENV=test mix deps.get
    MIX_ENV=test mix compile --warnings-as-errors
    shift
    if [ "$#" -gt 0 ]; then
      MIX_ENV=test mix test "$@"
    else
      MIX_ENV=test mix test
    fi
  ' _ "$ELIXIR_CLI_BIN" ${SUITE_ARGS[@]+"${SUITE_ARGS[@]}"}
  TESTER_PATH="$saved_path"
}

run_ui() {
  ensure_apt_packages
  ensure_go
  ensure_node
  ensure_ui_deps
  if [ "${#SUITE_ARGS[@]}" -gt 0 ]; then
    run_as_tester bash -euo pipefail -c 'cd /content/felt/ui && npm "$@"' _ "${SUITE_ARGS[@]}"
  else
    run_as_tester bash -euo pipefail -c 'cd /content/felt/ui && npm test && npm run build'
  fi
}

run_e2e() {
  ensure_apt_packages
  ensure_go
  ensure_node
  ensure_ui_deps
  ensure_playwright
  if [ "${#SUITE_ARGS[@]}" -gt 0 ]; then
    run_as_tester bash -euo pipefail -c 'cd /content/felt/ui && npm run "$@"' _ "${SUITE_ARGS[@]}"
  else
    run_as_tester bash -euo pipefail -c 'cd /content/felt/ui && npm run e2e'
  fi
}

run_all() {
  SUITE_ARGS=()
  echo "=== [all 1/4] go ===" >&2
  run_go
  echo "=== [all 2/4] ui ===" >&2
  run_ui
  echo "=== [all 3/4] plugin-hooks-test ===" >&2
  run_as_tester bash -euo pipefail -c 'cd /content/felt && make plugin-hooks-test'
  echo "=== [all 4/4] elixir ===" >&2
  run_elixir
}

ensure_tester_user
sync_repo

if [ "$SUITE" != "shell" ]; then
  echo "test-colab: running suite '${SUITE}' as $(run_as_tester id -un) (uid=$(run_as_tester id -u))..." >&2
fi

case "$SUITE" in
  go)     run_go ;;
  elixir) run_elixir ;;
  ui)     run_ui ;;
  e2e)    run_e2e ;;
  all)    run_all ;;
  shell)  echo "test-colab: synced /content/felt (${HEAD_SHA}); launching interactive shell..." >&2 ;;
esac
BODY
  } > "$script_path"
  chmod +x "$script_path"
}

# `colab sessions` formats each active session line as `[name] endpoint | ...`.
session_exists() {
  local out
  out=$(run_colab sessions 2>&1) || return 1
  printf '%s\n' "$out" | awk -v target="[${session}]" '$1 == target { found = 1 } END { exit (found ? 0 : 1) }'
}

echo "test-colab: preparing working tree ($head_sha, $dirty_state)..." >&2
pack_working_tree "$work/felt-sync.tar.gz"
write_remote_script "$work/felt-colab-run.sh"

reused=0
if [ "$keep" -eq 1 ] || [ "$session_explicit" -eq 1 ]; then
  if session_exists; then
    echo "test-colab: reusing active Colab session '$session'" >&2
    reused=1
    vm_started=1
  fi
fi

if [ "$reused" -eq 0 ]; then
  echo "test-colab: allocating Colab session '$session' (--high-mem${gpu:+ --gpu $gpu}, auth=$auth)..." >&2
  if [ "$keep" -eq 0 ]; then
    vm_should_stop=1
  fi
  run_colab "${new_args[@]}"
  vm_started=1
fi

echo "test-colab: uploading workspace and runner to '$session'..." >&2
run_colab upload -s "$session" "$work/felt-sync.tar.gz" /tmp/felt-sync.tar.gz
run_colab upload -s "$session" "$work/felt-colab-run.sh" /tmp/felt-colab-run.sh

echo "test-colab: running suite '$suite' on '$session'..." >&2
run_colab ssh -s "$session" -- 'GIT_PAGER=cat PAGER=cat bash /tmp/felt-colab-run.sh'

if [ "$suite" = "shell" ]; then
  run_colab ssh -s "$session" -- 'cd /content/felt && export GIT_PAGER=cat PAGER=cat PATH="/usr/local/elixir/bin:/usr/local/otp/bin:/usr/local/go/bin:/usr/local/node/bin:/opt/test-codex:/usr/local/bin:$PATH" && exec bash -l'
fi
