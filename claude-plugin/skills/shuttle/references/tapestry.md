# Writing tapestry.html

The tapestry is the constitution's one page: what this work is, whole, as it stands. It says what was built or found, how the parts fit, how it is used and where it stands. It describes the work, never the latest stretch of it: a reader who has never seen the fiber should leave with the mental model, and one back after a week should find the same picture with its present state. Its form follows the work: a visual index to sub-fibers and findings, the slides of a talk being built, PDFs side by side for a paper review. The constitution's chat header shows its thumbnail; clicking opens it full-size.

## The first screen

**A tapestry opens on one screen that can be read at a glance.** The human comes back after hours or days away, with hundreds of chat lines unread, and this screen is what fills their display. Without scrolling, it tells them what this work is, where it stands, and what needs them, if anything.

**Make it beautiful, and make the beauty carry the state.** The human wants to open their work and enjoy looking at it. Choose the form that fits the shape of this work, and be inventive: a diagram of a pipeline's stages, a chart of a territory, a column of strata, a board, a list set like a page of a good book. Draw it in code: inline SVG, canvas, or the watercolor-and-ink kit in [tapestry_map.py](../assets/tapestry_map.py). The test of any form is that the picture is the summary. A drawing the reader admires and then scrolls past to learn what happened has failed, and so has a status list nobody enjoys opening. For a morning's email, the first screen is the messages that need an answer.

**Set what needs the human in reading type.** In a drawn first screen, the items that need the human sit together as a short list at body size on a plain ground, such as a cartouche or a plate. Captions scattered across the picture don't count. Every label over drawn ground gets a plate or a halo, and none may collide at desktop or phone width.

**Let the ornament count.** A repeated mark (trees, sails, houses, reeds) stands one for each thing it represents, so the reader can count it; a fixed number of trees is decoration that competes with the counts beside it. Write numbers in ordinary numerals.

**Explain an allegory once.** When the form borrows a reference or names its parts with puns, tell the human what the reference is and what each part means the first time they see it. Keep the key in the code that draws it, not on the page.

**When the work has a primary artifact, the first screen can be a board.** A paper or a deck shows only what has already landed in it, so a reader back after a day can't see what moved. Make a small board with the artifact as one block, beside blocks for what it can't show yet: a new figure, the latest numbers, a lost run, a pending decision. Each block carries the thing itself and its state; a script that re-inlines the artifact keeps the board current with each build.

**Everything hangs from the first screen.** Each part of it is a section of the page, and a reader sees the whole, then chooses where to dig. Disclose in layers: first screen, a short paragraph per part, then `<details>`, nested pages and sub-fibers. Keep the page short: two or three screens below the first.

**Test the glance before a stop the human will review.** Take a headless screenshot of the first screen alone and give it to a fresh agent on the cheapest model you can launch, with no other context. Ask it what this is, where it stands, and what the human needs to do. Rewrite the screen until its answers are right. Look at it where the human reads it, in Shuttle's reader as well as the bare file, at desktop and phone widths.

A PR description is this page at the scale of one change.

## Who reads it

**Primary reader: the human,** who may have been anywhere since this began. Never lean on the conversation you just had.
**Secondary: the next worker,** arriving with no context at all.

Neither wants the trench narrative. What you tried Tuesday and abandoned Wednesday is not a finding, and neither is what a review caught last night, nor the last thing you did. The *conclusion* is, if it survived.

**Name state as you use it.** "Run 04 (the apodized-mask one)" costs six words and saves a round trip.

`outcome:` is the kanban headline and `## Status` is the next worker's handoff — mechanics, blockers, where you stopped. The tapestry is the understanding: meaning, evidence and visual structure.

## Rewrite, don't append

**Each session rewrites the whole tapestry** against current understanding, with everything superseded removed.

**Zero session numbering.** No "session 3", no "this dispatch", no "updated 2026-06-14", no per-section date stamps. One as-of stamp at the top of the document is the only time marker the report carries.

Concrete shapes this forbids:

- `<h3>The lognormal-solver "excess" was a metric false alarm (session 3)</h3>`
- Findings ordered by when they were found rather than by what they mean.

**Cut resolved false alarms and superseded hypotheses.** A dead end that no longer constrains anything gets deleted, not archived in place. Keep a ruled-out line only when it prevents a *costly* re-investigation — and phrase it as current knowledge, never as an event:

> **Don't:** "Session 2 flagged 81 convergence failures; session 3 found the excess was a metric false alarm, and the real numbers are +1.9σ/+0.6σ."
>
> **Do:** "The solver's convergence flag zero-divides on exact-zero cross spectra, so its warnings carry no information; we audit per-multipole residuals instead — exact to <3×10⁻⁶."

The second is shorter, tells the reader what to do, and stays true next month. The first is a story about you.

**Exception:** a postmortem or decision log, where the sequence is the finding.

## Shape

**Before `shuttle ask`, rewrite `tapestry.html` to lead with the question, directly below the first screen.**
Only the first screen goes above this opening:

1. **Short background** — pitched at what the human knows since their last engagement, only enough to frame the question.
2. **Question and options/tradeoffs** — what their view would help with, the alternatives and their costs when there are alternatives.
A loose, nonblocking request for a view is welcome; don't manufacture fixed choices.
3. **Executive summary** — below the question, followed by evidence and depth.

A question card leads the Your turn band and opens on its report.
Keep working after raising the ask, and clear it when it becomes moot.

Without an outstanding ask, the default skeleton is:

