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
- **Mostly text, with pictures.** A stream of posts reads like a conversation. Files stay visual, but each preview has a capped size; the whole file is one place, the reader (a constitution's view unfolds its own lead in place).
- **Say it once.** The stream already shows that a line was posted or sent; the board only names what a line asks of the human (asks, for review, blocked).
- **Know a box's size before it loads.** Every preview's box is sized by CSS from its density and file kind alone, so the stream never jumps as content arrives, and when to fill it can be decided separately.

## Proportions

Channels follows Slack's proportions, which are tuned for a dense stream read all day.
Sourced from Slack: a file's inline image is its `thumb_360`, whose longest side is at most 360 pixels, from a ladder of 64, 80, 360, 480, 720, 960 and 1024 (Slack's file object reference); a legacy attachment's image is resized to at most 360 wide or 500 tall, and its thumbnail's longest side to 75 (Slack's legacy secondary attachments reference).
The rest are the board's own choices, made to sit with those numbers:

| Measure | Value |
|---|---|
| Stream margin (the fine ink, in Slack's avatar column) | 56px on a desktop, 50px below a 560px stream, its left 16px a gutter for the strand's count that no ink enters; laid by `tube.ts`, drawn by `margin.ts` |
| Post text | `--type-prose` serif, `--leading-prose` |
| Gap between posts from different threads | 8px; within a group, 2px |
| A group | consecutive lines from one thread less than 5 minutes apart |
| Image or figure preview | the post's width, a third of the screen high and 300px at most, the picture whole in it with its aspect kept |
| Page preview (HTML, tapestry, deck) | the same box, showing the top of the page at its real size |
| File card (Markdown, PDF, code, audio, anything without a picture) | the post's width by 56: kind glyph, name, age |
| File row (a list of files) | the card's face in one line, as wide as its list up to 420; its caption a second line, cut at two |
| Constitution view's thread list | at most 760 wide, the reading measure, so a row's age stands near its words |
| A thread row's age | at least 16px from its doing |
| A menu (a list of files, of threads) | 16px clear of the window's edge, so it stays on the board's sheet |
| Thumbnail (sheets) | 176 by 116 |

A post's previews stand each on a line of its own, as wide as the post, so a box's size never depends on its neighbours.
`foldPx`, `CARD_PX` and `PREVIEW_GAP` in `filePreview.ts` state the same numbers for code that reckons a row's height (the stream's margin), and a test reads the stylesheet to keep them equal; `previewsHeight` sums a post's boxes; a close's row counts its tapestry's box (a page's for the channel's newest close, a card's for the others) unless the last look at its constitution found none; a look that cannot tell (a daemon that did not answer) leaves the slot as it stood.

## Elements

### Thread row — `threadRow.ts`

A constitution or thread as one line.

| Part | Content |
|---|---|
| State dot | `stateDot`: waiting (owed), working, quiet; busy while mid-turn |
| Slug | the last segment of its id, mono, in its line's colour where it has one |
| Role | its office, small caps, muted, in a chip only and left out when it equals the slug; on a line it is in the row's tooltip |
| Doing | what it wants of the human; else what it last said (`Workspace.said`), when its live worker said it since its launch (`dispatchedAt`); else the newer of what it last said and its outcome; else its faint word (seat, resting, ↻) when quiet, or its turn's word; one line, cut with an ellipsis, the whole of it in the row's tooltip |
| Age | how long ago what the doing says was said (`24m`, `4h`, `4d`, without "ago"); with nothing said, since a working thread launched, else since it last moved |

An outcome's age is its file's last write (`modifiedAt`), and a lifecycle write (a launch, a handoff, a rest) moves it without a word of the outcome changing; so a post from the current run outranks the outcome whatever their ages say.

