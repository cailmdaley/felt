# Claude mods

`hooks.json` names the felt plugin's one Claude Code hooks module; the
plugin manifest points at it, so Codex, which reads `hooks/hooks.json`, never
sees it.

## Voice band (`voice-band.tsx`)

One line in every Claude session, read from the Shuttle daemon: pins at the
left, then the mic's state, where the words go and what is happening to them.

```
⧉ ⌗ ☰ ⚇ 12 words → here · “…and then the other thing”  ✕ cancel
⧉ ⌗ ☰ ⚆ 12 words → here · sends in 9s  ✕ cancel
⧉ ⌗ ☰ ⚆ 8 words → voice-modes · asleep, say “send”  ✕ cancel
⧉ ⌗ ☰ ⚆ → here · ✓ 12 words sent
⧉ ⌗ ☰ ⚆ 📌 → voice-modes
⧉ ⌗ ☰ ⊘
⧉ ⌗ ☰ ○
```

**Pins**, in a Shuttle worker's session: `⧉` its row on the family page,
unfolded to its files; `⌗` its companion page, when its folder has one; and
`☰` its constitution.
The companion is the first available of `tapestry.html`, `artifact.html`, and
`report.html`, checked every 5 s.
Each opens its page on the board through `POST /api/v1/board/open`.

**Audio**, from `/api/v1/voice` every 150 ms while words come to this session,
500 ms otherwise, 5 s while the daemon says unavailable. After the glyph, in
order:

| Part | Text |
| --- | --- |
| glyph | `⚇` speech (above -36 dBFS; holds until below -44 dBFS), `⚆` mic open and quiet, `⊘` muted, `○` Listening off |
| words said and not yet sent, the line in progress included | ` n words` |
| where they go | ` → here`, dim; ` → <slug>` for another card, bright; `📌` before the arrow when pinned, shown even while muted |
| speech running | ` · “…last six words”` of the line in progress |
| quiet, words waiting | ` · sends in Ns`, counting down the quiet gap |
| words waiting for a card with no live conversation | ` · asleep, say “send”`: they are dropped unless they end with "send" |
| for 10 s after a batch leaves | ` · ✓ n words sent`, ` · ? n words unconfirmed` or ` · ✗ n words not sent` |
| any unsent words | `  ✕ cancel` |

With voice unavailable there is no audio side.

The slug is the last segment of the destination's path id, else its name.
Clicking the glyph turns Listening off (`POST /api/v1/voice {enabled: false}`), releasing the mic; starting again takes about 4 s for the recorder to come back. The global hotkey toggles mute (`POST /api/v1/voice/toggle`), which is instant.
Clicking `○` starts Listen on this machine's recorder, as the board's Listen does (`POST /api/v1/voice {enabled: true, muted: false, source: "desktop"}`).
The board sets mute through `POST /api/v1/voice {muted}`.
`✕ cancel` drops the words not yet sent, the line being spoken included (`POST /api/v1/voice/discard`); the day transcript keeps them.
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
