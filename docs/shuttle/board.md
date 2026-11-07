# The board

The daemon serves the board at `http://127.0.0.1:4000/`. It is one page with
four full-page views behind a hotkey row, `1`–`4`, and a settings sheet on
`⌘,`. Everything on it is a view over fibers the daemon already polls, plus
the host-local [ledgers](telemetry.md) — the board stores nothing of its own.

| Key | View | What it answers |
|---|---|---|
| `1` | **Desk** | What needs doing, and what is running right now |
| `2` | **Chronicle** | What a stretch of weeks was about |
| `3` | **Board** | What the work produced |
| `4` | **Globe** | Everything at once, as one place to move through |
| `⌘,` | **Settings** | Every operator file, on any host in the fleet |

`#/desk`, `#/chronicle`, `#/board` and `#/globe` deep-link the views.
A constitution uses `#/board/<uid>@<owner>/<document>`; browser Back returns to the view you opened it from.

## Desk — the kanban

The Desk shows **Drafts**, **In flight**, **Awaiting review**, **Resting** and **Roles**, in that order.
Resting holds paused and snoozed work, hubs you start by hand, and standing constitutions between runs.
Roles holds a launcher chip for every seat at rest (a constitution with `shuttle.seat: true` and a role), in name order and never paged.
Click a section heading to fold or unfold it; Drafts starts folded and the others open, and each fold is remembered in this browser.

![The Desk with fictional workshop tasks: lunch options and speaker bios in Drafts, the participant guide and venue access In flight, and the programme and venue decision Awaiting review.](../assets/board-desk.jpg)

*The cards use fictional workshop data.
Each card shows its fiber's `outcome`, so the venue decision is readable beside the guide that uses it.*

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
| Discarded | `closed` + `tempered: false` |
| Awaiting review | `closed`, `tempered` absent |
| In flight | live tmux worker with a shuttle block — liveness wins over everything below |
| Roles | `shuttle.seat: true` with a role, and at rest: not `active`, or `active` + `kind: standing` between runs |
| Scheduled | `active` + `kind: standing` — drawn in Resting, wearing its next launch |
| In flight | `active` oneshot |
| Drafts | anything left, including `open` |

In flight draws two bands, decided by whose move it is. **Your turn** holds
live workers whose move is yours: questions first and drawn heavier (an
outstanding `shuttle ask`, a harness prompt, or a blocked launch), then workers
idle at their prompt with nothing they started still running. **Working** holds
the rest, including a worker idle over its own background shells or
subagents.
The worker whose conversation you are following also stays in Working, even when it finishes a reply or has a question, and does not count as needing you.
The board uses the voice target, which also follows Rex, for this distinction.
The daemon reads those live children from each harness: Claude
Code's `background_tasks` on `stop`, Codex's `spawn_agent` calls and
`subagent_stop` events, and Codex terminal sessions that name
the worker as `parentThreadId`. A harness that reports none reads as your
turn when idle. Cards keep creation order within each tier, so a card moves
only when it crosses the seam or a question is raised or answered.

One derivation, the card's *turn*, decides the band, the order, and the
worker pill on every surface, so a card can never sit in Your turn with a pill
that says otherwise. The pill's word names why it is (or isn't) your move:

| Pill | Band | Meaning | Age counts from |
|---|---|---|---|
| **question** | Your turn | The worker needs an answer: an outstanding `shuttle ask` (the worker may still be working, and its dot breathes), or the harness stopped on a prompt. Its dot is red, the Desk's only red. | the ask, or the prompt's event |
| **idle** | Your turn | The worker ended its turn with nothing running under it. | the last event |
| **blocked** | Your turn | Rare: the turn could not start (launch error), or the session could not be attributed. Drawn quietly, as a hollow dot. | the last event |
| **working** | Working | Mid-turn, or idle over background work it started. | the last event, once it has been silent ten minutes |
| **starting** | Working | Launched in the last five minutes, or its session still being identified; no hook event yet. | the launch |
| **no signal** | Working | Live past its start, but the daemon holds no hook event for it; or its owning daemon is unreachable, so its last report is frozen and no evidence of a turn (an outstanding ask still reads **question**). | the launch, or the owner's last successful poll |

