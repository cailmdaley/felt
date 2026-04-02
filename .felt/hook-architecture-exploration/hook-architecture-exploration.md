---
title: hook architecture exploration
status: closed
tags:
    - decision
    - felt
    - lightcone
depends-on:
    - felt-as-astra-plugin
created-at: 2026-04-02T12:40:01.960577919+02:00
outcome: 'Four approaches tested for felt/ASTRA conscience hook: (1) Prompt hook — fast (~1s), sync, but only sees last_assistant_message prose, not tool calls. 7 fields confirmed by talking to haiku: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active, last_assistant_message. (2) Agent hook — can Read transcript via tools, but blocks session ~10s+. Too slow. (3) Async command hook with asyncRewake — reads transcript JSONL, extracts recent tool calls, pipes to claude -p --model haiku. Exit 2 + stderr wakes model. ~5s but non-blocking. Current winner. (4) claude --bare needs separate login (doesn''t inherit session auth). Open alternative: main model cooperates by ending responses with activity summaries that prompt hook can read.'
---

(hook-architecture-exploration)=
# hook architecture exploration
