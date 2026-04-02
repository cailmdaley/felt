#!/usr/bin/env bash
# Astral conscience — async Stop hook that reads transcript and nudges via haiku
# asyncRewake: runs in background, exit 2 + stderr wakes the model

set -euo pipefail

# Read hook input from stdin
INPUT=$(cat)

# Check stop_hook_active — don't re-nudge on our own continuation
ACTIVE=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('stop_hook_active', False))" 2>/dev/null)
if [ "$ACTIVE" = "True" ]; then
  exit 0
fi

# Get transcript path
TRANSCRIPT=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('transcript_path', ''))" 2>/dev/null)
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi

# Only run in felt-enabled projects
CWD=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('cwd', ''))" 2>/dev/null)
if [ ! -d "$CWD/.felt" ]; then
  exit 0
fi

# Throttle: only fire if 3+ minutes since last run
THROTTLE_FILE="/tmp/astra-conscience-$(echo "$CWD" | md5sum | cut -c1-12).last"
if [ -f "$THROTTLE_FILE" ]; then
  LAST=$(cat "$THROTTLE_FILE")
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST ))
  if [ "$ELAPSED" -lt 180 ]; then
    exit 0
  fi
fi
date +%s > "$THROTTLE_FILE"

# Track where we left off so each firing only sees new activity
OFFSET_FILE="/tmp/astra-conscience-$(echo "$CWD" | md5sum | cut -c1-12).offset"
SKIP=0
if [ -f "$OFFSET_FILE" ]; then
  SKIP=$(cat "$OFFSET_FILE")
fi
TOTAL_LINES=$(wc -l < "$TRANSCRIPT")

# Extract user messages, assistant prose, and tool calls (no tool output)
RECENT=$(python3 -c "
import sys, json

tools = []
prose = []
user_msgs = []
skip = $SKIP
for i, line in enumerate(open('$TRANSCRIPT')):
    if i < skip:
        continue
    try:
        obj = json.loads(line.strip())
        if obj.get('type') == 'human':
            msg = obj.get('message', {})
            for block in (msg.get('content', []) if isinstance(msg.get('content'), list) else []):
                if block.get('type') == 'text':
                    text = block.get('text', '').strip()
                    if text and not text.startswith('<system-reminder>'):
                        user_msgs.append(text[:300])
            if isinstance(msg.get('content'), str):
                text = msg['content'].strip()
                if text and not text.startswith('<system-reminder>'):
                    user_msgs.append(text[:300])
        elif obj.get('type') == 'assistant':
            msg = obj.get('message', {})
            for block in msg.get('content', []):
                if block.get('type') == 'tool_use':
                    name = block.get('name', '?')
                    inp = block.get('input', {})
                    if name == 'Bash':
                        detail = inp.get('command', '')[:120]
                    elif name == 'Read':
                        detail = inp.get('file_path', '')
                    elif name == 'Edit':
                        detail = inp.get('file_path', '') + ' ' + inp.get('new_string', '')[:80]
                    elif name == 'Write':
                        detail = inp.get('file_path', '')
                    elif name == 'Skill':
                        detail = inp.get('skill', '')
                    elif name == 'Agent':
                        detail = inp.get('description', '')
                    elif name == 'AskUserQuestion':
                        qs = inp.get('questions', [])
                        detail = '; '.join(q.get('question', '')[:80] for q in qs)
                    else:
                        detail = str(inp)[:80]
                    tools.append(f'{name}({detail})')
                elif block.get('type') == 'text':
                    text = block.get('text', '').strip()
                    if text:
                        prose.append(text)
    except:
        pass

output = '## User messages\n' + '\n---\n'.join(user_msgs[-10:]) if user_msgs else ''
output += '\n\n## Tool calls\n' + '\n'.join(tools[-30:]) if tools else '\n\nNo tools'
output += '\n\n## Assistant prose\n' + '\n---\n'.join(prose[-10:]) if prose else ''
# Cap at ~12k chars to keep Haiku prompt reasonable
print(output[:12000])
" 2>/dev/null)

# Save current line count so next firing starts here
echo "$TOTAL_LINES" > "$OFFSET_FILE"

if [ -z "$RECENT" ]; then
  exit 0
fi

# Session persistence — reuse astral conscience session so /felt skill stays warm
SESSION_FILE="/tmp/astra-conscience-$(echo "$CWD" | md5sum | cut -c1-12).id"

CONSCIENCE_PROMPT="You are a gentle conscience for a research conversation that uses felt.

It is hard for any being to focus on the in-the-moment technical aspects of research — editing TeX, debugging pipelines, thinking through physics — while also remembering to annotate and formalize. That is where you come in. You watch the conversation and notice when decisions, findings, or patterns are slipping by unrecorded.

Below is the latest activity. If you notice decisions, findings, or patterns that should be recorded as fibers but weren't, say so warmly and specifically. If fibers are being filed well, say QUIET.

Respond with ONLY one of:
- QUIET
- A brief nudge — warm, specific, maybe a little cryptic. You are an astral conscience, not a project manager.

$RECENT"

if [ -f "$SESSION_FILE" ]; then
  SESSION_ID=$(cat "$SESSION_FILE")
  # Resume existing conscience session (skill already activated)
  RESULT=$(echo "$CONSCIENCE_PROMPT" | claude -p --model haiku --resume "$SESSION_ID" --output-format json --allowedTools "Skill" 2>/dev/null) || true
else
  # First call — activate felt skill, capture session ID
  FIRST_PROMPT="First, activate the /felt skill to learn what felt is and how fibers work. Then review the session activity below.

$CONSCIENCE_PROMPT"
  RESULT=$(echo "$FIRST_PROMPT" | claude -p --model haiku --output-format json --allowedTools "Skill" 2>/dev/null) || true
fi

# Always store session ID (even on QUIET) so /felt stays warm
SID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)
if [ -n "$SID" ]; then
  echo "$SID" > "$SESSION_FILE"
fi

# Extract the text response
RESPONSE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',''))" 2>/dev/null)

# If haiku said QUIET or empty, exit cleanly
if [ -z "$RESPONSE" ] || echo "$RESPONSE" | grep -qi "^QUIET"; then
  exit 0
fi

# Haiku has something to say — wake the model
echo "$RESPONSE" >&2
exit 2
