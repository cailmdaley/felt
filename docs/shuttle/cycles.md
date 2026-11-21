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

## Degenerate spans

Both dates are optional, and each omission means something:

| Written | Span |
|---|---|
| `start` + `due` | the span as written |
| `due`, no `start` | a one-day span on the due day — a cycle that names only its end is a deadline, and a deadline is a day |
| `start`, no `due` | open-ended: runs from `start` to today, and grows with the calendar until someone writes a `due:` |
| neither | no span; nothing to draw |

## A cycle is never on the desk

The board's read model checks the `cycle` tag first and unconditionally, before
it reads any column. Its `status`, its `due:`, even a `shuttle:` block someone
pasted onto it, cannot put it in a Desk column — a cycle routes straight to the
`cycles` surface. Otherwise an open cycle would read as a draft and a finished
one as a card that had drifted past its date, and one stray "Autumn 2026" among
the drafts teaches you to distrust the Desk.

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

## Working with them

A cycle is ordinary frontmatter (`tags: [cycle]`, `start:`, `due:`) written directly in a fiber.
