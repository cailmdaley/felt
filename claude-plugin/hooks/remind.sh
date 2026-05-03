#!/bin/bash
# PreToolUse hook for the felt plugin — gates tool use until the felt skill
# has been activated. Reads JSON from stdin describing the pending tool call:
#
#   { "session_id": "...", "tool_name": "...", "cwd": "...",
#     "transcript_path": "..." }
#
# Behavior:
#   - Outside felt-enabled projects (no .felt/ at cwd): pass through silently.
#   - Skill tool call (the agent activating): mark the per-session flag and pass.
#   - Codex sessions: mark and pass — Codex has no Skill tool to activate, and
#     its SessionStart already delivers the felt context.
#   - Subsequent tool calls when the flag exists: pass through.
#   - First non-Skill tool call when the flag is absent: emit a deny JSON
#     payload telling the agent to activate the felt skill first.

set -e

# Required: jq for parsing input. Bail silently if missing — better to lose
# the gate than block all tools.
if ! command -v jq >/dev/null 2>&1; then
    exit 0
fi

# Read input JSON from stdin.
INPUT=$(cat)
if [ -z "$INPUT" ]; then
    exit 0
fi

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty')
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty')
TRANSCRIPT_PATH=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')

# No cwd means we can't locate the project; pass.
[ -z "$CWD" ] && exit 0

# Only gate inside felt-enabled projects.
[ ! -d "$CWD/.felt" ] && exit 0

# Per-session flag file. Once set, the gate stays open for this session.
TMP="${TMPDIR:-/tmp}"
TMP="${TMP%/}"
FLAG="$TMP/felt-reminded-$SESSION_ID"

# Skill activation: pass through (always allowed — agent must be free to
# activate any skill). But only open the gate on felt activation specifically;
# activating shuttle, ralph, etc. does not satisfy the felt-first requirement.
# Without this asymmetry, the agent could bypass felt by activating a sibling
# skill as its first move.
if [ "$TOOL_NAME" = "Skill" ]; then
    SKILL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_input.skill // empty')
    case "$SKILL_NAME" in
        felt|felt:felt|felt@*)
            : > "$FLAG"
            ;;
    esac
    exit 0
fi

# Codex sessions: detected by transcript_path NOT under ~/.claude/projects/.
# Codex has no Skill tool to activate, and the deny would deadlock its loop.
# Empty transcript_path also counts as non-Claude.
CLAUDE_PROJECTS_PREFIX="$HOME/.claude/projects/"
if [ -z "$TRANSCRIPT_PATH" ] || [ "${TRANSCRIPT_PATH#"$CLAUDE_PROJECTS_PREFIX"}" = "$TRANSCRIPT_PATH" ]; then
    : > "$FLAG"
    exit 0
fi

# Already activated this session: pass.
if [ -e "$FLAG" ]; then
    exit 0
fi

# Gate is closed. Deny the tool call and tell the agent why.
cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Activate the felt skill first. You are in a felt-enabled project but haven't activated the felt skill yet. Call the Skill tool with skill: \"felt\" before proceeding with any other tools. The skill body carries the philosophy, CLI cheatsheet, and references that shape how to work — reading the SessionStart context is not the same as having the skill loaded."
  }
}
EOF