The dot's breathing says whether the worker is busy, independently of whose
move it is. The pill is also the control that opens the conversation.

The cycle branch comes first on purpose. A [cycle](cycles.md) is an annotation
on the calendar rather than work, so it leaves classification before any
lifecycle question is asked — otherwise a stray "Autumn 2026" would sit in
Drafts forever.

Apart from that one tag, the classifier reads only `status`, `tempered`,
`kind`, and tmux liveness. Neither the daemon nor the board reads tags for
anything else.

### A family's threads

A family's root heads its threads in each section of work they stand in (Your turn, Working, Awaiting review), its own mark drawn faintly where its state is another.
If the root is not in the section and only one thread is, that thread stands alone as its slug path from the root, with its own dot and age.
Otherwise each thread hangs under its nearest shown ancestor, the threads between left out and named in its slug path from there.
Drafts, Resting and the Roles list only a family's root, whose own threads in that state fold beneath it; a thread's draft is reached from its family. Every Desk row and thread is named by its fiber slug, as Rex's sidebar shows them, cut short by an ellipsis; the full name is the tooltip and the title of the page it opens. Archived threads are not on the Desk.

The work sections are dense mono lines, a family's root and its threads at the same size, the root in bold, grouped by indentation alone.
The dot is the row's own state; the count includes the root when it is in the section and all its threads in that state, red when one has a question.
The count's caret folds the threads; every thread holding threads of its own carries a caret too.
Family folds in Your turn and Awaiting review start open, and the others start folded; each is remembered in this browser.

A click on a thread opens its page, as a click on a row does, and `j` / `k`
walk the threads that are showing as well as the rows.

### Horizon

Column says *which lane*; horizon says *desk or Resting*. It is computed by
`effectiveHorizon` from two frontmatter keys:

- `horizon: stashed` takes a card off the Now board and puts it in Resting.
  Dragging a card there from In flight or Awaiting review stops its worker and
  parks it with no verdict — the board's spelling of `shuttle rest`.
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
state.
**The fiber page's controls** give you another worker on the same run.

Drag-to-tempered acts by kind: on a standing constitution it accepts and
re-arms, on a oneshot it writes the terminus. The outcome stays: the last run's digest is the card's headline until
the next run writes its own.

Opening a Desk card enters its constitution's documents.
The constitution's band (see [the reader](#board--what-the-work-produced)) carries its worker's line and Listen; the folded settings hold the next launch's agent, effort, surface and kind, plus the card's due day and parent.
The Desk also offers Stash and Capture dialogs and Attach.

<a id="attach"></a>
### Open a worker

Worker pills on Desk cards and the fiber page open the worker's conversation.
The constitution header also offers Console on every layout, including phones, whenever a destination is available.
Tap to open; long-press or right-click Console or a pill to choose a destination.
A choice between alternatives is remembered; opening a sole destination leaves the preference unchanged.
Fiber controls remain inline.
For terminal workers, the board can open Kitty; `shuttle attach <fiber>` works from other terminals too.
Claude sessions with Remote Control can open in the browser or Claude app, using your browser's preference in Settings.
Codex workers open in their terminal session; remote access depends on the host terminal backend.
See [Opening conversations](conversations.md) for the choices, prerequisites, and quick-access terminal setup.

### Desk keyboard

Bare keys act on the Desk when focus is outside an editable field.
`j` / `↓` and `k` / `↑` select the next or previous visible row across sections, skipping folded sections and stopping at the ends.
`g` and `G` select the first or last row in the current section.
`l` / `→` or `Enter` / `o` opens the constitution, `h` / `←` or `Esc` clears selection, `/` opens Find, and `?` shows keyboard help.

## Chronicle — where the time went

The activity stream bucketed per minute, joined to fibers through the session
and commit ledgers. See [Telemetry](telemetry.md) for what feeds it and what
happens when a ledger is absent.

