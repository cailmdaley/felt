# Constitution themes

A constitution can give its Shuttle channel a visual identity without changing its documents or the Desk.
Its theme reaches the reader's veil, floating chrome, filmstrip and thumbnail paper, page frames, label bars, fiber header and prose, Markdown or text pages, and audio waveform ink.
On the Board overview, its changed-work rows and every folio density wear the same paper and accents.
Its sidebar card has its own channel boundary, even inside another constitution's reader.
Phone top and bottom bars and the page sheet use the channel's materials without adding a card frame around the edge-to-edge page.
HTML reports, PDFs, images and other documents keep their own styling.

## Declaration

Pick a bundled theme in the fiber's frontmatter:

```yaml
theme: blueprint
```

The bundled names are `portolan` (the default), `blueprint`, `laboratory-paper`, and `night-chart`.
Names are case-insensitive; spaces can stand in for hyphens.
An unknown name uses Portolan and warns in the browser console.
The reference CSS files live in `ui/src/board/workspace/themes/`.

A sibling `theme.css`, beside the fiber's Markdown and `report.html`, layers on top of that bundled base.
You can supply either declaration, or both.
Shuttle fetches the stylesheet from the fiber's owning daemon through the same owner-routed file API as documents.
It caches by ETag and checks for edits on the workspace's ordinary refresh cadence (at most once every 15 seconds while the channel is drawn).
Missing, unreachable or unparseable CSS leaves the bundled base in place; it never prevents reading.
CSS uses the browser's error recovery: malformed individual declarations are ignored, and a nonempty file with no valid rules is rejected.

The constitution-name menu has a **Plain** toggle.
It removes both the bundled theme and custom CSS for this viewer, including sidebar cards, changed-work rows and folios, without editing the fiber.
The choice is stored locally by channel and host; blocked browser storage doesn't prevent the toggle from working for the current session.

## CSS boundary

Write ordinary CSS, with `:scope` naming the channel's root:

```css
:scope { --ws-paper: #f1f4eb; }
[data-part='fiber-title'] { border-bottom: 1px dotted var(--ws-hairline); }
```

Shuttle parses the file with a constructable `CSSStyleSheet` and scopes style rules through CSSOM under the channel's `[data-ws-theme]` boundary.
Selector lists, functional selectors and CSS nesting retain their browser-defined meaning.
Rules inside `@media`, `@supports` and `@layer` retain their conditions and are scoped recursively.
Rules can't select the Desk or an adjacent channel; arbitrary selectors such as `body` don't escape the boundary.
Each sidebar card, changed-work row and folio is an independent root for its own constitution.
Nested roots reset inherited typography and custom properties, so a foreign card or a card in Plain mode doesn't inherit the open reader's theme.

### Act zone

The composer and its verbs, Temper/Discard, verdict plates, the navbar and sidebar worker controls, and the undo toast are **act zones**, marked `data-part="act"`.
The `data-act` attribute identifies `composer`, `verdict`, `worker` or `toast`; it isn't permission for theme rules to enter.
Each generated CSS scope stops before that zone, so even a broad `button { color: red }` rule can't select Temper or the worker control.
The zone also resets inherited UI variables and typography to the unthemed defaults, accepting only `--ws-paper` and `--ws-ink` from the channel.
Its hairlines and control fills derive from that paper and ink; its fonts, sizing and pigment meanings remain Shuttle's.
The body-level undo toast copies those two material tokens when the verdict is queued, retaining that constitution's paper and ink if the reader navigates elsewhere.
It never receives the author's scoped CSS.
This boundary is structural, not a styling convention.

`@font-face` definitions are hoisted as written; give custom font families distinctive names because their definitions are document-wide.
`@keyframes` names are prefixed with the channel identity, and `animation` and `animation-name` references are rewritten to match.
Only HTTPS imports from `fonts.googleapis.com` are retained; other imports are dropped with a console note.
Other global at-rules are omitted with a console note.
Relative URLs resolve against the board page; use absolute URLs or data URIs for ornaments and fonts.
Custom themes are CSS, not a sandbox for untrusted network resources.

Stylesheets are removed when no reader, sidebar card, changed-work row or folio uses them.
Changing a theme repaints a paused audio waveform without replacing its player or losing playback position.
Channel selection and page styling change immediately; only the veil's tint crosses over 280 ms.
Reduced motion disables theme animations and transitions, and reduced transparency makes the veil opaque.

## Variables

The `--ws-*` materials derive from the Desk's `--kbn-*` tokens in `tokens.css`.
Set variables on `:scope`, not `:root`, so they apply to this channel.
These are the stable styling tokens:

