# Meetings and transcripts

Transcripts reach you three ways. In a **live meeting** you are the scribe: you follow the transcript as it grows, keep notes, and answer when someone addresses you. With a **handed-over transcript** — a recording's transcript, a voice note, dictation, pasted notes — you write it up after the fact. And as a worker you can read a **predecessor's session** to recover what its handoff left out. The first two end the same way, in [a notes document and then fibers](#from-transcript-to-notes).

What people say in a conversation is a candidate, not a decision: propose promotions to fibers, never make one silently, and send nothing to another human (issue, chat, email, wiki) until the user approves the text. A meeting transcript is a conversation between colleagues, so keep it out of git; reference its path, and quote only what the notes need.

## Live meeting

The user starts a meeting from the board, either from the Capture form in meeting mode, which launches you as a new capture, or from a constitution's card, which joins the meeting to that constitution. `hark` records on the user's machine and writes a speaker-labelled transcript to a path on this host. Your message opens with `Meeting mode`, that path and the mode, then the user's note, which may be empty. The mode says where the audio comes from: `call` is a call on the user's machine (the user is `me`, the others `S1`, `S2`, …), `room` an in-person meeting on the machine's mic, and `phone` an in-person meeting recorded through a phone's mic; in `room` and `phone` every voice is numbered, the user's included. You are the scribe from the moment you claim, or, when joined, from the moment the message arrives.

### The transcript

Follow it with `shuttle follow <path>`, under `Monitor` in Claude Code, elsewhere by reading its stdout. It waits for the file, prints what is already there, then delivers batches, flushing at once when someone says your name, and exits at `# ended`. The transcript mostly explains itself. Three things it can't show: lines are whole turns and can land slightly out of order around interruptions; the recognizer mangles names and jargon, so read generously; and you can name a speaker yourself by appending a line such as `# S2 = Martin` once the content makes it clear.

### Steps

1. **Capture as usual, with two meeting specifics** ([capture.md](capture.md), steps 1–5). The fiber is the meeting: file it where the project keeps meetings, conventionally `<hub>/meetings/<YYYY-MM-DD-HHMM>-<slug>`, choosing the hub from the note and the project's tree, and give its body the time, the mode and the transcript path. With an empty note a provisional name is fine; rename it once the first minutes make the subject clear. Your role is `scribe`. This page defines the office; the `roles/scribe` charter holds only the user's conventions and what past meetings taught, and outranks this page where they differ. If the store has none, create it with just its name and an empty working-knowledge section. Post the supplied `Claim` as given, after the install; it carries the meeting's launch id, and the board seats the meeting on your fiber's card.
2. **Follow quietly, from the moment you've claimed.** The meeting is already running, so start watching before you polish the fiber. Keep running notes in the fiber — what was discussed, decisions, action items by owner, open questions — each with its timestamp and speaker label. Don't narrate.
3. **Act when addressed.** A line spoken to you by name is a request (`follow` already catches "Cloud", "Clawed" and "Klaud"). Do it — retrieve a plot, a number or a past decision, make a quick plot, record something — and deliver it where the user can see it mid-call with `shuttle send-file <path>`. If it will take more than a couple of minutes, say so and keep following.
4. **Keep the report live.** Keep `report.html` in the fiber folder as the meeting's current state — summary, decisions, action items, figures — rewritten whole and self-contained ([report.md](report.md)). Send it once with `send-file` so it sits on the Board, then rewrite it in place after each substantive change.
5. **Consolidate at `# ended`**: write the notes document and propose the fiber extraction ([below](#from-transcript-to-notes)), rewrite the report, then run `shuttle close <meeting-fiber>`.

### Joined to a constitution

When the message says the meeting joins this constitution, you stay that constitution's worker — its charter, roles and open work are still yours — and the meeting is input to them. You capture and claim nothing.

1. **File the meeting as a child fiber**, `<constitution>/meetings/<YYYY-MM-DD-HHMM>-<slug>`, with the time, the mode and the transcript path. It holds the running notes and its own `report.html`.
2. **Take `scribe` for the meeting's duration**, alongside the roles you already hold (create `roles/scribe` from this page if the store has none), and drop it at `# ended`.
3. **Follow, act and keep the report live** as in steps 2–4, in the child fiber.
4. **Carry it home.** At `# ended`, consolidate, then close the ordinary child fiber with `felt edit <child-fiber> --status closed`. Bring what bears on the constitution back into its work: decisions into its body and plan, your own action items into your next steps, the rest as proposals. The constitution stays open.

## From transcript to notes

A live meeting's running notes are your first draft. With a handed-over transcript you start from nothing and weren't there, so show the user the draft and the extraction plan, and get approval at each step.

### 1. The notes document

Write for someone who wasn't there: enough that they know what happened, what was decided, and what's expected of them. Read the transcript end to end, segment it by topic rather than speaker or time, then write, in this order:

- a title and date, attendees, and a one-sentence purpose;
- a **summary** of two to four sentences, leading with the most consequential outcome;
- **topics**, each with its trajectory in a few sentences — how the group moved from uncertainty to conclusion — and any decision on its own `**Decision:**` line with its reason;
- **action items** as a Who / What / When table;
- a **parking lot** (raised, not resolved) and **open questions** (what must be answered before next steps).

A dense meeting may read better regrouped as *Decisions and next steps*, *Not yet landed* and *New evidence*. A single-speaker voice note keeps just the summary, topics and open questions.

- **A decision is explicit convergence.** "X suggested Y, nobody objected" is a proposal; when in doubt, demote it, because an overclaimed decision comes back later as "but we decided this". For a non-obvious one, keep the factor that tipped it, and note real dissent by position rather than person.
- **Attribute sparingly**: action-item owners, presenters, formal proposals. Write "concerns were raised about X", not "Alice was worried about X".
- **Make action items atomic**: one owner (never "the team"), one deliverable, one deadline or "TBD — needs confirmation". "I'll send that over" counts.
- **Compress hard.** A 60-minute transcript runs ~10,000 words; good notes run 500–1,000. Cut filler, false starts, repetition and small talk; keep numbers, dates, commitments, and the substance behind any shift in the room.

Put the notes in the meeting fiber's body, or a new fiber where the project keeps meetings, and show them to the user, who may restructure, cut, or add context you couldn't infer. Get the notes right before extracting.

### 2. Fiber extraction

Walk the notes for what should outlast the conversation: decisions, action items that are real work, open questions that deserve their own investigation, parking-lot items worth tracking, and news about fibers the store already tracks. Then re-scan the transcript for what the notes compressed away — an idea buried in a complaint ("this keeps breaking because…"), a principle dropped as an aside, a decision by omission ("we could do X but…" and moving on).

Present the plan as *probably file* and *probably skip* (other people's action items, passing status), and wait for approval. Then file per the felt skill: new fibers nested where they belong and linked in prose, updated or closed outcomes on existing ones, and for narrative updates, edit `.felt/<path>/<slug>.md` directly. A decision that changes how the project works may belong in its entry-point fiber or CLAUDE.md too.

## A predecessor's session

A `Previous session: <uuid> (<harness>)` line in your dispatch prompt names the last worker's transcript. Its `## Status` is that worker's summary; the transcript holds what actually happened — the searches, the dead ends, the thinking left mid-flight. Read it when the handoff leaves you wanting that texture, and read it surgically: sessions run to hundreds of thousands of tokens, so never load the whole file, and prefer `## Status` when it already answers the question.

`shuttle` resolves the lineage for you; don't grep raw ledgers or guess harness paths.

```bash
shuttle sessions <fiber-id>                 # every session a fiber has had
shuttle sessions <session-uuid>             # the fiber a session served, and its siblings
shuttle sessions --commit <sha>             # the fiber behind a commit, and its sessions
F=$(shuttle transcript <session-uuid>)      # the transcript as a local file, fetched if remote
shuttle sessions <fiber-id> --materialize --dir <d>   # every transcript, plus manifest.json
```

Each row gives its transcript's availability — `available_local`, `available_remote`, `host_unreachable`, `transcript_missing`, or `identity_pending` while the session id is still unknown — and an unreachable host never reads as absence. `--json` gives the structured rows. A subagent spawned natively by a harness leaves no ledger entry, so find it by searching resolved transcripts for a phrase you know it used.

Once you have the file, read it with `jq` and `rg`. Lines are huge (tool results, base64), so never `cat` or `head` raw; always project through `jq -r` first.

**Claude Code** transcripts are one JSON object per line. Conversation lines have `.type` `user` or `assistant` and content blocks under `.message.content[]` (`text`, `thinking`, `tool_use`, `tool_result`); many other line types exist, so always filter on `.type`. User lines mix real human turns with harness notifications and tool results.

```bash
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' $F | tail -40      # where it ended
jq -r 'select(.type=="user") | .message.content | if type=="string" then . else (map(select(.type=="text")|.text)|join("\n")) end | select(length>0)' $F | tail -20   # last user-side turns
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="thinking") | .thinking' $F | tail -60   # thinking
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text' $F | rg -i -C2 "<keyword>"   # search
```

**Codex** transcripts keep the conversation in `response_item` lines (`.payload.type` `message`, `reasoning`, `function_call`, …). The first `message` items are the injected environment and dispatch context, not the human, and `event_msg` lines duplicate `response_item` content.

```bash
jq -r 'select(.type=="response_item" and .payload.type=="message") | "\(.payload.role): \(.payload.content | map(.text // empty) | join("\n"))"' $F | tail -40   # conversation tail
jq -r 'select(.type=="response_item" and .payload.type=="reasoning") | .payload.summary[]?.text // empty' $F   # reasoning summaries (often empty)
jq -r 'select(.type=="response_item" and .payload.type=="message") | .payload.content | map(.text // empty) | join("\n")' $F | rg -i -C2 "<keyword>"   # search
```

For either, `jq -rs '[.[]|select(.timestamp)] | "\(length) lines, \(first.timestamp) → \(last.timestamp)"' $F` gives the size and time span. A UUID that matches nothing usually means the predecessor ran on another host: `shuttle.host` moved, or the ledger line's `host` differs from where you are.
