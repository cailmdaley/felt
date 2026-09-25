# Meeting

A meeting capture is a capture whose input is a live conversation. This page
covers following it live; turning the finished transcript into notes is the
felt skill's `references/transcripts.md`. The user
started it from the board's Capture form in meeting mode. `hark` is recording
on the user's machine and writing a speaker-labelled transcript to a path on
this host, and `From User` opens with `Meeting mode`, that path, and the mode
(call or room), followed by the user's note, which may be empty. You are this
meeting's scribe from the moment you claim.

## The transcript

One line per finished turn, appended a few seconds after the words were
spoken: `14:03:12 S2  so the covariance looks fine at small scales`. Around
interruptions, lines can arrive slightly out of order, so sort by time when it
matters. In call mode, `me` is the user's microphone and `S1`… are the other
participants from the call audio. In room mode, everyone is diarized as
`S1`…. Labels stay anonymous until a naming line such as `# S2 = Martin`
appears. The last line is `# ended HH:MM:SS`.

The file may not exist for the first half-minute while hark loads its models,
and the meeting will usually have begun before you arrive. Follow it from the
first line: in Claude Code, `Monitor` on `tail -n +1 -F <path>`; elsewhere,
poll by line count. The transcript is a conversation between colleagues, so
keep it out of git. Reference its path, and quote only what the notes need.

## Steps

1. **File, install, claim, activate** exactly as in `capture.md`. The fiber
   is the meeting. Put it where the project keeps meetings, conventionally
   `<hub>/meetings/<YYYY-MM-DD-HHMM>-<slug>`, choosing the hub from the note
   and the project's tree. Its body names when, the mode, and the transcript
   path. If the note is empty, a provisional name is fine; rename it once the
   first minutes make the subject clear.
2. **Take the role.** If the store has a `roles/scribe` fiber, run
   `felt shuttle assign <fiber-id> --role scribe --collaborator <your agent id>`
   (create `roles/scribe/<agent id>` first if it is missing) and read the role
   fiber. It carries the user's conventions and outranks this page where they
   differ.
3. **Follow quietly.** Keep notes in the fiber as the meeting runs: what was
   discussed, decisions, action items by owner, and open questions, each with
   its timestamp and speaker label as provenance. Don't narrate.
4. **Act when addressed.** A line spoken to the agent by name is a request.
   The recognizer mishears "Claude" as "Cloud", "Clawed" or "Klaud", so read
   generously. Do the request (retrieve a plot, number or past decision, make a
   quick plot, record something) and deliver it where the user can see it
   mid-call: `felt shuttle send-file <path>`. Anything that takes more than a
   couple of minutes, say so and keep following.
5. **Keep the report live.** Keep `report.html` in the fiber directory as the
   meeting's current state: summary, decisions, action items, figures. Rewrite
   it whole and keep it self-contained, per `report.md`. Send it once with
   `send-file` so it sits on the Board, and rewrite it in place after each
   substantive change.
6. **Consolidate at `# ended`** with the felt skill's
   `references/transcripts.md`: the notes document first, then fiber
   extraction as proposals. Rewrite the report, then close the fiber.

Things said in a meeting are candidates. Propose promotions; never make one
silently. Nothing goes to another human (issue, chat, email, wiki) without the
user approving the text.
