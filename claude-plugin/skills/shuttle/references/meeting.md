# Meeting

A meeting capture is a capture whose input is a live conversation. This page
covers following it live; turning the finished transcript into notes is the
felt skill's `references/transcripts.md`. The user starts a meeting from the
board: from the Capture form in meeting mode, which launches you as a new
capture, or from a constitution's card, which joins the meeting to that
constitution (see [Joined to a constitution](#joined-to-a-constitution)).
`hark` is recording on the user's machine and writing a speaker-labelled
transcript to a path on this host. Your message (`From User`, or a message
into your running session) opens with `Meeting mode`, that path, and the mode
(call or room), followed by the user's note, which may be empty. You are this
meeting's scribe from the moment you claim, or, joined, from the moment the
message arrives.

## The transcript

One line per finished turn, appended a few seconds after the words were
spoken: `14:03:12 S2  so the covariance looks fine at small scales`. Around
interruptions, lines can arrive slightly out of order, so sort by time when it
matters. In call mode, `me` is the user's microphone and `S1`… are the other
participants from the call audio. In room mode, everyone is diarized as
`S1`…. Labels stay anonymous until a naming line such as `# S2 = Martin`
appears. The last line is `# ended HH:MM:SS`.

The file may not exist for the first half-minute while hark loads its models,
and the meeting will usually have begun before you arrive. Follow it with
`hark follow <path>`. It prints the lines already written, then the rest in
batches: a batch flushes at once when a line addresses you by name (or a
mishearing of it), at 150 words, 15 seconds after its first line, or at
`# ended`, after which the command exits. In Claude Code, run it under
`Monitor`, so each batch arrives as an event; elsewhere, run it and read its
stdout as it comes. The transcript is a conversation between colleagues, so
keep it out of git. Reference its path, and quote only what the notes need.

## Steps

1. **Capture as usual, with two meeting specifics** (`capture.md`, steps 1–5).
   The fiber is the meeting: put it where the project keeps meetings,
   conventionally `<hub>/meetings/<YYYY-MM-DD-HHMM>-<slug>`, choosing the hub
   from the note and the project's tree. Its body names when, the mode, and the
   transcript path. If the note is empty, a provisional name is fine; rename it
   once the first minutes make the subject clear. The role in step 2 is
   `scribe`: if the store has no `roles/scribe` charter, create one from this
   page. Its charter carries the user's conventions and outranks this page
   where they differ.
2. **Follow quietly, from the moment you've claimed.** The meeting is already
   running, so start watching before you polish the fiber. Keep notes in the
   fiber as the meeting runs: what was
   discussed, decisions, action items by owner, and open questions, each with
   its timestamp and speaker label as provenance. Don't narrate.
3. **Act when addressed.** A line spoken to the agent by name is a request.
   The recognizer mishears "Claude" as "Cloud", "Clawed" or "Klaud", so read
   generously. Do the request (retrieve a plot, number or past decision, make a
   quick plot, record something) and deliver it where the user can see it
   mid-call: `felt shuttle send-file <path>`. Anything that takes more than a
   couple of minutes, say so and keep following.
4. **Keep the report live.** Keep `report.html` in the fiber directory as the
   meeting's current state: summary, decisions, action items, figures. Rewrite
   it whole and keep it self-contained, per `report.md`. Send it once with
   `send-file` so it sits on the Board, and rewrite it in place after each
   substantive change.
5. **Consolidate at `# ended`** with the felt skill's
   `references/transcripts.md`: the notes document first, then fiber
   extraction as proposals. Rewrite the report, then close the fiber.

Things said in a meeting are candidates. Propose promotions; never make one
silently. Nothing goes to another human (issue, chat, email, wiki) without the
user approving the text.

## Joined to a constitution

When the message says the meeting joins this constitution, you are that
constitution's worker, and you stay it: its charter, roles and open work are
still yours, and the meeting is input to them. Nothing is captured or claimed.

1. **File the meeting as a child fiber**
   `<constitution>/meetings/<YYYY-MM-DD-HHMM>-<slug>`: when, the mode, and the
   transcript path. It holds the running notes and its own `report.html`.
2. **Take `scribe` for the meeting's duration**, alongside the roles you already
   carry. Create `roles/scribe` from this page if the store has none; its
   charter outranks this page. Drop the role at `# ended`.
3. **Follow, act and keep the report live** as in steps 2–4, in the child fiber.
4. **Carry it home.** At `# ended`, consolidate the child fiber as in step 5 and
   close it. Then bring what bears on the constitution back into its own work:
   decisions into its body and plan, action items that are yours into your next
   steps, and the rest as proposals. The constitution stays open.
