# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One line above the prompt in every Claude session, read from the Shuttle
daemon's `/api/v1/voice` and `/api/v1/speak` every 500 ms (5 s while both
say unavailable).

- **Left, the mic.** `● here` when the voice target is this session's fiber,
  `○ → <card>` when it is elsewhere, `mic muted`, `mic failed`, or `mic off`.
- **Middle, the words.** While the mic is here: hark's preview as it comes,
  then Aqua's pending text, cleared once delivered; words held for this card
  while it is cold show as `held: …`.
- **Right, the speaker.** `🔈 <voice>: <line>` while speaking, `🔈 paused`
  while Cail talks, `🔈 n held` for lines waiting on this card, or
  `speaker muted`.

The band is not drawn when Listening is off and the speaker has nothing to
show.

**Keys.** The mic and speaker labels are buttons: click one, or focus the band
with `ctrl+x tab` and press `m` (mic mute) or `s` (speaker mute).

The session's fiber comes from `SHUTTLE_FIBER_PATH` (its path id and its
frontmatter `id`); a session that is not a Shuttle worker never reads as
`here`. `SHUTTLE_DAEMON_URL` overrides `http://127.0.0.1:4000`.

Tests: `claude plugin test claude-plugin`.
