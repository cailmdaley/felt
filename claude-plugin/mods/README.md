# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One dim line in every Claude session, read from the Shuttle daemon: pins at
the left, the mic's state beside them.

```
☰ ⌗ ⧉² 🔊 12 words… ✕
☰ ⌗ ⧉² 🔈 → voice-modes · 8 words… ✕
☰ ⌗ ⧉² 🔇
```

**Pins**, in a Shuttle worker's session: `☰` its constitution, `⌗` its
tapestry (only when the fiber's folder has `tapestry.html`), `⧉n` its sent
files with their count (only when there are some, from `/api/v1/sent-files`).
Each opens that page on the board through `POST /api/v1/board/open`: the
fiber's constitution, its tapestry, or its row on its constitution's page,
unfolded to the files it holds. Read every 5 s.

**Audio**, from `/api/v1/voice` every 150 ms while words come to this session,
500 ms otherwise, 5 s while the daemon says unavailable:

| State | Text |
| --- | --- |
| sound arriving (mic level above -50 dBFS) | `🔊` |
| mic open and quiet | `🔈` |
| muted, or a meeting paused | `🔇` alone |
| words said and not yet sent | ` n words…` after the glyph, then `✕` |
| words go to another card | ` → <slug>`, then ` · n words…` when there are some |
| Listening off | nothing |

The slug is the last segment of the destination's path id, else its name. A
meeting reads as following. Clicking the glyph toggles the mute
(`POST /api/v1/voice/toggle`, the route the board's and the global hotkey's
mute use too); `✕` drops the words not yet sent (`POST /api/v1/voice/discard`).
With no pins and no audio the line is not drawn.

**Placement** is the plugin option `placement` (`/config`, row "Voice line
placement", or `pluginConfigs` in settings):

- `above` (default): its own band above the prompt, with the audio immediately
  after the pins. Claude Code draws its `[-]` collapse control beside it
  (`ctrl+x ctrl+a`); no mod can remove it.
- `below`: on the hint row under the prompt, in place of the engine's hint
  text (`(shift+tab to cycle)`, `esc to interrupt`), costing no line. The
  engine still draws its permission-mode pill and a ` · ` before the line; no
  hook or setting removes them. With nothing to show, the engine's own hint
  returns.

From the keyboard, `ctrl+x tab` focuses the band, `tab` moves between its
buttons, and Enter presses the focused one.

The session's fiber comes from `SHUTTLE_FIBER_PATH` (its path id and its
frontmatter `id`); a session that is not a Shuttle worker has no pins.
`SHUTTLE_DAEMON_URL` overrides `http://127.0.0.1:4000`.

Tests: `claude plugin test claude-plugin`.
