# The board

The daemon serves the board at `http://127.0.0.1:4000/`. It is one page with
five full-page views behind a hotkey row, `1`–`5`. Everything on it is a view
over fibers the daemon already polls, plus the host-local
[ledgers](telemetry.md) — the board stores nothing of its own.

| Key | View | What it answers |
|---|---|---|
| `1` | **Desk** | What needs doing, and what is running right now |
| `2` | **Day** | Where today's hours went, fiber by fiber |
| `3` | **Week** | Which days had work in them |
| `4` | **Chronicle** | What a stretch of weeks was about |
| `5` | **Board** | What the work produced |

The first four run from the tightest window outward, so the strip reads as a
zoom: today, this week, the whole record. The fifth is not a time window at
all — it orders sent files by a lens rather than by the clock, which is why it
sits after the zoom rather than inside it.

One temporal cursor is shared across the four time views. Page Day back to
Tuesday, press `3`, and Week opens on the week containing Tuesday. `?view=day`
(or `week`, `chronicle`, `shelf`) deep-links a view.

!!! note "The tab named Board, and the board"
    Hotkey `5` is titled **Board** for the reader. Internally it is the
    *shelf* — the view id, the storage keys and the module names all say
    `shelf`, and `?view=shelf` is what deep-links it. This page uses "the
    board" for the whole surface at `:4000` and "the Board tab" for the fifth
    view.

## Desk — the kanban

Four surfaces: a **Timeline** ribbon of scheduled launches, the **Now** board
of cards that need something, a **Pinned** strip of perennial roles, and
**Resting**, where snoozed work waits.

Where a card lands is two independent decisions: which column it belongs to,
and which horizon it sits on.

### Column

The browser computes column membership with `classifyFiber`
(`ui/src/board/KanbanRules.ts`). That function decides membership alone, and it
evaluates in this order:

| Column | Condition |
|---|---|
| Cycles | tagged `cycle` — checked first, unconditionally |
| Tempered | `closed` + `tempered: true` |
| Composted | `closed` + `tempered: false` |
| Awaiting review | `closed`, `tempered` absent |
| In flight | live tmux worker with a shuttle block — liveness wins over everything below |
| Pinned | resting `kind: pinned` (`open` or `active`) |
| Scheduled | `active` + `kind: standing` — placed on the timeline at next launch |
| In flight | `active`, other kinds |
| Drafts | anything left, including `open` |

The cycle branch comes first on purpose. A [cycle](cycles.md) is an annotation
on the calendar rather than work, so it leaves classification before any
lifecycle question is asked — otherwise a stray "Autumn 2026" would sit in
Drafts forever.

Apart from that one tag, the classifier reads only `status`, `tempered`,
`kind`, and tmux liveness. Neither the daemon nor the board reads tags for
anything else.

### Horizon

Column says *which lane*; horizon says *desk or Resting*. It is computed by
`effectiveHorizon` from two frontmatter keys:

- `horizon: stashed` takes a card off the Now board and puts it in Resting.
  (The wire format and the API still say `stashed` everywhere; "Resting" is
  what the human is told, because that is what the surface means — deliberately
  paused work, not a bin of failures.)
- A `due:` day that is today or already past **overrides** a stored `stashed`
  and pulls the card back onto the desk. That override is what makes snooze a
  return ticket rather than a black hole. A *future* `due:` alone changes
  nothing: the card keeps its place and simply wears the date.

**Snooze** is the gesture that writes both. Drag a card and a drag horizon
appears under the tab strip — a slim row of upcoming days, plus a chip per
upcoming cycle. Drop on a day for `due:` + `horizon: stashed`; drop on a cycle
chip to land on that cycle's start (clamped to tomorrow if it is already
running); drop on today to put it back on the desk; drop into Resting to stash
it dateless.

### Gestures

Two gestures carry different meanings. **Drag-and-drop** advances the card's
state. **Modal buttons** give you another worker on the same run.

