# Predecessor Transcripts

The dispatch prompt's `Previous session: <uuid> (<harness>)` line names the prior worker's on-disk transcript. The `## Status` handoff is that worker's *summary*; the transcript is its *actual last turns* — searches run, dead ends hit, thinking left mid-flight. Read it surgically when the handoff leaves you wanting the texture: never dump the whole file into context (sessions run to hundreds of thousands of tokens), and prefer `## Status` when it already answers the question.

## Provenance: fiber ↔ session ↔ commit ↔ transcript

`felt shuttle` owns the lineage; you never grep raw ledgers or guess harness paths.

```bash
# fiber → every session it has had (host, harness, transcript availability)
felt shuttle sessions <fiber-id>

# reverse: session UUID or commit → owning fiber + disposition, then its sessions
felt shuttle sessions <session-uuid>
felt shuttle sessions --commit <sha>

# session → transcript as an ordinary local file
# (native path when local; verified managed-cache copy when the session ran on another host)
F=$(felt shuttle transcript <session-uuid>)

# fiber-wide: resolve all available transcripts + write manifest.json
# (session, host, harness, lifecycle events, source path, sha256, availability per entry)
felt shuttle sessions <fiber-id> --materialize --dir <d>
```

Availability is explicit and honest — `identity_pending`, `available_local`, `available_remote`, `host_unreachable`, `transcript_missing` are distinct; an unreachable host is never reported as absence. `--json` gives the structured rows (transcript details under `.transcript`).

Shuttle-mediated lineage (dispatch, resume, claim) is structural in the ledger. Harness-native subagent spawns are *not* — recover those by exact phrase search over resolved transcripts: `felt shuttle transcript` (or `--materialize`), then `rg` the shared phrase with the recipes below.

Once you have the file path, everything below is ordinary `jq`/`rg` — there is deliberately no shuttle-side tail/search/excerpt mini-language.

## claude-code recipes

One JSON object per line; conversation lines have `.type` `user`/`assistant` with content blocks under `.message.content[]` (types `text`, `thinking`, `tool_use`, `tool_result`). Many non-conversation line types (`attachment`, `file-history-*`, …) — always filter by `.type`.

```bash
# where did it end — last assistant prose (the money read)
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' $F | tail -40

# last user-side messages (includes system notifications — recognizable by their framing)
jq -r 'select(.type=="user") | .message.content | if type=="string" then . else (map(select(.type=="text")|.text)|join("\n")) end | select(length>0)' $F | tail -20

# thinking blocks
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="thinking") | .thinking' $F | tail -60

# keyword search over prose (assistant text; swap type/field to search user or thinking)
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' $F | rg -i -C2 "<keyword>"

# overview: volume + time span
jq -rs '[.[]|select(.timestamp)] | "\(length) lines, \(first.timestamp) → \(last.timestamp)"' $F
```

## codex recipes

One JSON object per line with `.type` (`session_meta`, `response_item`, `event_msg`, …); conversation lives in `response_item` payloads (`.payload.type`: `message`, `reasoning`, `function_call`, …).

```bash
# conversation tail, role-labeled
jq -r 'select(.type=="response_item" and .payload.type=="message") | "\(.payload.role): \(.payload.content | map(.text // empty) | join("\n"))"' $F | tail -40

# reasoning summaries (often empty — codex persists summaries, not full CoT)
jq -r 'select(.type=="response_item" and .payload.type=="reasoning") | .payload.summary[]?.text // empty' $F

# keyword search over conversation
jq -r 'select(.type=="response_item" and .payload.type=="message") | .payload.content | map(.text // empty) | join("\n")' $F | rg -i -C2 "<keyword>"

# overview
jq -rs '[.[]|select(.timestamp)] | "\(length) lines, \(first.timestamp) → \(last.timestamp)"' $F
```

## Gotchas

- Lines are huge (tool results, base64) — never `cat`/`head` raw; always project through `jq -r` first.
- The first codex `message` items are the injected environment/dispatch context, not the human.
- claude-code user lines mix real human turns with harness notifications and tool results; codex `event_msg` lines duplicate `response_item` content — filter as above and both stay quiet.
- A UUID that matches nothing usually means the predecessor ran on another host (`shuttle.host` moved, or the ledger line's `host` differs from where you are).