Chronicle draws fibers as multi-day lifelines across calendar days, under a
strip of [cycle](cycles.md) bands. Activity is inked on each lifeline, one mark
per civil day; ahead of today a row carries only hollow marks for what is due
and what is armed.

![Chronicle with the same fictional workshop tasks: venue research, programme review, access checks, and guide preparation across September and October, under the Plan a small workshop cycle.](../assets/board-chronicle.jpg)

*No fill, just marks on a line per fiber, so months of fibers stack without
drowning each other. The era strip is the same [cycle](cycles.md) data that
fences the Desk's Cycles column.*

Everything on the page is joined through the ledgers. A minute or a commit
that does not resolve to a fiber the board carries is not drawn at all, so work
started outside shuttle is invisible here — and nothing is ever attributed by
reading a `slug:` prefix out of a commit subject or a directory name.

**The record is fetched on demand.** The Desk's cards refresh every 15 s, and
Chronicle redraws its rows from them, but its temporal feeds — activity, the
session ledger, the commit ledger — are fetched when the view opens, again at
most every five minutes while it stays open, and whenever you ask with the
refresh control. Days already past are fetched once per open; scrolling back
fetches only the days newly in view. Nothing on the board asks for temporal
data while Chronicle is closed.

## Board — what the work produced

Hotkey `3` opens a contact sheet of constitutions with documents sent in the last 30 days.
A ribbon shows the twelve latest documents across the fleet.
Beneath it, **Read lately** names the constitutions opened in the reader this session, most recent first; each opens in the reader.
Below it, each fiber has a folio with a live thumbnail, name, outcome, document count and host marks.
Recent work, Projects and Hosts regroup the sheet; Find filters names, paths and filenames.
Thumbnails load near the viewport under a shared budget and cannot run scripts.
Confirmed missing fibers' documents gather under **Unfiled** on their byte-owning host; an unreachable owner does not count as a missing fiber.

Opening a folio or receipt enters the reader: one selected page, its neighbours waiting hidden, and no column beside it.
The reader is one frame: beneath the board's bar, the selected page fills the window, with its header line on top and the document below it. The header line holds back, the page's name, its arrival, the sent files toggle, Expand and the document menu.
The sent files toggle appears at every width when the constitution has sent files, on the phone in the top bar, and its first bullet swells while one is unread; it opens the sheet of sent files, as the document menu's Sent files does.
In the reader, as on the Desk and Chronicle, the board bar's Find hangs a list of constitutions beneath itself, matching names, paths, filenames and transcripts. On the phone the title opens a switcher of constitutions instead.
The fiber page anchors its body, embedded files, opened body links and sent documents.
Repeated sends of the same owner/path are one page with multiple receipts.
Selection, constitution changes, and metadata polls preserve retained document instances and reading position.
The board renders no conversation. Conversation lives in Rex, on the desktop and on the phone; the board keeps a constitution's threads, its tapestry and documents, its sent files, its change reader and its lifecycle.

