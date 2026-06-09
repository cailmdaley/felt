# Constitution

Drafting a constitution — a fiber spec describing a desired state for autonomous iteration. This is the ideating process (see SKILL.md and `ideating.md`) applied to a specific artifact type: a living document that an iteration runner re-reads with fresh context until the work is done. Felt is agnostic about the runner — external dispatchers (e.g. Shuttle) watch fibers and spawn workers against them; the constitution itself is just a tagged fiber.

---

## What a constitution is

A constitution is a design document with trust built in. Like a governmental constitution, it lays out principles and aspirations — not specific laws, not the current state of affairs. It is designed to outlast any single iteration and remain valid as the world changes around it.

**A good constitution never says "50 files remain"** — that is a snapshot that goes stale. It says `check "grep -r 'old_pattern'"` — that is a principle that stays true until the work is done.

Constitutions do not prescribe steps. They describe what the system looks like when it is right — the desired state, in both senses of the word. Nothing in the constitution should become confusing or unnecessary as the desired state is reached. Whoever works from it surveys reality, reasons about the gap, and decides what is highest value. Each iteration of the work does this with fresh context.

**Constitution, not plan.** Plans assume you know the path; constitutions trust the agent to find it — with taste, judgment, and fresh eyes each time. This matters most in science and exploratory work, where each decision is informed by the result just before it.

**Separation of context: if you ideate, you never do the work yourself.** The constitution is designed by one role; iterations are run by another.

---

## When to write a constitution

- Work where adaptation matters more than a fixed plan: scientific investigation, exploratory refactoring, creative writing
- The desired state is clear (or can be made clear) but the path is not
- Iterations need to re-read with fresh context and make judgment calls
- A checklist would either be wrong after one step or race through without judgment

Don't write a constitution for: clearly-scoped atomic tasks, anything where a checklist or a plan is genuinely the right shape.

---

## Workflow

### 1. Study

Read relevant files, understand existing patterns. This informs the **constitution**, not implementation — the goal is pointers that iterations will follow, not a head start on the work.

### 2. Draft

Create the fiber with status `open`:

```bash
felt add <slug> "name" -s open
```

Then Read and Edit the fiber markdown at `.felt/<path>/<slug>.md`. Fill in what you can; do not wait until it is perfect.

Use the ideating process from `ideating.md`:
- **Wonder → Ontology:** what IS the desired state? Name it precisely.
- **Design → Delivery:** what sections does this constitution need? Which are pointers vs snapshots?

Stances that help most during constitution drafting:
- **Ontologist** for naming the desired state ("what IS 'done' here?")
- **Simplifier** for fencing scope ("what are we explicitly leaving alone?")
- **Contrarian** for pressure-testing whether the whole framing is right
- **Architect** when the constitution is about refactoring structure

### 3. Refine

Show the draft, get feedback, revise. Use structured choices when ambiguity needs user judgment. Apply the qualitative ambiguity self-check from `ideating.md` — goal, constraints, success — before launching.

Repeat until it feels solid. It does not have to be complete; live uncertainties can hold their own earned section ("Open questions") until resolved — then it gets deleted, not left as a victory log.

### 4. Launch

When approved, hand the fiber to whichever iteration runner is appropriate — felt is agnostic. Common options:

- **External dispatchers** (e.g. Shuttle) — tools that watch fibers for dispatch-eligible blocks and spawn single-shot workers; their configuration is owned outside felt. (The old `ralph` manual loop runner is retired; in-session subagents/workflows cover within-session iteration.)

The constitution fiber stays editable while iteration runs. Successive iterations re-read it each cycle, so refinements between iterations are normal.

---

## Constitutional sections

Only two things in a constitution are universal — orientation and contract. Prescribing more is over-specification of *documents*, the same disease as over-specification of behavior: a fixed "Context" heading tells authors "you must have background prose," so they write some, and a section named for nothing in particular fills like a junk drawer.

**The lede comes first, and it has no heading.** The body's opening paragraph orients both readers — the human skimming a card and the worker landing cold: what this is, why it matters now, where it sits in the web of fibers and code. Write it to stand alone (felt surfaces it in `-d summary`), and weave `[[wikilinks]]` into it so situating is one click deep. The test: someone who knows nothing reads the lede, then Desired State, and never wonders "what *is* this thing?" If a term in Desired State needs defining, define it in the lede — or link to where it already lives.

**`## Desired State` is the one fixed heading.** What the system looks like when it is done — invariants, quality bar, scope fence (what to aim for AND what to leave alone). Write done-conditions in *checkable* terms wherever the work allows — grep patterns, test commands, "a reviewer can follow the narrative cold" — because a desired state phrased checkably *is its own evidence*: the declarative and operational faces of one contract, and what iterations (and their verifier subagents) measure the work against. The stable name earns its fixedness: it is what a worker landing cold finds without reading the whole document, across every fiber. A separate `## Evidence` section is earned only when the verification protocol is substantial enough to need its own room (a test harness, a measurement procedure).

