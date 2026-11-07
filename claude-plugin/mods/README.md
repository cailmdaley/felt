# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One dim voice line in every Claude session, read from the Shuttle
daemon's `/api/v1/voice` and `/api/v1/speak`: every 150 ms while the mic is
here (the level ticker moves), 500 ms otherwise, 5 s while both say
unavailable.

**Placement** is the plugin option `placement` (`/config`, row "Voice line
placement", or `pluginConfigs` in settings):

- `above` (default): its own band above the prompt, the speaker
  right-aligned. Claude Code draws its `[-]` collapse control beside it and
  keeps its status row between the band and the input.
- `below`: on the hint row under the prompt, in place of the engine's hint
  text (`(shift+tab to cycle)`, `esc to interrupt`), costing no line. The
  engine still draws its permission-mode pill and a ` · ` before the voice
  line (`⏵⏵ auto mode on · ▁▂▃…  🔈 felt debug 1`); no hook or setting removes
  them. With nothing to show, the engine's own hint returns. The voice line
  is not right-aligned there, and the keyboard focus path does not reach it.

Mic side, at the left:

| State | Text |
| --- | --- |
| words come to this session | `▁▁▂▅▇▅▃▂▁▁▁▁▁▁▁▁▁▁▁▁` (the last twenty mic levels, about 3 s, scrolling left; no words, which the transcript and the board show), led by `● ` in a meeting |
| following, words go to another card | `🎤 → <card name>` |
| a meeting joined to another card | `● meeting → <card name>` |
| paused | `🎤 paused`, or `● meeting paused` |
| Listening off | nothing |

Speaker side, right-aligned; the line itself is never shown:

| State | Text |
| --- | --- |
| speaking | `🔈 <voice>` |
| held while the human talks | `🔈 paused` |
| lines held for this card | `🔈 <n> waiting` |
| muted | `🔈 muted` |
| idle | nothing |
| lines other cards hold until they are in view | `🔈 Civbench 2, felt debug 1 +1` after any state above (`🔈 aria · Civbench 2`), the two cards with most first, named by the daemon; each card is its own chip |

With nothing on either side the band is not drawn.

**Colour**, from the theme so light and dark both hold: a ticker glyph at the
floor is dim, green (`success`) through the middle, amber (`warning`) from
-20 dBFS; every other state is dim, except `🔈 <voice>` while speaking, in
`claude`.

**Keys.** Click the mic text or the speaker's state to toggle that mute. Click a held card's chip to open that card, as a click on the board does (`POST /api/v1/voice/reveal`): Rex selects its session, the mic follows, and its held lines play. From the
keyboard: `ctrl+x tab` focuses the band, `tab` moves between the two, and
Enter toggles the focused one. A single-letter hotkey would make the
terminal draw a `m:` caption, so there is none. The `[-]` at the band's right
end is Claude Code's own: it collapses the band (`ctrl+x ctrl+a`), and no mod
can remove it.

The session's fiber comes from `SHUTTLE_FIBER_PATH` (its path id and its
frontmatter `id`); a session that is not a Shuttle worker never reads as
`here`. `SHUTTLE_DAEMON_URL` overrides `http://127.0.0.1:4000`.

Tests: `claude plugin test claude-plugin`.