Drag-to-tempered acts by kind: on a standing role it accepts and re-arms, on a
pinned role it accepts and re-parks to the strip, on a oneshot it writes the
terminus. Only `accept` clears the outcome.

Beyond the columns the Desk offers a fiber and file viewer, Stash and Capture
dialogs, Attach, and a requeue/resume dialog with a directive box.

### Attach

Attach opens the worker's tmux session in kitty specifically — a non-kitty user
gets nothing from the button.

That is terminal lock-in, not platform lock-in: it drives kitty's
remote-control CLI, and kitty runs on Linux and macOS alike. The only
mac-specific part is the `osascript` call that raises the kitty window, and
that is already a no-op elsewhere. `felt shuttle attach <fiber>` reaches
any worker on any platform.

## Day, Week, Chronicle — where the time went

Three windows over the same substrate: the activity stream bucketed per minute,
joined to fibers through the session and commit ledgers. See
[Telemetry](telemetry.md) for what feeds them and what happens when a ledger is
absent.

- **Day** lays fibers out as lanes over a 6am→6am axis, with the rail zoomed to
  first-action→now rather than the full 24 hours.
- **Week** rows past days as ink rasters; today's row carries a gold seam and
  future rows are hollow.
- **Chronicle** draws fibers as multi-day lifelines across calendar days, under
  a strip of [cycle](cycles.md) bands.

**Two pigments, and no third.** Every raster spends exactly two: solid for
human steering, wash for agent work. There is no "attention called" state — an
idle nudge is not a state of the work, and an agent blocked on you reads as the
*gap* on a live lane, which no pigment improves on. Effort is counted in the
unit each side actually spends: human effort in messages (`you 14 · 9 back`),
agent effort in minutes. Hover any mark for the actual words, fetched as
transcript excerpts from `/api/v1/moment`.

Everything on these pages is joined through the ledgers. A minute or a commit
that does not resolve to a fiber the board carries is not drawn at all, so work
started outside Shuttle is invisible here — and nothing is ever attributed by
reading a `slug:` prefix out of a commit subject or a directory name.

## Board — what the work produced

Hotkey `5`. Every file a worker pushed with `SendUserFile` in the last 30 days,
laid out on a canvas as cards that render their own contents: the report
renders inside its frame, the plot draws, the page is the thing itself rather
than a link to it. A list of filenames is an index of work; a wall of rendered
pages is the work, and you find the one you want by recognising it.

- **A card is two layers.** The face — name, fiber, age, kind — is synchronous
  and is the card's resting state, never a skeleton. The body — the iframe, the
  image, the page — mounts when the card nears the viewport and is taken down
  again when the canvas carries more live bodies than it can afford.
- **Cards are handles, never factories.** Every gesture rearranges the canvas;
  nothing on a card makes another card. Drag the header to move it, the corner
  to resize, the ✶ to hold it in place, the body to make the frame live.
- **Nothing overlaps, except a pile** — one fiber's work gathered by the fiber
  lens.
- **Reading happens in the Reader.** The ↗ sends a file to one overlay window
  with its own tab strip, because Shuttle runs as a dock web-app where every
  `window.open` would otherwise become a separate window.

The feed is `/api/v1/sent-files/all` (with a `/composite` sibling that fans in
every host a hub aggregates — the **fleet**), which reads the host's event
stream. A host with no event stream shows an empty canvas — see
[Telemetry](telemetry.md).

## The board is optional, and built separately

The repo does not ship the bundle. Build it with:

```bash
cd ui && npm ci && npm run build
```

which writes `ui/dist`. A fresh clone builds it fine — no private checkout
needed (see [Sharp edges](installation.md#sharp-edges)). `make all` rebuilds
only the daemon escript.

Without the bundle the root URL 404s with a hint, and the API stays fully
usable. If you change any `/api/v1/*` route, rebuild the bundle — a stale
bundle against a changed route table fails silently as a 404.

A card that never appears at all is usually a dispatch question rather than a
board question — see [Diagnosing a missing card](lifecycle.md#diagnosing-a-missing-card).
