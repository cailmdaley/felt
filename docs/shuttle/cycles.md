# Cycles and eras

A **cycle** is a named span of calendar time — a sprint, a chapter, a season.
It is a fiber like any other, and it is the one row on the board that is not
work.

```yaml
---
name: Autumn 2026
tags: [cycle]
start: 2026-09-01
due: 2026-11-30
---

Get the shear pipeline to a state someone else could run.
```

Three things make it a cycle:

- **the `cycle` tag** — matched case-insensitively on a trimmed tag, so `Cycle`
  and ` cycle ` are the same declaration;
- **`start:` and `due:`** as civil days, the span's opening and closing edges;
- **the body's first paragraph**, read as the *intention* — what this stretch of
  time is for.

The [Chronicle](board.md#day-week-chronicle-where-the-time-went) draws it as a
named band over the day grid.

## Degenerate spans

Both dates are optional, and each omission means something:

| Written | Span |
|---|---|
| `start` + `due` | the span as written |
| `due`, no `start` | a one-day span on the due day — a cycle that names only its end is a deadline, and a deadline is a day |
| `start`, no `due` | open-ended: runs from `start` to today, and grows with the calendar until someone writes a `due:` |
| neither | no span; nothing to draw |

## A cycle is never on the desk

`classifyFiber` checks the `cycle` tag first and unconditionally, before any
lifecycle question. Its `status`, its `due:`, even a `shuttle:` block someone
pasted onto it, cannot put it in a Desk column — a cycle routes straight to the
`cycles` surface. Otherwise an open cycle would read as a draft and a finished
one as a card that had drifted past its date, and one stray "Autumn 2026" in
Drafts teaches you to distrust the column.

## Membership is derived, never assigned

A fiber is never *put in* a cycle. There is no field to write, nothing to keep
in sync, and no way for a cycle's roster to disagree with the calendar. The
board asks three questions in order, and the first that answers is the reason:

| Rung | A fiber belongs when |
|---|---|
| `due` | its `due:` falls inside the span — the plain reading of "this is due this sprint" |
| `in-flight` | it is being worked *right now* **and** the span covers today. Work in flight belongs to the chapter you are living in; it says nothing about a chapter that has not opened |
| `worked` | it was worked on some day inside the span |

Both edges of the span are inclusive.

The `worked` rung is the real historical rule, and it is the one the Desk cannot
answer: activity days live in the [temporal feeds](telemetry.md), which the Desk
does not fetch. On the Desk the rung is simply skipped; the Chronicle, which has
the activity, uses it.

## Working with them

Cycles are a board gesture. There is no `felt shuttle cycle` verb — a cycle is
ordinary frontmatter (`tags`, `start:`, `due:`), so nothing stops you writing
one in the file, and everything below is the board's shorthand for that.

- **Draw one** by dragging across days in the Chronicle's cycle strip, then
  naming the span.
- **Speak one** with `+`: dictate the intention, and the cycle starts today and
  runs open-ended.
- **Rename** by double-clicking the name; **respan** by dragging an edge.
- **Click the band** to open the cycle's own page — the board calls this the
  **era face**: span, intention, derived figures, and *the look back*, a
  memoir composed from the commit trail. **Inscribe this review** writes that
  memoir back into the cycle fiber's body.
- **Snooze into one**: while dragging a card, the drag horizon offers a chip per
  upcoming cycle. Dropping on it sets `due:` to that cycle's start day, clamped
  to tomorrow when the cycle is already running — "rest until tomorrow, later
  this cycle."

!!! note "The look back reads the commit ledger"
    The era memoir is composed from `~/.shuttle/commits.jsonl`, which the felt
    plugin's `PostToolUse` hook writes. Commits made outside an agent session
    leave no trail, so an era worked entirely by hand reads *the era left no
    trail* — the band still draws and the membership still resolves.
    See [Telemetry and the ledgers](telemetry.md#the-commit-ledger).
