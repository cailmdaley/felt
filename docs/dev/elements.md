# The board's elements

The board draws three things in many places: a thread, a post, and a file.
Each is defined once, in `ui/src/board/elements/`, as one function with one stylesheet and its tests beside it.
A view composes these elements; it does not draw its own version of them.
Read this page before changing what the board draws.

## The thinking

- **One thing, one look.** A thread is the same object in the Desk, the constitution view and Channels, so it is drawn the same way in each. When a place needs it smaller, it uses a named density of the same element, never a second design.
- **Say what it is doing.** A slug alone tells the human nothing. Wherever a thread is listed, it says what it wants or last said, and when.
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

A box never grows wider than the row it sits in; its height holds.
`BOX` in `filePreview.ts` states the same numbers for code that reckons a row's height (the stream's margin), and a test reads the stylesheet to keep them equal.

## Elements

### Thread row — `threadRow.ts`

A constitution or thread as one line.

| Part | Content |
|---|---|
| State dot | `stateDot`: waiting (owed), working, quiet; busy while mid-turn |
| Slug | the last segment of its id, mono, in its line's colour where it has one |
| Role | its office, small caps, muted; left out when it equals the slug |
| Doing | what it wants of the human, else what it last said (`Workspace.said`), else its faint word (seat, resting, ↻) or its turn's word; one line, cut with an ellipsis |
| Age | when what the doing says was said, else when it was last active |

Densities: **line** (all parts, one line; the ringed count's list, the Desk's member lines, the constitution view's threads and ancestors) and **chip** (dot, slug and role; a thread's start station in Channels, where the margin's ring stands for the dot). Given an opener, clicking the row or its dot opens the thread's view; without one the row is drawn still, its dot no button, for a control that holds it (a menu item) to own the press. A view adds its own keys and roles to the row (the constitution view's tree).

The ringed count beside a channel's stream counts the threads running there now (each line not yet ended, a rest ending one as a close does), and its tooltip and its list, from the ring or anywhere on the bundle, name exactly that set as thread rows, what waits first.

### Post — `post.ts`

One line a thread addressed to the human.

| Part | Content |
|---|---|
| Head | the thread's slug in its line's colour, its role, the age; the kind word only for an ask, a close (for review, closed) or a block |
| Text | Markdown, at prose size |
| Files | a row of file previews below the text |
| Clear | ✓ at the head's right, on every post and file line, and `e` on the line in focus; a waiting post stops waiting (`clear:<uid>:<ms>`), any other line leaves the stream (`line:<ms>:<item id>`), each with an undo; a waiting ask or close is answered, not cleared |

A line that follows one from the same thread less than five minutes before it, and asks nothing, drops its head: its slug and role stay for assistive technology, its age shows at the right on hover, and its ✓ stays.

### File preview — `filePreview.ts`

A file as a card that unfolds in place to the whole file, with ‹ › between a post's files, Esc to fold and full screen.
Its density sets its box: **figure** (images, SVG plots), **page** (HTML, tapestries, decks), **card** (everything else, drawn from its name alone with nothing loaded) at the sizes above, and **thumbnail** for the globe and sheets.
A post's files sit in a row that wraps. The constitution view's one lead (its tapestry, else its newest file) is the exception: it stands at the view's full width, capped near 320px.
Only thumbnails swap a page's large embedded images for placeholders; a figure or page preview keeps them whole, which costs memory per mounted preview (when previews mount is the performance work's to decide).

## What stays the board's own

The margin's line (`tube.ts`) and its drawing, the Desk's layout, the Chronicle's lifelines and the globe's tiles are the board's own surfaces; they use these elements where they list a thread or show a file, and draw everything else themselves.