**Everything after that is earned, and named for what it contains.** "Why directives over modes", "Touch points", "Open questions", "Considered alternatives" — sections crystallize when content does, never from a template. A heading that means something is skimmable by the human, findable by the worker, and linkable — one more node in the network. If a section's honest name would be "Context" or "Notes", its contents belong somewhere else: background that matters gets linked where it is used, wayfinding sits beside the work it serves, chronology goes to `felt history`.

---

## Principles

**Pointers, not snapshots.** `check "grep -r 'old_pattern'"` not "50 files remain." Snapshots go stale; pointers stay valid across iterations. This is the constitutional principle: write what remains true until the work is done.

**Small body, rich network.** A constitution that repeats what a linked fiber already says will drift from it. Push depth outward — findings into sub-fibers, domain background into doc fibers, prior art into links woven into the prose where they do work. The constitution is the hub of a network of understanding, not an archive; both readers follow links on demand.

**The runner's mechanics live in the runner's skill.** Verification cadence, subagent fan-out, exit discipline, handoff surfaces — workers load these from their dispatch skill (e.g. shuttle) every session. Writing them into a constitution duplicates the skill and dates the fiber as models change. The constitution carries only what is specific to *this* work.

**Reshape, don't accrete.** When the desired state evolves — testing surfaces a gap, a meeting changes the priority, a sibling decision lands — rewrite the affected sections so the body still reads as today's desired state. Don't tack on a "Round 2" section; don't add an "Amendments" appendix; don't keep the old framing alongside the new one as a sediment. A green-field constitution will change a lot as it matures, and a mature one will keep changing as reality does. The chronology lives in `felt history`; the kanban-visible summary lives in the outcome; the body lives in *now*.

**Prefer existing systems.** Before designing anything new: can what is there handle this?

**Constraints need reasons.** Bare constraints get creatively circumvented. Include enough *why* that an iteration knows when it applies.

**Scope is a gift.** A clear fence — "only rename, don't refactor" — saves iterations from well-intentioned drift. Explicit scope frees the agent to work confidently within it.

---

## Constitutions that shape artifacts

Some constitutions do not build code — they shape artifacts like documentation or research narratives. These have different rhythms:

- **The desired state is comprehension, not correctness.** "A reviewer can follow the narrative cold" is harder to test than "all tests pass" — but it is the right bar. Evidence for progress: fewer redundant plots, clearer prose, more natural flow.
- **The artifact continues to grow.** Unlike a refactoring (which finishes), a research narrative keeps acquiring nodes. The constitution shapes how growth presents itself, not when growth stops.

---

## Anti-patterns

- **Checklists.** "1. Add X, 2. Add Y" — iterations race through without judgment.
- **Vague done.** "Make it better" — when does iteration stop? What would a reader see?
- **Over-specification.** Prescribing *how* instead of *what*. Trust the agent's taste — instructions written for older, weaker models tend to be too prescriptive for current ones, and stale prescription degrades output that defaults would have gotten right. When in doubt, delete the instruction and see.
- **Snapshot language.** "Currently 50 files" — will be wrong after one iteration.
- **Immutable seed.** Not our shape. The constitution is meant to be edited between iterations; do not treat it as frozen.
- **Numerical convergence.** "Iteration stops when similarity ≥ 0.95" — wrong shape for science. Stop when the desired state's checkable conditions say it has been reached.
- **Decision logs in the body.** "Resolved choices" / "Decisions made" / "Process notes" sections turn the constitution into a process journal. When a question gets answered (in conversation, via `AskUserQuestion`, in a review), fold the answer into the narrative where it is contextually relevant — into the lede, Desired State, or the earned section where it belongs — and let `felt history` carry the chronology. The constitution describes *what is*, not *how we got here*; an "Open Questions" section that has been fully resolved should be deleted, not left as a victory log.
- **Amendment scaffolding.** "Round 2", "v2 deltas", "Updates 2026-05-04 →", "Second round amendments". The same failure as a decision log, played out across edits: the body becomes a sediment of layered framings instead of the current desired state. When the desired state shifts, *reshape* the affected sections — rewrite headings, update prose, drop what no longer applies — so the document still reads as one coherent description of now. The story of how it got here is what `felt history append` and the outcome blurb are for.

---

## When ideating lands here

The ideating rhythm applies to careful interactive thinking; this reference kicks in when the target artifact is specifically a constitution. The diamonds do most of the work — the funnel mechanic used for open-ended exploration is not the primary move here, because there is already one specific artifact being produced. See the Workflow section above for which stances help most at each drafting phase.
