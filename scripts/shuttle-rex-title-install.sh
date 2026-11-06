#!/bin/sh
# Install the helper RexFocus uses to read Rex's window title, once. macOS binds
# the Accessibility grant to this exact binary, so an installed copy stays put,
# and a failure here leaves following on tab changes without failing the install.

[ "$(uname -s)" = Darwin ] || exit 0
[ -d "$HOME/Library/Application Support/com.superlogical.rex" ] || exit 0

helper="$HOME/.local/bin/shuttle-rex-title"
[ -e "$helper" ] && exit 0

give_up() {
  echo "warning: could not install $helper; Rex session following stays on tab changes" >&2
  exit 0
}

source="$(dirname "$0")/shuttle-rex-title.c"
work=$(mktemp -d) || give_up
trap 'rm -rf "$work"' EXIT
# The linker signs the binary under its output name.
cc -O2 -framework ApplicationServices "$source" -o "$work/shuttle-rex-title" || give_up
mkdir -p "$(dirname "$helper")" || give_up
# ln never replaces a copy a concurrent install placed first.
ln "$work/shuttle-rex-title" "$helper" 2>/dev/null || { [ -e "$helper" ] && exit 0; give_up; }
"$helper" --prompt
exit 0
