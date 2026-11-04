#!/usr/bin/env bash
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/felt-login-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home/.local/bin" "$WORK/home/.shuttle" "$WORK/selected/bin/rel"
printf '%s\n' "$WORK/selected/bin/rel" > "$WORK/home/.shuttle/repo"
printf 'owner\n' > "$WORK/node"
printf '# existing profile\n' > "$WORK/home/.bash_profile"
for helper in shuttle-launch tailscaled-launch shuttle-ensure; do
  printf '#!/bin/sh\nprintf unexpected-start >> "$SHUTTLE_TEST_WORK/starts"\n' > "$WORK/selected/bin/$helper"
  chmod +x "$WORK/selected/bin/$helper"
done
cat > "$WORK/bin/uname" <<'STUB'
#!/bin/sh
printf 'Linux\n'
STUB
cat > "$WORK/bin/hostname" <<'STUB'
#!/bin/sh
cat "$SHUTTLE_TEST_WORK/node"
STUB
cat > "$WORK/bin/mkdir" <<'STUB'
#!/bin/sh
if [ "$SHUTTLE_TEST_RACE" = 1 ]; then
  printf 'other\n' > "$SHUTTLE_TEST_WORK/home/.shuttle/owner-node"
fi
exec /bin/mkdir "$@"
STUB
cat > "$WORK/home/.local/bin/shuttle" <<'STUB'
#!/bin/sh
[ "$*" = 'daemon status' ] || exit 2
[ -z "${SHUTTLE_DAEMON_URL+x}" ] || exit 3
[ -e "$SHUTTLE_TEST_WORK/daemon-up" ]
STUB
chmod +x "$WORK/bin/"* "$WORK/home/.local/bin/shuttle"
run_install() {
  env HOME="$WORK/home" SHELL=/bin/bash PATH="$WORK/bin:$PATH" \
    SHUTTLE_TEST_WORK="$WORK" SHUTTLE_DAEMON_URL=http://remote.invalid \
    SHUTTLE_TEST_RACE="${RACE:-0}" \
    SHUTTLE_OWNER_NODE="${OWNER_OVERRIDE:-}" \
    bash "$REPO/bin/shuttle-login-install" > "$WORK/output" 2>&1
}
# A shared home alone is not authority to claim this login node.
if run_install; then echo 'installer accepted an absent local daemon' >&2; exit 1; fi
[ ! -e "$WORK/home/.shuttle/owner-node" ]
[ ! -e "$WORK/home/.local/bin/shuttle-ensure" ]
! grep -q '# shuttle-ensure' "$WORK/home/.bash_profile"
touch "$WORK/daemon-up"
OWNER_OVERRIDE=other
if run_install; then echo 'installer accepted a different owner node' >&2; exit 1; fi
[ ! -e "$WORK/home/.shuttle/owner-node" ]
unset OWNER_OVERRIDE
# Another node claims the shared home after the initial owner check.
if RACE=1 run_install; then echo 'installer overwrote a concurrent owner claim' >&2; exit 1; fi
[ "$(cat "$WORK/home/.shuttle/owner-node")" = other ]
[ ! -e "$WORK/home/.local/bin/shuttle-ensure" ]
rm "$WORK/home/.shuttle/owner-node"
# Interrupt the installer at its owner-value write. Publication must not expose
# the empty redirection target, and a fresh invocation must still claim it.
cat > "$WORK/interrupt" <<'STUB'
printf() {
  if [ "${2:-}" = owner ]; then kill -KILL $$; fi
  builtin printf "$@"
}
STUB
if BASH_ENV="$WORK/interrupt" run_install; then echo 'installer was not interrupted' >&2; exit 1; fi
[ ! -e "$WORK/home/.shuttle/owner-node" ] || { echo 'interrupted install published an empty owner claim' >&2; exit 1; }
run_install
run_install
[ "$(cat "$WORK/home/.shuttle/owner-node")" = owner ]
[ "$(grep -c '# shuttle-ensure' "$WORK/home/.bash_profile")" = 1 ]
grep -Fxq '# existing profile' "$WORK/home/.bash_profile"
for helper in shuttle-launch tailscaled-launch shuttle-ensure; do
  cmp "$WORK/selected/bin/$helper" "$WORK/home/.local/bin/$helper"
done
[ ! -e "$WORK/starts" ]
# Selected source builds name an immutable assembly, not the bin/rel alias.
printf '%s\n' "$WORK/selected/bin/rel.generation-test" > "$WORK/home/.shuttle/repo"
run_install
printf 'other\n' > "$WORK/home/.shuttle/owner-node"
if run_install; then echo 'installer overwrote an existing owner pin' >&2; exit 1; fi
[ "$(cat "$WORK/home/.shuttle/owner-node")" = other ]
[ "$(grep -c '# shuttle-ensure' "$WORK/home/.bash_profile")" = 1 ]
printf 'PASS: local daemon required, owner pin preserved, selected helpers installed, profile idempotent, no restart\n'