| Variables | Surface |
|---|---|
| `--ws-ground`, `--ws-veil`, `--ws-veil-filter` | Opaque ground, translucent veil tint, backdrop filter |
| `--ws-paper`, `--ws-sheet`, `--ws-fill`, `--ws-hover` | Page paper, stacked sheets, selection and hover fills |
| `--ws-ink`, `--ws-ink-soft`, `--ws-ink-muted`, `--ws-ink-faint` | Main text through secondary metadata |
| `--ws-hairline`, `--ws-hairline-soft` | Strong and soft rules |
| `--ws-you`, `--ws-focus` | Human pigment and keyboard focus |
| `--ws-agent`, `--ws-machine`, `--ws-machine-halo` | Agent ink and halo |
| `--ws-owed`, `--ws-fresh` | Owed/waiting text and fresh-receipt dot |
| `--ws-verdict` | Verdict ink |
| `--ws-serif`, `--ws-mono`, `--ws-mono-tracking` | Prose/name stack, metadata stack and tracking |
| `--ws-heading-size`, `--ws-section-size`, `--ws-lede-size`, `--ws-prose-size` | Fiber title, section, outcome and body sizes |
| `--ws-label-size`, `--ws-small-size`, `--ws-chrome-size` | Labels, metadata and controls |
| `--ws-radius`, `--ws-control-radius`, `--ws-line-width`, `--ws-float` | Frame shape, control shape, borders and elevation shadow |

Set related text and background tokens together and check contrast.
Ordinary text needs at least 4.5:1 contrast; large text needs 3:1.
Workspace layout measures also live in `tokens.css`, but changing page geometry, timing or touch-target sizes isn't part of this styling contract.

## Parts

These hooks are stable; renaming or removing one is a theme-breaking change.

| Selector | Part |
|---|---|
| `[data-part='veil']` | Still backdrop beneath the reader |
| `[data-part='chrome-plate']` | Floating return/title or filmstrip plate; excludes the worker plate |
| `[data-part='tab-strip']` | Filmstrip container |
| `[data-part='tab']` | Document tab |
| `[data-part='tab'][aria-selected='true']` | Selected tab |
| `[data-part='label-bar']` | Bottom document label and its controls |
| `[data-part='page-frame']` | Paper sheet enclosing content and label |
| `[data-part='fiber-header']` | Fiber status header |
| `[data-part='fiber-title']` | Constitution title |
| `[data-part='act']` | Scope limit, **not** a styling hook; composer, verdicts, workers and undo toast |
| `[data-part='prose']` | Fiber article or text/Markdown pane |
| `[data-part='prose'] h1`, `h2`, `h3`, `p`, `blockquote`, `code`, `table`, `hr` | Prose elements; prefix each with the prose selector |
| `[data-part='thumbnail']` | Shared preview's UI paper in filmstrip, folios, changed-work rows and page sheet |
| `[data-part='thumbnail-face']` | Designed text face beneath a loaded preview |
| `:scope[data-part='sidebar-card']` | Channel's Desk-card face in the reader sidebar |
| `:scope[data-part='since-row']` | Channel's since-you-were-here row |
| `:scope[data-part='folio']` | Channel's overview folio |
| `:scope[data-part='folio'][data-density='full']` | Full-height folio |
| `:scope[data-part='folio'][data-density='compact']` | Compact thumbnail-and-text card |
| `:scope[data-part='folio'][data-density='line']` | Short row: 36 px desktop, 44 px phone |
| `[data-part='phone-topbar']` | Reader navbar; top bar on phone |
| `[data-part='phone-bottom-bar']` | Phone page title, arrival and stepping controls |
| `[data-part='page-sheet']` | Modal page chooser |
| `[data-part='page-sheet-panel']` | Page chooser's paper panel |
| `[data-part='page-sheet-row']` | One page choice, with its thumbnail |
| `[data-part='audio-page']` | Listening page and comparison list |
| `[data-part='audio-waveform']` | Canvas; its CSS `color` sets the played waveform ink |

The same CSS is used on reader and compact channel roots.
Keep card and row ornamentation light, preserve their density and touch targets, and don't use pseudo-elements that intercept clicks or cover controls.
Thumbnail paper and text faces can be styled; the HTML, PDF and image contents of loaded previews keep their own appearance.
On the phone, bundled themes remove frame radius, clip paths, borders and shadows so pages stay edge to edge.

## Pigments

The board's pigments carry meaning: **cinnabar = you**, **cobalt = agent**, **gold = owed or fresh**, **verdigris = verdict**, **iron gall = chrome and ordinary text**.
Themes are asked to preserve those meanings rather than painting every control with an agent or attention color.
Shuttle doesn't enforce the convention; the bundled themes demonstrate it, with lighter pigment inks on dark paper.

## Example: a field notebook

Set `theme: laboratory-paper`, then add this `theme.css` beside the fiber:

```css
:scope {
  --ws-paper: #f4f6ed;
  --ws-hairline: #66735f;
}
[data-part='fiber-title']::before {
  content: 'FIELD NOTE / ';
  display: block;
  font: 11px/2 var(--ws-mono);
  letter-spacing: .12em;
  color: var(--ws-ink-muted);
}
:scope[data-part='folio'] {
  border-left: 2px solid var(--ws-hairline);
  padding-left: 12px;
}
@keyframes settle-ink {
  from { opacity: .6; }
  to { opacity: 1; }
}
[data-part='fiber-title'] {
  animation: settle-ink 280ms ease;
}
```

The flourish belongs to the fiber page and folio, not the HTML report.
The animation name is private to this channel, and reduced motion suppresses it.
