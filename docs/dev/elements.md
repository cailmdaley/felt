# The board's elements

The board draws three things in many places: a thread, a post, and a file, each with the same time.
Each is defined once, in `ui/src/board/elements/`, as one function with one stylesheet and its tests beside it.
A view composes these elements; it does not draw its own version of them.
Read this page before changing what the board draws.

## The thinking

- **One thing, one look.** A thread is the same object in the Desk, the constitution view and Channels, so it is drawn the same way in each. When a place needs it smaller, it uses a named density of the same element, never a second design.
- **Say what it is doing.** A slug alone tells the human nothing. Wherever a thread is listed, it says what it wants or last said, and when.
- **Show what moves.** A list shows the threads that wait on the human or are working; the rest are the orchestrators' to manage and sit behind a quiet fold.
- **One time.** Every time reads the same way, relative, in a face apart from the prose.
- **Mostly text, with pictures.** A stream of posts reads like a conversation. Files stay visual, but each preview has a capped size, and unfolding it in place gives the whole file.
- **Say it once.** The stream already shows that a line was posted or sent; the board only names what a line asks of the human (asks, for review, blocked).
- **Know a box's size before it loads.** Every preview's box is sized by CSS from its density and file kind alone, so the stream never jumps as content arrives, and when to fill it can be decided separately.

## Proportions

Channels follows Slack's proportions, which are tuned for a dense stream read all day.
Sourced from Slack: a file's inline image is drawn from a 360-pixel thumbnail, from a ladder of 64, 80, 360, 480, 720, 960 and 1024 (the `thumb_*` fields of Slack's file object); an attachment image is capped at 360 wide by 500 tall, and an attachment thumbnail is 75 by 75 (Slack's `MessageAttachment` reference).
The rest are the board's own choices, made to sit with those numbers:

| Measure | Value |
|---|---|
| Stream gutter (the line's margin, in Slack's avatar column) | as drawn by `tube.ts` |
| Post text | `--type-prose` serif, `--leading-prose` |
| Gap between posts from different threads | 8px; within a group, 2px |
| A group | consecutive lines from one thread less than 5 minutes apart |
| Image or figure preview | a box 480 by 360, the picture contained in it with its aspect kept |
| Page preview (HTML, tapestry, deck) | 480 by 270 |
| File card (Markdown, PDF, code, audio, anything without a picture) | 360 by 56: kind glyph, name, age |
| Thumbnail (globe tiles, sheets) | 176 by 116 |

A box never grows wider than the row it sits in: narrower, a figure or a page keeps its proportions and a card its height.
`BOX` and `PREVIEW_GAP` in `filePreview.ts` state the same numbers for code that reckons a row's height (the stream's margin), and a test reads the stylesheet to keep them equal; `previewsHeight` wraps a post's boxes in the stream's width as the row does, and stands them in one line while that width is not known; a close's row counts a tapestry only when it shows one.

## Elements

### Thread row — `threadRow.ts`

A constitution or thread as one line.

| Part | Content |
|---|---|
| State dot | `stateDot`: waiting (owed), working, quiet; busy while mid-turn |
| Slug | the last segment of its id, mono, in its line's colour where it has one |
| Role | its office, small caps, muted; left out when it equals the slug |
| Doing | what it wants of the human; else the newer of what it last said (`Workspace.said`) and its outcome (timed by its file's last write); else its faint word (seat, resting, ↻) when quiet, or its turn's word; one line, cut with an ellipsis, the whole of it in the row's tooltip |
| Age | when what the doing says was said; with nothing said, when a working thread launched, else when it last moved; in the elements' time (below) |

Densities: **line** (all parts, one line; the ringed count's list, the Desk's member lines, the constitution view's threads and ancestors) and **chip** (dot, slug and role; a thread's start station in Channels, where the margin's ring stands for the dot). Given an opener, clicking the row or its dot opens the thread's view; without one the row is drawn still, its dot no button, for a control that holds it (a menu item) to own the press. A view adds its own keys and roles to the row (the constitution view's tree).

**Which threads a list shows.** A list of a family's threads shows only what moves: the threads that wait on the human or are working (`attentionOf` in `attention.ts`: `waiting` or `working`), what waits first, each followed by every thread below it that waits on the human (so a quiet thread with a wait below it stands too). Everything else is quiet (seats, drafts, rest, standing threads between runs, held launches, closes its orchestrator reviews) and sits behind one "N quiet" fold that opens to the same rows. The constitution view's thread list follows this rule; the Desk's family card lists only the members that wait, and the ringed count's list names the threads running now.

The ringed count beside a channel's stream counts the threads running there now (each life not yet ended, a rest ending one as a close does), though the human has cleared everything one said; and its tooltip and its list, from the ring or anywhere on the bundle, name exactly that set as thread rows, what waits first, the list drawn from the threads as they stand when it opens. A worker the stream does not hold (launched before the board's reach and with nothing in it since) is not counted.

### Post — `post.ts`

One line a thread addressed to the human.

| Part | Content |
|---|---|
| Head | the thread's slug in its line's colour, its role, the age; the kind word only for an ask, a close (for review, closed) or a block |
| Text | Markdown, at prose size |
| Files | a row of file previews below the text; a fiber's newest close in the stream leads them with its tapestry |
| Clear | ✓ at the head's right, on every post and file line, and `e` on the line in focus; one press takes the line from the stream (`line:<ms>:<id>`, one record for each line it takes: a post by its id, a file item by each of its sends, so a send it did not name still shows and the item goes once none is left) and, for a waiting post, stops it waiting too (`clear:<uid>:<ms>`), with one undo that restores both; a waiting ask or close is answered, not cleared |

A line that follows one from the same thread less than five minutes before it, and asks nothing, drops its head: its slug and role stay for assistive technology, its age shows at the right on hover, and its ✓ stays.

### Time — `time.ts`

Every time a thread row, a post's head, a file card or the constitution view's head draws is `timeEl`: relative in one grammar, `now` under a minute, then `12m ago`, `5h ago` under a day, then `3d ago`; the instant in full (`30 Oct 2026 03:31`) in its tooltip; set in `--font-mono` at `--type-meta`, muted, with tabular numerals, not the serif around it.
A row's time is the time of what its doing says; a working thread that has said nothing is timed from its launch.
The grammar's arithmetic (`relativeAge`) lives in `civilDay.ts` with every other clock, and `retime` brings a drawn stream's times up to date in place.

### File preview — `filePreview.ts`

A file as a card that unfolds in place to the whole file, with ‹ › between a post's files, Esc to fold and full screen.
Its density sets its box: **figure** (images, SVG plots), **page** (HTML, tapestries, decks), **card** (everything else, drawn from its name alone with nothing loaded) at the sizes above, and **thumbnail** for the globe and sheets.
A post's files sit in a row that wraps. The constitution view's one lead (its tapestry, else its newest file) is the exception: it stands at the view's full width, capped near 320px.
Only thumbnails swap a page's large embedded images for placeholders; a figure or page preview keeps them whole, which costs memory per mounted preview (when previews mount is the performance work's to decide).

## What stays the board's own

The margin's line (`tube.ts`) and its drawing, the Desk's layout, the Chronicle's lifelines and the globe's tiles are the board's own surfaces; they use these elements where they list a thread or show a file, and draw everything else themselves.
