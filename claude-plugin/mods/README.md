# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One dim line above the prompt in every Claude session, read from the Shuttle
daemon's `/api/v1/voice` and `/api/v1/speak`: every 150 ms while the mic is
here (the level ticker moves), 500 ms otherwise, 5 s while both say
unavailable.

Mic side, at the left:

| State | Text |
| --- | --- |
| target is this session | `▁▂▅▇▃ …the live words` (the last five mic levels, then hark's words, replaced by Aqua's, cleared once delivered; cut at a word from the left) |
| target is another card (a meeting holds the mic, or Listen here elsewhere) | `🎤 → <card name>` |
| muted | `🎤 muted` |
| Listening off | nothing |

Speaker side, right-aligned; the line itself is never shown:

| State | Text |
| --- | --- |
| speaking | `🔈 <voice>` |
| held while Cail talks | `🔈 paused` |
| lines held for this card | `🔈 <n> waiting` |
| muted | `🔈 muted` |
| idle | nothing |

With nothing on either side the band is not drawn.

**Keys.** Click the mic text or the speaker text to toggle that mute. From the
keyboard: `ctrl+x tab` focuses the band, `tab` moves between the two, and
Enter toggles the focused one. A single-letter hotkey would make the
terminal draw a `m:` caption, so there is none. The `[-]` at the band's right
end is Claude Code's own: it collapses the band (`ctrl+x ctrl+a`), and no mod
can remove it.

The session's fiber comes from `SHUTTLE_FIBER_PATH` (its path id and its
frontmatter `id`); a session that is not a Shuttle worker never reads as
`here`. `SHUTTLE_DAEMON_URL` overrides `http://127.0.0.1:4000`.

Tests: `claude plugin test claude-plugin`.
