# Listening and transcripts

Listen sends spoken input to a card's worker and keeps a day transcript on the recorder host.
A call can be pinned to its card while the worker takes notes, or a handed-over recording, voice note or pasted transcript can be written up afterwards.
You can also inspect a predecessor's session transcript to recover what its handoff left out.

## Spoken input

The user starts Listen and chooses whether it follows their view or is pinned to one card, and whether to transcribe system audio as well as the mic.
Following sends words to the card in view; a line stays with the card selected when it began.
A following batch for a card without a live worker is dropped unless it ends with `send`, which starts the worker.
Pinned listening sends every batch to its card, starting a cold worker if needed.
Ending a batch with `send` delivers it promptly; names do not trigger delivery.

Each batch arrives as ordinary input: speaker-labelled paragraphs followed by `— shuttle transcript --since HH:MM:SS`.
The recognizer can mangle names and jargon; `me` is a voiceprint match, and other labels can include the user or people in the room.
Use the conversation to judge who is addressing whom, including colleagues; don't filter requests by speaker label.

Read around a batch, including speech that wasn't delivered, in the day transcript:

```bash
shuttle transcript --since 10:30:00
shuttle transcript --date 2026-11-07 --fiber project/card --recorder <host>
shuttle transcript --json
```

Times and dates are recorder-local; `--since` is inclusive.
The daemon defaults to its own host as recorder, so on a worker elsewhere pass `--recorder` with the recording host.
The transcript includes each line's speaker and routed card, including unrouted, discarded and cold-dropped speech.

`shuttle say "<text>"` speaks one line on the user's speaker in your role's voice, holding playback while the user is talking.
While Listen has a card in view, other cards' lines wait until the user opens them or says "play"; "next" moves on.
Speak only inside a conversation the user is clearly having with you by voice: answer in one spoken line and put the rest on the card.
Never speak unprompted or narrate replies to typed turns.

## Notes from a pinned call

For a new topic, the user captures a card, then pins Listen to it; enable System audio for a call played on the computer.
For an existing card, stay its worker and take notes there or in a child meeting fiber, as fits the work.
Read the `roles/scribe` charter if one exists.
Shuttle delivers batches automatically; use `shuttle transcript` to read around them and recover gaps.
There is no end-of-call message: consolidate when the user asks or the conversation ends, and remind them to stop Listen if it remains on.

Keep running notes of topics, explicit decisions, action items, open questions, and their source times and speaker labels.
Act when addressed, deliver useful files with `shuttle send-file`, and keep a self-contained report live when the call needs one ([tapestry.md](tapestry.md)).
Treat speech as candidate material, not automatically a decision.
Keep the transcript out of git; refer to it by recorder, date and time, quoting only what the notes need.
Get the user's approval before promoting proposals into durable records or sending anything to another human.

## From transcript to notes

A live call's running notes are the first draft.
For a handed-over transcript, show the user the draft and extraction plan and get approval at each step.
Read it end to end and write for someone who wasn't there:

- Title, date, attendees and a one-sentence purpose.
- A short summary leading with the most consequential outcome.
- Topics grouped by subject, each with its trajectory and explicit decisions with their reasons.
- Action items with one owner, one deliverable and a deadline or `TBD — needs confirmation`.
- Open questions and a parking lot for ideas raised but not resolved.

Explicit convergence is a decision; a suggestion without objection is still a proposal.
Record substantive dissent and attribute sparingly; preserve numbers, dates and commitments while cutting filler and repetition.
Mark ambiguous names and claims rather than guessing.
Put the notes in the meeting fiber or where the project keeps them, and show them to the user before extracting.

For extraction, identify decisions, real action items, open questions and news about existing fibers; re-scan the transcript for ideas the notes compressed away.
Present what to file and what to skip, and wait for approval.
Then file and update fibers using the felt skill; edit `.felt/<path>/<slug>.md` directly for narrative updates.

## A predecessor's session

A `Previous session: <uuid> (<harness>)` line in your dispatch prompt names the last worker's transcript.
Its `## Status` is that worker's summary; the transcript holds searches, dead ends and thinking left mid-flight.
Read it surgically: sessions run to hundreds of thousands of tokens, so never load the whole file, and prefer `## Status` when it answers the question.

`shuttle` resolves the lineage for you; don't grep raw ledgers or guess harness paths.

```bash
shuttle sessions <fiber-id>                 # every session a fiber has had
shuttle sessions <session-uuid>             # the fiber a session served, and its siblings
shuttle sessions --commit <sha>             # the fiber behind a commit, and its sessions
F=$(shuttle transcript <session-uuid>)      # the transcript as a local file, fetched if remote
shuttle sessions <fiber-id> --materialize --dir <d>   # every transcript, plus manifest.json
```

Each row gives availability: `available_local`, `available_remote`, `host_unreachable`, `transcript_missing`, or `identity_pending` while the session id is unknown.
An unreachable host never reads as absence; `--json` gives structured rows.
A native subagent leaves no ledger entry, so search resolved transcripts for a phrase it used.

Once you have the file, read it with `jq` and `rg`.
Lines are huge (tool results, base64), so never `cat` or `head` raw; always project through `jq -r` first.

**Claude Code** transcripts are one JSON object per line.
Conversation lines have `.type` `user` or `assistant` and content blocks under `.message.content[]` (`text`, `thinking`, `tool_use`, `tool_result`); many other line types exist, so always filter on `.type`.
User lines mix human turns with harness notifications and tool results.

```bash
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$F" | tail -40
jq -r 'select(.type=="user") | .message.content | if type=="string" then . else (map(select(.type=="text")|.text)|join("\n")) end | select(length>0)' "$F" | tail -20
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="thinking") | .thinking' "$F" | tail -60
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' "$F" | rg -i -C2 "<keyword>"
```

**Codex** transcripts keep the conversation in `response_item` lines (`.payload.type` `message`, `reasoning`, `function_call`, …).
The first `message` items are injected environment and dispatch context, not the human, and `event_msg` lines duplicate `response_item` content.

```bash
jq -r 'select(.type=="response_item" and .payload.type=="message") | "\(.payload.role): \(.payload.content | map(.text // empty) | join("\n"))"' "$F" | tail -40
jq -r 'select(.type=="response_item" and .payload.type=="reasoning") | .payload.summary[]?.text // empty' "$F"
jq -r 'select(.type=="response_item" and .payload.type=="message") | .payload.content | map(.text // empty) | join("\n")' "$F" | rg -i -C2 "<keyword>"
```

For either, `jq -rs '[.[]|select(.timestamp)] | "\(length) lines, \(first.timestamp) → \(last.timestamp)"' "$F"` gives the size and time span.
A UUID that matches nothing usually means the predecessor ran on another host: `shuttle.host` moved, or the ledger line's `host` differs from where you are.
