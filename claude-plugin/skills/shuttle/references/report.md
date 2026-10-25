# Writing report.html

The report is the surface the human lands on to understand the work.
The constitution opens on chat with `report.html` inset at its upper right; clicking the figure opens the report full-size.
Keep that one living surface current, and link to depth rather than making the human choose among sent files. It is a **current-state document, rewritten each session** — the same rule as `outcome:` and `## Status`, extended to the surface that carries figures.

Not every constitution wants one (see SKILL.md, "The fiber's surfaces"). When one exists, these rules bind.

## Who reads it

**Primary reader: the human.** Pitch background at what they know since their last engagement.
If days have passed, bridge that gap; if you just discussed the work, don't re-explain the conversation.
**Secondary: the next worker,** arriving with no context at all.
Keep the supporting detail self-contained below the opening, rather than making the human reread what they already know.

Neither wants the trench narrative. What you tried Tuesday and abandoned Wednesday is not a finding — the *conclusion* is, if it survived.

**Name state as you use it.** "Run 04 (the apodized-mask one)" costs six words and saves a round trip. Never assume continuity of context across the gap.

**Not the same surface as the other two.** `outcome:` is the kanban headline and `## Status` is the next worker's handoff — mechanics, blockers, where you stopped. The report is the human's: meaning, evidence, figures. Don't restate one in the other.

## Rewrite, don't append

**Each session rewrites the whole report** against current understanding. You are not adding a layer; you are restating what is true now, with everything superseded removed.

**Zero session numbering.** No "session 3", no "this dispatch", no "updated 2026-06-14", no per-section date stamps. One as-of stamp at the top of the document is the only time marker the report carries. Time-anchored phrasing anywhere else is the smell that says history is sedimenting where a correction belongs.

Concrete shapes this forbids:

- `<h3>The lognormal-solver "excess" was a metric false alarm (session 3)</h3>`
- "Session 1 blamed `partition(method='nnls')`; the lstsq run refuted that."
- "Session 5 read the ensemble out; session 6 closed the pipeline-validation question."
- Findings ordered by when they were found rather than by what they mean.

**Cut resolved false alarms and superseded hypotheses.** A dead end that no longer constrains anything gets deleted, not archived in place. Keep a ruled-out line only when it prevents a *costly* re-investigation — and phrase it as current knowledge, never as an event:

> **Don't:** "Session 2 flagged 81 convergence failures; session 3 found the excess was a metric false alarm, and the real numbers are +1.9σ/+0.6σ."
>
> **Do:** "The solver's convergence flag zero-divides on exact-zero cross spectra, so its warnings carry no information; we audit per-multipole residuals instead — exact to <3×10⁻⁶."

The second is shorter, tells the reader what to do, and stays true next month. The first is a story about you.

**Exception: content whose subject *is* chronology** — a postmortem, a decision log, a change history. There the sequence is the finding. That is a different genre, and rare for a constitution report.

## Shape

**Before `shuttle ask`, rewrite `report.html` to lead with the question.**
Nothing goes above this opening, including a title, as-of stamp, status panel or executive summary:

1. **Short background** — pitched at what the human knows since their last engagement, only enough to frame the question.
2. **Question and options/tradeoffs** — what their view would help with, the alternatives and their costs when there are alternatives.
A loose, nonblocking request for a view is welcome; don't manufacture fixed choices.
3. **Executive summary** — below the question, followed by evidence and depth.

A question card leads the Your turn band and opens the chat with its report inset.
Keep working after raising the ask, and clear it when it becomes moot.

Without an outstanding ask, the default skeleton is:

1. **Headline state** — a few sentences, verdict-bearing. Where the work stands, and the action the human takes next if any. Not "we worked on the covariance" but "the cut-sky Gaussian covariance under-covers by 20–35% at low z, so every σ below uses the 200-seed ensemble instead. Nothing needs your decision."
2. **Standing findings, grouped by meaning** — one heading per thing that is true, named for the claim, evidence attached. Group by what they are about, never by when they landed. A finding without its evidence is an assertion. Every claim carries its receipt — the number, the plot, the command, the sub-fiber — so the reader can challenge it cheaply. A finding that has its own sub-fiber carries the verdict, the number and the link, **not the argument**. If a finding needs more than a short paragraph, that is the signal it wants a sub-fiber, not more report.
3. **Open questions** — short, each one actionable.
4. **Pointers to depth** — sub-fibers, stats files, the spec, the code. The report is a hub, not an archive; long derivations live where they were made.