**A click never opens Rex.** A click on a thread, on a Desk card, a constitution's page or the Globe, moves Rex quietly to its live worker's window, behind the board, and voice follows the thread. A thread with no live worker, a stopped one or one with only a past session, leaves Rex as it is: a click starts no program, creates no session and resumes nothing, so clicking around leaves no trail of terminals. Every surface calls one function for this, `Workspace.reach`, which posts `select_only` to `POST /api/v1/attach` and rings the thread only once the daemon says Rex moved. Opening is an explicit act: `c` (or `.`) opens or creates the conversation's window, reopens a past session, and brings Rex forward. Rex keeps its view to what is in focus, plus the workers asking you something and those running a turn: a window you moved away from leaves it after two minutes while its worker runs on, and a click or `c` brings it back. Workers on other hosts follow the same rule. On a phone a click moves nothing.
Every constitution past its draft opens on [its family's page](#a-constitutions-page), at its own row, unfolded, whatever level it sits at; a lone constitution's page is that constitution alone. A draft opens on its fiber page. On a family's page a thread's tapestry, constitution and sent files unfold in place under its row; a link inside one of them opens on the stage, and Back returns to the page as it stood.
One band, the console, stays above every page of a fiber on the Desk's lifecycle. Its head is one row: the constitution's name, then Listen, the lifecycle verbs (Close for review, Rest, Temper, Discard, by state), and the Constitution, Settings and × icons. Every control is an icon of one size and weight, named in its tooltip with its key (Close for review `a`, Rest `s`, Temper `t`, Discard `x`); × returns to Desk and never changes the fiber. No word says the constitution's state: its colour does. The console has no button to open the conversation, since following already brings Rex to it and `c` opens it. Beside the name it shows the session's context size, tinted from verdigris toward red as it fills the window, and Claude's estimated prompt cache as a dot that drains as the entry ages and turns into a red ring once cold; hover either for the numbers. Resume's tooltip says until when the cache is warm, and Settings adds the share of recent context read from the cache. These facts come from the session's transcript on its host, so they hold with no worker running. On a phone the top bar names the page and the head is one row of verbs that scrolls sideways.
Under the head, the worker's line acts on the highlighted thread's worker on a family's page, or the page's constitution otherwise, which its placeholder names: a one-line message field, then Resume (Send when the worker is live, Start when it never ran) and New session. Enter takes the first verb. The text is the opening message of the resumed or new session or, for a live worker, is typed into its conversation; an empty line resumes or starts with nothing said, and Send waits for words. New session over a live worker asks before cutting it. After a send the line says Sent, Resumed or Started, and shows no transcript; a start opens the worker on the desktop.
Listen is the mic: one toggle with a ▾ menu beside it, and it does one thing at a time. **Following**, which pressing the mic turns on, sends your words to whatever card you are looking at. **A meeting**, started from the ▾ menu with *Record a meeting on <card>*, records mic and system audio and sends every word to that one card wherever you look; starting one, from anywhere, turns following off. Once either is on, the mic (a red dot for a meeting) mutes and unmutes: muted, it is struck through and keeps the mode while sending nothing. **Stop listening**, in the ▾ menu, turns the mic off, with nothing taking over. Beside the mic one word says where spoken words go: the card's slug, after a dot for a meeting; it is empty when the mic is off. A failure turns the mic red without hiding the mode, and the ▾ menu says what failed. On a phone, Listen records on the phone, joined to the card; a phone recording cannot be muted, so pressing the mic opens the menu. The ▾ menu also opens the transcript file and sets the quiet seconds before words are sent; no transcript shows on the band. Quiet sends what you said, and "send" at the end sends it at once. Saying a name ("Claude") never cuts you off; it lets words reach a card with no live worker, starting its worker with them. Otherwise words for such a card go nowhere, and the transcript keeps them either way. `POST /api/v1/voice/toggle` and `/voice/discard` do the same from anywhere, such as a global hotkey.
The fiber header shows status alone. Agent, effort, cadence, host and project directory belong to the folded settings line; the band's worker line is only its conversation action.
Document header lines show the title and arrival history, omit the agent, and name a host only for a document owned elsewhere. The fiber label shows its genuine last-change time.
Media, PDF and unsupported viewers add no title or provenance block inside the page. Audio/video use native transport controls; retained media pauses when receded or parked.
The ‹ button, browser Back and the phone's right swipe follow the pages you visited, across constitutions and linked files.
The back control names the constitution across channels, or the page within the same channel: Constitution or the file's name.
A direct address without a visited page behind it returns to its origin view (Desk, Chronicle, Board or Globe).
Reloads retain this path in browser history.
Ancestry links and `b` go up the thread tree separately.
Opening a different page adds a history stop, including a link to a page just visited.
Reselecting the same page leaves history untouched.
Stepping between constitutions with j/k or J/K replaces the current visit.
One Back or root Escape returns from a step to its predecessor; returning to Desk selects the last card viewed.

Bare reader keys work outside editable fields: h/l or left/right step pages, and on a constitution's page, away from the rows, `l` unfolds the selected thread's tapestry or report, else its newest file, under its row, and folds it again; j/k step constitutions in the Desk's order as one flow, across its columns (Drafts, In flight, Awaiting review, Resting and Roles), and J/K jump between those columns, landing on the constitution last open in each; a brief toast names the column and constitution a step lands on, and a constitution outside the Desk stands beside its family's row; down/up scroll about three lines, repeating while held; d/u scroll half a viewport; Space/Shift-Space scroll a full viewport.
g/G or Home/End select first/last pages, Enter/o toggle expand, and Escape unwinds popovers, expand, then returns.
The same constitution keys act on the open fiber in the reader and on the selected card on the Desk: c (or .) opens the worker's conversation exactly as its pill does, and with no worker up reopens its past session in a terminal on its host, in any column: nothing is sent, no turn starts, and the card's lifecycle does not move (a card that never ran is launched from the band); t tempers, x discards and a moves work in progress to Awaiting review, each after the same undo window (z takes the latest back).
s on a focused Desk card or constitution page opens a small date popover: Enter with no date rests undated, and a chosen date rests until that day.
Rest works in any state and stops a live worker through the owning daemon's lifecycle path.
In flight shows **Your turn** then **Working**; a question card (an ask or a harness prompt) leads Your turn and opens its report when present.
Alt-left/right step pages and Alt-down/up step constitutions, including while typing.
A plain fiber reached by wikilink keeps the tab label **Note**.
The tablist keeps one Tab stop and moves focus with its selected tab.
HTML documents get first refusal on their own keys; native PDF and media viewers keep their controls.
`?` shows the shared keyboard help.

### A constitution's page

Clicking a card opens its family's page: the family's root constitution heads it, and its threads follow as rows. It is there to make each thread's outcome, tapestry, sent files and constitution easy to reach, and to show which thread needs you.

The head gives the root's name, its state and last move, its outcome in full, and what it holds. Below it the family's tree stands whole, every thread under its orchestrator: the Desk splits work by state, and this page keeps the hierarchy. Siblings run in the order they ask for attention by the most urgent thing each holds, its own state or that of any thread under it, newest first within a kind, so a question deep in a hub lifts the hub to the top of its level. The family's own threads sit under one divider per kind, each appearing once: **Questions**, **Blocked**, **Your turn**, **To review**, **Working**, **No worker**. An unfolded thread's own threads follow it without dividers. The threads set aside wait behind one fold at the end of each level, which names how many of each; a click opens it to Resting, Drafts, Seats and Archived dividers in that order.

Rows are grouped by indentation. A row leads with the thread's slug in bold monospace, its full name in the tooltip, then its own state below the family's level, where no divider names it, and what it holds, in the same glyphs as the Claude mod, each in a fixed place so an absent one leaves its place empty: `⌗` its tapestry or report, `☰` its constitution, `⧉ n` its sent files. Its lifecycle icons come next, and its last move sits at the very right. Under it, dimmer and in the body font, is what the thread came to or asks, clamped to two lines, and below that a small count of the threads it holds and how many of those ask something of you. A row carries one mark, coloured by the most urgent thing it holds as on the Desk: red only for questions and blocks, amber for your turn, teal for to review, blue for working, a dashed ring for no worker, muted for what is set aside. A small bright diamond marks a sent file you have not opened, on its name and on the glyph that holds it.

A click on a row unfolds it, and a second click folds it. An unfolded row shows its own threads beneath it, laid out the same way one step in, with their own fold of what is set aside. A click on `⌗` or `☰` unfolds that document directly under the row, across the page's full width and at its own full height, as part of the page's one scroll: never a separate page, never a frame that scrolls inside the page. A second click folds it, and each thread holds one document open at a time. An HTML page is drawn at its own height, with its viewport units fixed to the board's window, so a tapestry's screen-filling map stays one screen tall. `⧉ n` unfolds the sent files as a list, newest first, one per line with its age, and each unfolds under the row the same way. The tapestry or report is the one the fiber's directory holds, else the newest sent file named for one. A highlighted or hovered thread row shows the same lifecycle icons as the console, by state, left of its last move; clicking one selects the row without unfolding it and gives a verdict the same undo window. Rows carry no worker line and no way to Rex: the band's worker line is the one place to message or start a worker, and following links the page to Rex.

Entering a thread commits to it: a click on its row or one of its documents, Enter, or `l`. Entering moves voice to the thread and Rex quietly to its worker's window if it has one; it never opens a new tab. Moving the highlight commits to nothing, so skimming the rows with `j` and `k` while talking never moves the mic. Folding, Escape and Back leave Rex alone. `c` opens the highlighted thread's conversation outright. The lifecycle keys, console verbs and worker line act on the highlighted thread, or on the page's card when the head or no thread is highlighted; the console's title stays on the page's card. A bar at the row's edge marks the thread Rex holds.

With a row focused, the keys follow one grammar, depth along `h` and `l`. `j` and `k` (or down and up) move the highlight from row to row, never onto the documents. `l` (or right) goes in: from a row it unfolds the row's first document under it (its tapestry, else its constitution) and rests on that glyph, entering the thread; from a glyph it unfolds the next document in its place; from `⧉ n` it lists the sent files and unfolds the newest. Among a row's documents, `j` and `k` step between them. `h` (or left) goes out: from a document to its row, folding what it had unfolded, and from a row off the page, back where it was opened from, so `h h` from an unfolded document returns to the Desk. Enter on a row does what a click does. Escape folds the open row around the highlight, outward one level at a time, and once nothing is open around it, goes back. The reader's own `j`/`k` stepping between constitutions does not fire while the rows have the keys; Alt-down/up step to the next or previous constitution in the Desk's order from anywhere on the page.

When Rex's worker changes, from its sidebar or otherwise, the board goes there, with voice on or off. Rex merely coming to the front moves nothing on the board. A thread of the open family is unfolded, selected and scrolled to, without speaking back to Rex or to voice. A thread of another family lands on that family's page, on any host, from any view; the Globe shows it in place. A page of the same fiber's channel stands, so opening a file does not bounce back. Opening a page does not change what Rex shows.

The page reads its feeds and repaints only while it is the selected page of an open reader, and runs nothing in between.

### Where voice goes

With Follow me on, voice goes to what you are looking at, and whichever of Rex and the board had focus last decides. While the board has the keyboard, voice goes to what it shows: on a constitution's page, the thread last entered, or the root until one is; on any other page, that page's constitution, the nearest one above a plain fiber. A hover never moves it. Rex takes voice by coming to the front or changing worker, and the board takes it back by regaining focus. A click on the Globe takes voice along with it. Moving the highlight with the keys never moves voice. The Desk, Chronicle and Board views show no one fiber, so they leave voice where it is. While a meeting holds the mic, nothing moves.

The receipt feed is `/api/v1/sent-files/all/composite`, which combines each host's event stream.
A host without an event stream contributes no receipts — see [Telemetry](telemetry.md).

## Globe — everything on one sphere

The Globe holds the whole fleet on a HEALPix sphere: zoom out and it holds everything running, zoom in and you reach a project, a family, a thread, its files and its finished work. `ui/src/board/globe/` is the view; its boundary maths is checked against healpy.

**Latitude is state.** The twelve base pixels are three bands of four. The north holds families with anything in flight, the equator families at rest, the south families wholly finished, so a family's latitude says where it stands and going south is going into the past. Within a band each project is one cell, its province, labelled with the project's name. An area the ids name, such as `ai-futures/felt/`, is a cell inside that when two or more families share it, and families lie inside those. A project appears once in each band it has work in.

**Area is a share of the work.** The nested scheme is a quadtree, so each size is a power of four, and siblings are packed by a buddy allocator. A cell is as large as it must be to hold what it holds, heavier threads take more, and shares are compressed so that a hub of a hundred threads does not reduce a lone thread to a speck. Not every tile is filled: the rest is ocean, or the ground of its parent.

**What is live gets the area.** No family is larger than a cell of order 2, so ocean stays between families, and within a family live threads fill it. A thread with threads gives them its north, west and east quadrants, sized to fill them, heavier and fuller threads first. Its south quadrant holds the rest: its tapestry or report at the centre of the cell, its constitution and files to the east of that, its settled threads below. When none of its threads is live, the settled ones take the three quadrants. A thread with no threads keeps its north quadrant for its name, its tapestry to the west and its files to the south and east, a lone file largest, with its constitution at the east's corner. A tapestry's place is kept before it is read, so its arrival moves nothing.

**Places hold.** Each sibling follows a path of quadrants drawn from a hash of its persistent id, and the eldest choose first, each taking the first free cell of its size along its path. A new thread takes what is left and usually moves nobody; every third or so makes a sibling give up a spare cell, which shifts some of that family's threads. A thread that changes state moves almost alone, within its family, and other families stay put. A family that changes band moves whole. A band that crosses a size limit rescales in place.

The tile's colour is its state, in the Desk's pigments, and it fades with age. Archived threads keep a third of their colour and go unnamed, so a hub's finished work sits quietly in its south quadrant; they wake when the view comes to them or to the archived thread they lie in, and a tile of one is named once it is wide. A tile too small to open shows the most urgent thing inside it.

**Pages show what they hold.** A tapestry, report, constitution or sent file is a page tile, in paper grey rather than a state's colour. From about 26 pixels it carries the mark of its kind (▨ an image, ▣ a page, ▧ a PDF, § a constitution) in its north quarter, clear of its name. From 130 pixels a file or tapestry shows its thumbnail instead: the plot itself, or a page's first screen, the board's own thumbnails in the largest box of the file's shape that fits the tile, named beneath when there is room. Thumbnails load as their tiles come into reach, nearest the centre first, within the board's one loading budget; none starts during a flight, and they stay cached a while after they leave the screen. A file its host no longer has shows its name and kind. What asks keeps a marker of constant size from any distance, and what asks over the horizon waits at the rim at its bearing. The chips under the trail count what asks, and clicking one walks to the next of that kind. The peek at the foot names the tile under the pointer or in focus, with its order and nested index.

**Moving.** One hand does it: scroll zooms about the pointer, and so does a pinch, down to the smallest thing there filling the stage; drag turns. The globe turns freely, over the poles and on: the point you grab stays exactly under the pointer at any zoom and orientation, a drag beside the sphere turns it by its rim, and a let-go drag coasts to a stop. North rights itself only while the hand moves, turned about the grabbed point, so it never slides out from under you, and every flight lands north up. The view opens looking straight down on the north, where everything in flight is. A flight frames a tile whole between the trail and the peek. Under the tile in focus names come first, live threads before archived ones. A name that its tile cannot hold stands nearby inside the focus, or out on the open water beside it, never across its edge, with a fine line back to its tile. Names grow in as their tiles can hold them whole, and the grid, drawn under the tiles, refines with the zoom.

**Mollweide and the plane.** `m` or the switch at the top right steps from the globe to Mollweide's whole sky, the map healpy draws, and on to HEALPix's own plane (Calabretta & Roukema 2007), looking where the last one looked. The plane lays the twelve base pixels out as diamonds in three rows, north in flight on top, every cell a straight square diamond, the polar ones included, scaled to the sphere's area so a tile is as wide on it as on the sphere; it wraps east and west and keeps itself in view top to bottom. On the globe the cells near the poles are sheared as HEALPix makes them, and Mollweide squeezes the polar row where everything in flight sits; the plane shows them undistorted. Clicks, zoom and flights are the same on all three.

**Clicking.** A click on a thread flies to it and moves Rex to its window at once, if it has one; on a phone a tap comes to it. A click on a tapestry, report, file or constitution opens it on the stage, and Back returns to the Globe as it stood. A click on a province or area flies to it. Zooming, turning and stepping back never touch Rex. A click in Rex flies the Globe to that thread, as it moves the family map, while voice is on.

| Key | On the Globe |
|---|---|
| `Esc`, `h` | One level out |
| `←` `→` `↑` `↓` | The previous or next thing that asks, most urgent first |
| `Enter` | What a click does, on the tile in focus |
| `/` | Find; picking a thread flies the Globe to it, leaving Rex and the stage be, and a fiber the Globe has no tile for opens its page |
| `+`, `-` | Zoom |
| `m` | Globe, Mollweide, the HEALPix plane, in turn |

## The board is optional, and the bundle is its own artifact

A fetched daemon already has it: CI builds the bundle and copies it into the
release's own `priv/`, so a downloaded daemon serves the board with no Node
anywhere in sight.

A checkout serves `ui/dist` from the checkout, and the repo does not ship that.
Build it with:

```bash
make ui        # npm ci when the lockfile changed, then npm run build
```

A fresh clone builds it fine — no private checkout needed (see [Sharp
edges](installation.md#sharp-edges)). `make build`, `make restart` and `make
all` all include this step; `SKIP_UI=1` leaves the bundle alone, which is how a
host that takes its bundle from elsewhere is built.

`SHUTTLE_UI_DIST` overrides both, pointing the daemon at any built bundle on
disk.

Without the bundle the root URL 404s with a hint, and the API stays fully
usable. If you change any `/api/v1/*` route, rebuild the bundle — a stale
bundle against a changed route table fails silently as a 404.

## Settings

`⌘,` opens the settings sheet, and so does a bare `,`: the board's own idiom
is bare keys, and a phone has no `⌘`. The ⚙︎ closing the tab strip does the
same with a pointer, pinned to the right edge on a phone so it never scrolls
out of reach. `Esc` closes it. It is an overlay rather than a fourth tab — the
three tabs are windows onto the work, and configuration is not work.

Settings opens to **Conversations**, where you choose the preferred destination for Console, worker pills, keyboard opening and History.
The conversation-opening preference belongs to this browser and saves immediately.
Long-press or right-click Console or a worker pill to choose another supported destination.
Choosing among alternatives remembers the destination; opening a sole destination leaves your preference unchanged.
When the preference is unavailable for a worker or device, opening uses the best available destination without changing it.

Host settings sit separately under **Worker hosts**.
The host picker selects which machine the remaining configuration addresses. The board is reachable from a phone and from a second hub, so the
machine you are configuring is usually not the one you are sitting at; every
read and write on the sheet carries the chosen host's origin and is
owner-routed to the daemon that owns the file. Configuring a remote needs that
remote's daemon to be recent enough to serve the config routes; an older one
says so.

| Section | What it holds |
|---|---|
| **Conversations** | The preferred conversation destination in this browser; worker execution stays unchanged |
| **Notes & tasks** | `stores.json` — the store list this daemon is configured with, and the symlinked substores it reaches through them |
| **Project folders** | `projects.json` — the checkouts Stash and Capture offer; adding one initializes its `.felt/` |
| **Worker agents** | The merged registry, each record marked with the layer it came from, with a default-effort select per agent (written as an `overrides` entry), over `agents.json` |
| **Connected hosts** | `remotes.json` as rows — how each remote is reached, whether it answered, what build it is running — plus the supervised tunnel jobs derived from it |
| **Access & listening** | Whether this is a personal or shared machine, and who can reach its daemon |
| **Daemon status** | Build, CLI contract, poll health, running workers, and the boot quarantine |

**Host configuration sections offer an advanced text editor for their files.** That is what makes
the sheet hold *all* the configuration rather than all of it there is a widget
for, and it is the only safe way to touch `remotes.json`: a structured round
trip drops every key the model does not know about, and that file carries
several (`auth`, `ssh_flags`, `tunnel.label`, per-entry timeouts) that
`shuttle remotes add` has no flag for. A save is refused unless the tool
that really reads the file accepts it first, and the refusal is that tool's own
sentence — see [the API reference](../reference/api.md#the-operator-files).

Two things the sheet will not do. It will not edit `~/.shuttle/host`: the
daemon freezes its host id at boot, so a file rewritten under a live daemon
would leave the CLI and the dispatcher disagreeing about what this machine is
called, and that is the worst failure this system has. And when `SHUTTLE_STORES`
or `SHUTTLE_PROJECTS` is set in a daemon's environment — which overrides the
file's contents outright — the section says so and turns editing off, rather
than letting you carefully fix a setting that has no effect.

A card that never appears at all is usually a dispatch question rather than a
board question — see [Diagnosing a missing card](lifecycle.md#diagnosing-a-missing-card).
