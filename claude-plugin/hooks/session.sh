#!/bin/bash
# SessionStart hook for the felt plugin.
#
# Outputs felt workflow context: a one-line activate directive plus dynamic
# state (active fibers, recently touched). The skill body itself carries the
# practice (philosophy, CLI cheatsheet, references); this hook delivers only
# the heads-up + current state.
#
# This hook produces no input-dependent behavior — it ignores stdin and emits
# the same shape on every session start. Used by both Claude Code (declared in
# hooks.json) and Codex (declared in ~/.codex/hooks.json, pointing at the
# symlinked copy).

set -e

# jq parses `felt ls -j` output. Without it we can still emit the directive —
# the most important part of SessionStart context — and tell the user how to
# get the fiber listing back. Bail rather than fail so the session doesn't
# start with a stderr noise wall.
if ! command -v jq >/dev/null 2>&1; then
    cat <<'EOF'
# Felt Workflow Context

**Activate the `felt` skill before any tool or action — every session, even when the user's request seems unrelated to felt.** The skill body carries the practice (philosophy, CLI, references). Reading this context is not the same as having the skill loaded.

*Install [`jq`](https://jqlang.org) to see active and recently touched fibers here.*
EOF
    exit 0
fi

# Walk up from $PWD to find a .felt/ directory; the felt project root.
find_root() {
    local dir="$PWD"
    while [ "$dir" != "/" ]; do
        if [ -d "$dir/.felt" ]; then
            echo "$dir"
            return 0
        fi
        dir=$(dirname "$dir")
    done
    return 1
}

# The activate directive — one line, prominent, justified.
print_directive() {
    cat <<'EOF'
**Activate the `felt` skill before any tool or action — every session, even when the user's request seems unrelated to felt.** The skill body carries the practice (philosophy, CLI, references). Reading this context is not the same as having the skill loaded.

EOF
}

# jq filter: render one fiber as a two-line entry (matches Go formatFeltTwoLine).
#   Line 1: "<icon> <id>"
#   Line 2: "    <display-name> (<comma-tags>)"
ENTRY_FILTER='
def icon:
  if . == "active" then "◐"
  elif . == "open" then "○"
  elif . == "closed" then "●"
  else "·" end;
. as $f
| ($f.status | icon) as $i
| ($f.tags // []) as $tags
| ($f.name // $f.id) as $display
| if ($tags | length) > 0
    then "\($i) \($f.id)\n    \($display) (\($tags | join(", ")))"
    else "\($i) \($f.id)\n    \($display)"
  end
'

# Recently touched: same shape plus an outcome line if present.
RECENT_FILTER='
def icon:
  if . == "active" then "◐"
  elif . == "open" then "○"
  elif . == "closed" then "●"
  else "·" end;
. as $f
| ($f.status | icon) as $i
| ($f.tags // []) as $tags
| ($f.name // $f.id) as $display
| ($f.outcome // "") as $outcome
| ($outcome | if length > 100 then .[:100] + "..." else . end) as $oshort
| (if ($tags | length) > 0
    then " (\($tags | join(", ")))"
    else ""
  end) as $tagstr
| (if ($oshort | length) > 0
    then "\n    → \($oshort)"
    else ""
  end) as $ostr
| "\($i) \($f.id)\n    \($display)\($tagstr)\($ostr)"
'

main() {
    echo "# Felt Workflow Context"
    echo
    print_directive

    local root
    if ! root=$(find_root); then
        echo "*No felt repository in current directory. Start one with \`felt init\` when this conversation produces thinking worth keeping.*"
        return 0
    fi

    cd "$root" || return 0

    # Active fibers.
    local active_json
    active_json=$(felt ls -j -s active 2>/dev/null || echo "[]")
    if [ "$active_json" != "[]" ] && [ -n "$active_json" ]; then
        echo "## Active Fibers"
        echo
        printf '%s' "$active_json" | jq -r ".[] | $ENTRY_FILTER"
        echo
    else
        echo "*No active fibers.*"
        echo
    fi

    # Recently touched: 5 most recent (by mtime) excluding active.
    # `felt ls -j -s all -n 20` gives the 20 most recent across all statuses.
    local all_json
    all_json=$(felt ls -j -s all -n 20 2>/dev/null || echo "[]")
    if [ "$all_json" != "[]" ] && [ -n "$all_json" ]; then
        # jq merge: drop entries whose id is in the active set, take first 5.
        local recent
        recent=$(printf '%s' "$all_json" \
            | jq --argjson active "$active_json" '
                ($active | map(.id)) as $active_ids
                | map(select(.id as $id | $active_ids | index($id) | not))
                | .[:5]
            ')
        if [ "$recent" != "[]" ] && [ -n "$recent" ]; then
            echo "## Recently Touched"
            echo
            printf '%s' "$recent" | jq -r ".[] | $RECENT_FILTER"
            echo
        fi
    fi
}

main
