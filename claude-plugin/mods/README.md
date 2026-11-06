# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One line above the prompt in every Claude session, read from the Shuttle
daemon's `/api/v1/voice` and `/api/v1/speak` every 500 ms (5 s while both
say unavailable).

Three looks while Listening is on, the speaker always at the right:

- **The words.** When the voice target is this session the band is the live
  words: hark's preview as it comes, then Aqua's pending text, cleared once
  delivered. Words held for this card while it is cold show too.
- **`🎤 → <card>`** when the mic is fixed on another card (a meeting, or
  Listen here elsewhere).
- **`🎤 muted`** when the mic is muted.

The speaker reads `🔈 <card>: <line>` while speaking, `🔈 paused` while Cail
talks, `🔈 n held` for lines waiting on this card, or `🔈 muted`.

With Listening off the mic side is not drawn; with the speaker idle too, the
band is not drawn at all.

**Keys.** `🎤` and `🔈` are buttons: click one, or focus the band with
`ctrl+x tab` and press `m` (mic mute) or `s` (speaker mute). The `[-]` at the
band's right end is Claude Code's own: it collapses the band (`ctrl+x ctrl+a`)
and no mod can remove it.

The session's fiber comes from `SHUTTLE_FIBER_PATH` (its path id and its
frontmatter `id`); a session that is not a Shuttle worker never reads as
`here`. `SHUTTLE_DAEMON_URL` overrides `http://127.0.0.1:4000`.

Tests: `claude plugin test claude-plugin`.
