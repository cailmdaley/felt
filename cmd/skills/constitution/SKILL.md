---
name: constitution
description: >
  Draft a ralph constitution — a fiber spec describing a desired state for
  autonomous iteration. Study the problem space, shape the spec interactively,
  then launch the ralph loop. Use for any work where adaptation matters more
  than a fixed plan: science, refactoring, exploration, creative work.
  Triggers: "constitution", "constitute", "ralph spec", "set up a ralph",
  "create a ralph", "ralph fiber".
---

# Constitution

A constitution is a design document with trust built in. Like a governmental constitution, it lays out principles and aspirations — not specific laws, not the current state of affairs. It's designed to outlast any single agent or iteration and remain valid as the world changes around it. A good constitution never says "50 files remain" because that's a snapshot that goes stale; it says "check `grep -r 'old_pattern'`" because that's a principle that stays true until the work is done.

Constitutions don't prescribe steps. They describe what the system looks like when it's right — the desired state, in both senses of the word. Nothing in the constitution should become confusing or unnecessary as the desired state is reached. Whoever works from it surveys reality, reasons about the gap, and decides what's highest value. In a ralph loop, each iteration does this with fresh context.

This matters most in science and exploratory work, where each decision is informed by the result just before it. A plan assumes you know the path; a constitution trusts the agent to find it — with taste, judgment, and fresh eyes each time.

**Separation of context: if you craft, you never do the work yourself.**

## Workflow

1. **Study** — Read relevant files, understand existing patterns. This informs the *constitution*, not implementation. The goal is pointers that iterations will follow.

2. **Draft** — Create the fiber with status `open`:
   ```bash
   felt add "Constitution title" -s open
   ```
   Then edit the body in `.felt/<id>.md`. Fill in what you can — don't wait until it's perfect.

3. **Refine** — Show the draft, get feedback, revise. Use AskUserQuestion for structured choices. Repeat until it feels solid.

4. **Launch** — When approved:
   ```bash
   <base>/scripts/ralph <fiber-id> [--backend claude|codex] [-- extra-flags...]
   ```
   Add `-- --chrome` for visual/frontend work.

Session: `ralph-<fiber-id>`. Attach: `tmux attach -t ralph-<fiber-id>`.

## Crafting Constitutions

### What goes in one

A constitution needs enough structure that an iteration landing cold can orient itself, and enough freedom that it can adapt. Common sections — use what fits, skip what doesn't, add what's missing:

```markdown
## Desired State
What the system looks like when it's done. Invariants, quality bar,
done-conditions. Fence the scope — what to aim for AND what to leave alone.

## Context
File paths, existing patterns, architectural constraints. Things iterations
need to *find* but not *achieve*.

## Skills
Which skills to activate before working (e.g., /snakemake).

## Evidence
How to check progress — commands, test suites, grep patterns. Pointers to
the ground truth that iterations measure themselves against.

## Open Questions
Uncertainties the user should weigh in on. Iterations add to this; the user
resolves between loops.
```

### Principles

**Constitution, not plan.** Say what the system looks like when it's right. Never describe the current state — anything that becomes false or irrelevant as work progresses doesn't belong. If a section would be outdated after one iteration, it's a snapshot — replace it with a pointer.

**Pointers, not snapshots.** "Check `grep -r 'old_pattern'`" not "50 files remain." Snapshots go stale; pointers stay valid across iterations. This is the constitutional principle: write what remains true until the work is done.

**Prefer existing systems.** Before designing anything new: can what's there handle this?

**Constraints need reasons.** Bare constraints get creatively circumvented. Include enough *why* that an iteration knows when it applies.

**Scope is a gift.** A clear fence — "only rename, don't refactor" — saves iterations from well-intentioned drift. Explicit scope frees the agent to work confidently within it.

### Constitutions that shape artifacts

Some constitutions don't build code — they shape artifacts like tapestries, documentation, or research narratives. These have different rhythms:

- **The desired state is comprehension, not correctness.** "A reviewer can follow the narrative cold" is harder to test than "all tests pass" — but it's the right bar. Evidence for progress: fewer redundant plots, clearer prose, more natural flow.
- **The artifact continues to grow.** Unlike a refactoring (which finishes), a research tapestry keeps acquiring nodes. The constitution shapes how growth presents itself, not when growth stops.

### Anti-patterns

**Checklists.** "1. Add X, 2. Add Y" — iterations race through without judgment.

**Vague done.** "Make it better" — when does iteration stop?

**Over-specification.** Prescribing *how* instead of *what*. Trust the agent's taste.