1. **The first screen, then what this is** — a title and a sentence or two that would make sense to a stranger.
2. **Where it stands** — a few verdict-bearing sentences, and the action the human takes next if any. Not "we worked on the covariance" but "the cut-sky Gaussian covariance under-covers by 20–35% at low z, so every σ below uses the 200-seed ensemble instead. Nothing needs your decision."
3. **One section per part of the first screen** — what it is, how it works, why it is that way. Named for the claim, grouped by meaning, never by when it landed. Every claim carries its receipt — the number, the plot, the command, the sub-fiber — so the reader can challenge it cheaply. A part with its own sub-fiber carries the verdict, the number and the link, **not the argument**.
4. **Open questions** — short, each one actionable.
5. **Pointers to depth** — sub-fibers, stats files, the spec, the code. Long derivations live where they were made.

## What earns its place

**Differentiate confidence visibly.** "The bias looks small — m ≈ 2×10⁻³, one field only, treat it as a working number" is a complete and honest finding. An inferred-but-unverified claim says so inline. Never report a result you did not observe.

**Length tracks what it takes to hold the work, not effort.** A session that confirmed the plan changes the state on the first screen, nothing more.

**Every element earns its place** by changing what the reader understands or decides next. Status badges, provenance panels, effort logs, review histories and considered-alternatives sections rarely do.

## Open questions are worked, then written

**Work questions you can settle yourself before carrying them forward.**
Requests for the human's view needn't be blockers or failed attempts at a fixed decision.
Make clear what their response would inform, and what you can keep doing without it.

Each surviving item **names what would resolve it**: the run, the check, the person, the decision. "Is the low-z excess real?" is a shrug. "The low-z excess is +1.9σ against the ensemble covariance; a 200-seed run at lmax 700 separates real signal from the noise floor — 40 node-minutes, not yet run" is an open question.

**A question carried unchanged across sessions is a flag, not a fixture.** Work it, say why it can't be worked yet, or delete it.

## Self-containment is mandatory

**The report is one file.** Every image is **base64-inlined as a data URI**:

```html
<img src="data:image/png;base64,iVBORw0KGgoAAA…" alt="…">
```

Never `<img src="recovery.png">`. A report travels alone: sent as a file, opened off disk, read from another machine's checkout, where most fiber stores have gitignored the sibling PNG. Sibling PDFs and embedded reports are exceptions and must travel with the tapestry. The same rule covers every other asset: styles stay inline, fonts fall back to system stacks, no external fetches.

Inline at write time — read the PNG, base64 it, write the tag. If a plot is too heavy to inline comfortably, shrink the plot, not the rule.

**Every figure earns a caption-level claim.** The caption says what the reader should *see*: "the B-mode null sits within 1σ of zero in all five bins; the ℓ≈84.5 outlier is the known SPT spike" — not "B-mode spectra". A figure with no claim attached is decoration. Cut it, or find its claim.

## Mechanics

You may give the report's channel a bundled theme with `theme: blueprint` (or `portolan`, `laboratory-paper`, `night-chart`) in the fiber's frontmatter.
A sibling `theme.css` layers scoped variables, fonts and flourishes over that base; it styles Shuttle's reader and overview folio, while `tapestry.html` keeps its own CSS.
The [constitution theme contract](https://cailmdaley.github.io/felt/concepts/themes/) documents the `--ws-*` tokens, stable parts and pigment meanings.

Start from [tapestry-template.html](../assets/tapestry-template.html), a palette and primitives kit, not a framework or a content model to fill in.
Plain HTML is right too.
It follows the viewer's light or dark appearance automatically.
A sibling `tapestry.html` is the page a constitution opens on, without a directive.
An explicit `:::{embed} tapestry.html` in the fiber body also declares it there. Existing `:::{embed} report.html` declarations continue to resolve.

Reference a sibling page with `href="./name.mp3"` or its unique basename in `<code>`; the reader makes it a page link with inline play for audio ([companion references](https://cailmdaley.github.io/felt/concepts/companions/#references-between-pages)).

## Copy-paste primitives

These blocks use the template's CSS.
Replace sample claims and data; keep figures self-contained.

### Embedded PDF

```html
<figure><iframe src="./paper.pdf" title="Draft v3" style="width:100%;height:80vh"></iframe>
  <figcaption>Section 4's covariance argument is where the referee will push.</figcaption></figure>
```

### Nested page

```html
<p><a href="./validation.html">Read the validation and its plots →</a></p>
<p><a href="./checks/tapestry.html">Read the checks thread's report →</a></p>
```

Relative file links open in place, one level deeper in the reader.
The `‹` button, key or phone swipe goes up one level, then back to where you came from.
In-page `#anchors` stay in the report; external links open outside the reader.
Download links keep their download behaviour.
Each nested report is itself self-contained; links express structure without bundling every page into the overview.

### Another fiber's report

```html
<figure class="report-embed">
  <iframe src="./checks/tapestry.html" title="Independent checks report"
    loading="lazy" sandbox="allow-scripts"></iframe>
  <figcaption>The independent checks pass in every patch.
    <a href="./checks/tapestry.html">Read the full checks report →</a>
  </figcaption>
</figure>
```

A live report embed is the deliberate exception to the no-fetch rule: it reads another report from the fiber tree.
Use a relative path from this report to that fiber's `tapestry.html` (for a sibling fiber, `../checks/tapestry.html`).
The embed needs that companion to travel with it; for a portable single-file export, replace it with an inlined figure and retain the link to depth.

The test before handoff: **give the report to someone who has never seen this fiber and ask what was built, how it's used and what they'd do next.** If they can't say, or have to reconstruct the present by diffing paragraphs, rewrite it.
