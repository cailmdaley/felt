#!/bin/sh
# Install the helper RexFocus uses to read Rex's window title, once. macOS binds
# the Accessibility grant to this exact binary, so an installed copy stays put.
set -eu

[ "$(uname -s)" = Darwin ] || exit 0
[ -d "$HOME/Library/Application Support/com.superlogical.rex" ] || exit 0

helper="$HOME/.local/bin/shuttle-rex-title"
[ -e "$helper" ] && exit 0

mkdir -p "$(dirname "$helper")"
built="$helper.$$"
trap 'rm -f "$built"' EXIT
if ! cc -O2 -framework ApplicationServices "$(dirname "$0")/shuttle-rex-title.c" -o "$built"; then
  echo "warning: could not build $helper; Rex session following stays on tab changes" >&2
  exit 0
fi
mv "$built" "$helper"
"$helper" --prompt || true
