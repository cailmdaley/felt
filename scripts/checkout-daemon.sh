#!/bin/sh
# Checkout lifecycle actions are explicit; linked worktrees only build.
set -eu
root=$(git rev-parse --show-toplevel)
root=$(CDPATH= cd -- "$root" && pwd -P)
common=$(git rev-parse --path-format=absolute --git-common-dir)
main=$(CDPATH= cd -- "$(dirname "$common")" && pwd -P)
case "${1:-}" in
  restart|start)
    if [ "$root" != "$main" ]; then
      echo "This is a linked worktree. This host's daemon is selected elsewhere; no daemon was started or stopped."
      echo "Deploy explicitly with bin/shuttle-deploy --hosts local --ref <commit>, or run make restart in $main."
      exit 0
    fi
    if [ "$1" = restart ]; then
      make -C "$root" cli-install
      exec "$root/shuttle" daemon activate-release "$root/bin/rel-built" -- make -C "$root" stop start
    fi
    exec make -C "$root" start-selected
    ;;
  stop)
    if [ "$root" != "$main" ]; then
      exec "$root/shuttle" daemon stop --within "$root"
    fi
    exec "$root/shuttle" daemon stop
    ;;
  *) echo "usage: $0 restart|start|stop" >&2; exit 2 ;;
esac