## What earns its place

**Differentiate confidence visibly.** "The bias looks small — m ≈ 2×10⁻³, one field only, treat it as a working number" is a complete and honest finding. An inferred-but-unverified claim says so inline. Never report a result you did not observe.

**Length tracks surprise, not effort.** A session that confirmed the plan adds nothing but a refreshed headline.

**Every element earns its place** by changing what the reader understands or decides next. Status badges, provenance panels, effort logs and considered-alternatives sections rarely do.

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

Never `<img src="recovery.png">`. **Why:** a report travels alone. It gets sent as a single file, opened straight off disk, and read from a checkout on another machine — and most fiber stores gitignore binaries as policy (the loom does), so the sibling PNG never even syncs. In all three cases a relative `src` renders broken, and those are the cases where the human actually reads it. The same rule covers every other asset: styles stay inline, fonts fall back to system stacks, no external fetches.

Inline at write time — read the PNG, base64 it, write the tag. If a plot is too heavy to inline comfortably, shrink the plot, not the rule.

**Every figure earns a caption-level claim.** The caption says what the reader should *see*: "the B-mode null sits within 1σ of zero in all five bins; the ℓ≈84.5 outlier is the known SPT spike" — not "B-mode spectra". A figure with no claim attached is decoration. Cut it, or find its claim.

## Mechanics

You may give the report's channel a bundled theme with `theme: blueprint` (or `portolan`, `laboratory-paper`, `night-chart`) in the fiber's frontmatter.
A sibling `theme.css` layers scoped variables, fonts and flourishes over that base; it styles Shuttle's reader and overview folio, while `report.html` keeps its own CSS.
The [constitution theme contract](https://cailmdaley.github.io/felt/concepts/themes/) documents the `--ws-*` tokens, stable parts and pigment meanings.

Start from [report-template.html](../assets/report-template.html), a palette and primitives kit, not a framework or a content model to fill in.
Plain HTML is right too.
It follows the viewer's light or dark appearance automatically.
A sibling `report.html` appears inset in the constitution's chat without a directive.
An explicit `:::{embed} report.html` in the fiber body also declares it there.

Reference a sibling page with `href="./name.mp3"` or its unique basename in `<code>`; the reader makes it a page link with inline play for audio ([companion references](https://cailmdaley.github.io/felt/concepts/companions/#references-between-pages)).

## Copy-paste primitives

These blocks use the template's CSS.
Replace sample claims and data; keep figures self-contained.

### Figure and caption

```html
<figure>
  <img src="data:image/png;base64,REPLACE_WITH_PLOT_BYTES" alt="Residuals with their uncertainty bands">
  <figcaption>All five residuals lie within one standard deviation of zero.</figcaption>
</figure>
```

### Table

```html
<table>
  <caption>Validation against independent patches</caption>
  <thead><tr><th scope="col">Patch</th><th scope="col">Residual / σ</th></tr></thead>
  <tbody><tr><th scope="row">North</th><td class="num">0.3</td></tr></tbody>
</table>
```

### Status strip

```html
<div class="status-strip" role="status">
  <strong>Validated</strong><span>Five independent patches pass.</span>
  <span>Next: review the scale cut.</span>
</div>
```

### Nested page

```html
<p><a href="./validation.html">Read the validation and its plots →</a></p>
<p><a href="./checks/report.html">Read the checks thread's report →</a></p>
```

Relative file links open in place, one level deeper in the reader.
The `‹` button, key or phone swipe goes up one level, then back to chat.
In-page `#anchors` stay in the report; external links open outside the reader.
Download links keep their download behaviour.
Each nested report is itself self-contained; links express structure without bundling every page into the overview.

### Another fiber's report

```html
<figure class="report-embed">
  <iframe src="./checks/report.html" title="Independent checks report"
    loading="lazy" sandbox="allow-scripts"></iframe>
  <figcaption>The independent checks pass in every patch.
    <a href="./checks/report.html">Read the full checks report →</a>
  </figcaption>
</figure>
```

A live report embed is the deliberate exception to the no-fetch rule: it reads another report from the fiber tree.
Use a relative path from this report to that fiber's `report.html` (for a sibling fiber, `../checks/report.html`).
The embed needs that companion to travel with it; for a portable single-file export, replace it with an inlined figure and retain the link to depth.

The test before handoff: **give the report to someone who has never seen this fiber and ask what they'd do next.** If they have to reconstruct the present by diffing paragraphs, rewrite it.