Densities: **line** (dot, slug, doing and age on one line; the strand's count's list, the Desk's member lines, the constitution view's threads and ancestors) and **chip** (dot, slug and role; a thread's start station in Channels, where the margin's cell body stands for the dot). In a list marked `thread-rows` (the constitution view's threads) every doing begins on one column: the dot and the slug share a first column as wide as the longest slug with its indent, at most 45% of the list, past which a slug wraps; the ages end on a column of their own. Given an opener, clicking the row or its dot opens the thread's view; without one the row is drawn still, its dot no button, for a control that holds it (a menu item) to own the press. A view adds its own keys and roles to the row (the constitution view's tree).

**Which threads a list shows.** A list of a family's threads shows only what moves: the threads that wait on the human or are working (`attentionOf` in `attention.ts`: `waiting` or `working`), what waits first, each followed by every thread below it that waits on the human (so a quiet thread with a wait below it stands too); a thread with a worker anywhere below it ranks and stands with what works, from the moment that worker starts, and when it is itself quiet the working threads below it are drawn beneath it too, to say why it stands. Everything else is quiet (seats, drafts, rest, standing threads between runs, held launches, closes its orchestrator reviews) and sits behind one "N quiet" fold that opens to the same rows. The constitution view's thread list follows this rule; the Desk's family card is headed by its top-level, and while the top-level waits the head is its own waiting line (what it wants, its age, a post's ✓, its undo window); under the head it lists every other member that moves, flat, whatever its depth: those that wait, the newest wait first, then those with a live worker, mid-turn before idle and then by latest activity, so no line repeats the head's constitution and no live worker goes unnamed; the list from the strand's count names the threads running now.

**The rail's counts.** A channel's rail entry carries at most one number, and each kind is drawn so the two cannot be read alike. While something in the channel waits on the human it is a solid gold disc: how many of its live members wait (`attentionOf` is `waiting`, which is `wantOf` in `attention.ts`), and the stream draws exactly one waiting line for each of them, the board's line when it is in reach and otherwise a line of its own, so every one can be scrolled to; opening the channel does not change it, and each line leaves it as it is cleared, answered or decided. Otherwise it is an ink numeral in a ring: how many stream lines (not stations) arrived after this device's seen mark (`shuttle.channels.seen:<key>` in localStorage), which opening the channel moves to now; a channel this device has never seen is marked when it first appears in the rail, so it counts what arrives from then on, not everything in the board's reach.

The strand's count beside a channel's stream (a small numeral in the margin's ink, standing still at the top of what is in sight in the gutter at the margin's left edge) numbers the threads running there now: those with a live worker (`hasLiveWorker`), each once, whatever the stream holds of their lives, so a standing thread between runs or a draft is not counted and a worker still live after its close is. Its tooltip and its list, from the count or anywhere on the strand, name exactly that set as thread rows, what waits first, the list drawn from the threads as they stand when it opens.

### Post — `post.ts`

One line a thread addressed to the human.

| Part | Content |
|---|---|
| Head | the thread's slug in its line's colour, its role, the age; the kind word only for an ask, a close (for review, closed) or a block |
| Text | Markdown, at prose size |
| Files | a row of file previews below the text; a fiber's newest close in the stream leads them with its tapestry: the channel's newest close with the tapestry's top in a page's box, every other a one-line card, and a constitution with no tapestry with nothing |
| Clear | ✓ at the head's right, on every post, question and file line, and `e` on the line in focus: one press takes the line from the stream and, for a waiting post, stops it waiting too, with one undo for both; a worker's waiting question (`shuttle.ask`) is instead withdrawn on its owner (`/lifecycle` `ask-clear`) and its line taken once that lands, with no undo, since nothing writes a question back; a close that waits is given its verdict and a blocked turn its fix, not a ✓ |

A clear is remembered as one `line:<ms>:<id>` record per line it took (a post by its id, a file item by each send it showed, so a send it did not show still appears) and, for a waiting post, `clear:<uid>:<ms>`; records are written four at a time, and the undo writes back only what was written. A line cleared again while its last clear, or that clear's undo, is still being written waits for those writes, so it sees whether its post waits.

A line that follows one from the same thread less than five minutes before it, and asks nothing, drops its head: its slug and role stay for assistive technology, its age shows at the right on hover, and its ✓ stays.

### Time — `time.ts`

Every age the board draws is `timeEl` (a thread row, a post's head, a file card, the constitution view's head, the reader's "Last changed" and "sent", a transcript search hit, the Dock's live worker): relative in one grammar, `now` under a minute, then `12m ago`, `5h ago` under a day, then `3d ago` (a thread row and the constitution view's head drop the "ago": `12m`, `5h`, `3d`); the instant in full (`30 Oct 2026 03:31`) in its tooltip; set in `--font-mono` at `--type-meta`, muted, with tabular numerals, not the serif around it.
A row's time is the time of what its doing says; a working thread that has said nothing is timed from its launch.
A clock that names an instant rather than an age stays a clock: the session strip's clock, its cache's warm-until, and a finished run's `14:02 → 15:10 · 1h 8m` in the Dock, which is set in the time's face.
The grammar's arithmetic (`relativeAge`) lives in `civilDay.ts` with every other clock, and `retime` brings a drawn stream's times up to date in place.

### File preview — `filePreview.ts`

A file as a card. In a constitution's view it unfolds in place to the whole file, with ‹ i / n › between the files, Esc to fold and full screen; in a channel's post (`open`) pressing it opens the file in the reader instead.
A link in an unfolded page goes where it goes in the reader (`Workspace.openLink`): a board route opens that fiber, and a file beside the page opens in the reader as one of the constitution's pages.
Its density sets its box: **figure** (images, SVG plots), **page** (HTML, tapestries, decks), **card** (everything else, drawn from its name alone with nothing loaded) at the sizes above.
A fifth density, **row** (`fileRow`), lists a file rather than previewing it: the card's kind glyph, name and age in one line, and its caption under them (why it was sent: its newest send's caption, else the latest an earlier send of it gave, the same in every list and in the reader); unread, its glyph takes the fresh ink, and the file being read is underlined.

**A count opens its list.** Several files can be stepped through or read as a list (`openFileList`): a modal menu of file rows, newest first whatever order it is given, each opening its file; a press outside only closes it. An open list follows its files: a send that arrives while it hangs takes its row, and the count it hangs from stays the same button, its number updated in place; a channel's head keeps it open until the board moves to another channel, which closes it. The list opens from every count of files: a constitution's sent-files count among its pages (the list is the files that count counts, and a row opens the file in the reader, or in the constitution view unfolds it there), the `i / n` in an unfolded file's bar (a row unfolds that file in place), the `i / n` on a sent file's page in the reader, and the phone's top-bar files button (a row opens the file in the reader).
A post's files sit in a row that wraps. The constitution view's one lead (its tapestry, else its newest file) is the exception: it stands at the view's full width, capped near 320px.
Only thumbnails swap a page's large embedded images for placeholders; a figure or page preview keeps them whole, which costs memory per mounted preview (when previews mount is the performance work's to decide).

## What stays the board's own

The margin's fine ink (`tube.ts` lays it, `ink.ts` holds its noise, ribbon and non-crossing field, `margin.ts` draws it; the constitution view's lines are `workspace/familyInk.ts`) and the Desk's layout are the board's own surfaces; they use these elements where they list a thread or show a file, and draw everything else themselves.
