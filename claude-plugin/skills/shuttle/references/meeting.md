# Meetings and transcripts

A conversation reaches you in one of two ways. A **live meeting** is a capture
whose input is a conversation still happening: you follow its transcript as it
grows and keep notes as you go. An **after-the-fact transcript** is handed to
you whole — a meeting recording's transcript, a voice note, dictation, pasted
notes — with a request like "here's a transcript, make notes". Both end the
same way: [a notes document, then fiber extraction](#from-transcript-to-notes).

Things said in a conversation are candidates. Propose promotions to fibers;
never make one silently. Nothing goes to another human (issue, chat, email,
wiki) without the user approving the text. The transcript is a conversation
between colleagues, so keep it out of git: reference its path, and quote only
what the notes need.

## Live meeting

The user starts a meeting from the board: from the Capture form in meeting
mode, which launches you as a new capture, or from a constitution's card, which
joins the meeting to that constitution (see
[Joined to a constitution](#joined-to-a-constitution)). `hark` is recording on
the user's machine and writing a speaker-labelled transcript to a path on this
host. Your message (`From User`, or a message into your running session) opens
with `Meeting mode`, that path, and the mode (call or room), followed by the
user's note, which may be empty. You are this meeting's scribe from the moment
you claim, or, joined, from the moment the message arrives.

### The transcript

One line per finished turn, appended a few seconds after the words were
spoken: `14:03:12 S2  so the covariance looks fine at small scales`. Around
interruptions, lines can arrive slightly out of order, so sort by time when it
matters. In call mode, `me` is the user's microphone and `S1`… are the other
participants from the call audio. In room mode, everyone is diarized as
`S1`…. Labels stay anonymous until a naming line such as `# S2 = Martin`
appears. The last line is `# ended HH:MM:SS`.

The file may not exist for the first half-minute while hark loads its models,
and the meeting will usually have begun before you arrive. Follow it with
`felt shuttle follow <path>`. It prints the lines already written, then the rest in
batches: a batch flushes at once when a line addresses you by name (or a
mishearing of it), at 150 words, 15 seconds after its first line, or at
`# ended`, after which the command exits. In Claude Code, run it under
`Monitor`, so each batch arrives as an event; elsewhere, run it and read its
stdout as it comes.

### Steps

1. **Capture as usual, with two meeting specifics** (`capture.md`, steps 1–5).
   The fiber is the meeting: put it where the project keeps meetings,
   conventionally `<hub>/meetings/<YYYY-MM-DD-HHMM>-<slug>`, choosing the hub
   from the note and the project's tree. Its body names when, the mode, and the
   transcript path. If the note is empty, a provisional name is fine; rename it
   once the first minutes make the subject clear. The role in step 2 is
   `scribe`: if the store has no `roles/scribe` charter, create one from this
   page. Its charter carries the user's conventions and outranks this page
   where they differ. The supplied `Claim` carries the meeting's launch id:
   post it as given, after the install, and the board seats the meeting on
   your fiber's card, wherever you run.
2. **Follow quietly, from the moment you've claimed.** The meeting is already
   running, so start watching before you polish the fiber. Keep notes in the
   fiber as the meeting runs: what was discussed, decisions, action items by
   owner, and open questions, each with its timestamp and speaker label as
   provenance. Don't narrate.
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
5. **Consolidate at `# ended`** per
   [From transcript to notes](#from-transcript-to-notes): the notes document
   first, then fiber extraction as proposals. Rewrite the report, then close
   the fiber.

### Joined to a constitution

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

## From transcript to notes

A live meeting's running notes are the first draft of the notes document. With
an after-the-fact transcript you weren't there and start from nothing, so show
the draft and the extraction plan and get approval at each step.

### 1. The notes document

The notes are the primary output: readable by someone who wasn't there, and
enough that they know what happened, what was decided, and what's expected of
them. Read the transcript end-to-end and segment it by topic, not by speaker or
chronology. Then write, in this order:

- a title and date, attendees, and a one-sentence purpose;
- a **summary** of two to four sentences, leading with the most consequential
  outcome, for the reader who skims only this;
- **topics**: for each, the trajectory in a few sentences (how the group moved
  from uncertainty to conclusion), with any decision on its own
  `**Decision:**` line and its reason;
- **action items** as a Who / What / When table;
- a **parking lot** (raised but not resolved) and **open questions** (what
  must be answered before next steps).

For a dense meeting it can help to regroup instead into *Decisions and next
steps*, *Not yet landed*, and *New evidence*. For a voice note or dictation
with one speaker, drop the sections that would be empty and keep the summary,
topics and open questions.

- **Decisions are explicit convergence.** "X suggested Y, nobody objected" is a
  proposal, not a decision; when in doubt, demote. Overclaiming creates phantom
  commitments that return later as "but we decided this." For a non-obvious
  decision, keep the factor that tipped it, not the back-and-forth; note
  meaningful dissent by position, not person.
- **Attribute sparingly**: action-item owners, presenters, formal proposals.
  "Concerns were raised about X", not "Alice was worried about X."
- **Action items are atomic.** One owner (never "the team"), one deliverable,
  one deadline, or "TBD — needs confirmation". "I'll send that over" counts.
- **Compress hard.** A 60-minute transcript is ~10,000 words; good notes are
  500–1,000. Cut filler, false starts, repetition and small talk. Keep specific
  numbers, dates, commitments, and the substance behind a shift in the room's
  energy.

Put the notes in the meeting fiber's body (or a new fiber where the project
keeps meetings or notes), and show them to the user. They may restructure, cut,
or add context you couldn't infer; get the notes right before extracting.

### 2. Fiber extraction

Walk the notes for what should persist beyond the conversation: decisions,
action items that are real work, open questions that need their own
investigation, parking-lot items worth tracking, and status on fibers the
store already tracks. Then re-scan the transcript for what the notes
compressed away: an idea buried in a complaint ("this keeps breaking
because…"), a principle dropped as an aside, a decision by omission ("we could
do X but…" and moving on).

Present the plan split into *probably file* and *probably skip* (other people's
action items, ephemeral status), and wait for approval. Then file per the felt
skill: new fibers nested where they belong and linked in prose, closed or
updated outcomes on existing ones, and for narrative updates,
edit `.felt/<path>/<slug>.md` directly. A decision that changes how the project
works may also belong in its root fiber or CLAUDE.md.
