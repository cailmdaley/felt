---
name: "The formalization model"
description: "How fibers climb three tiers of rigor: Annotated, Formalized, Tempered."
---

# The formalization model

How fibers move through structured formalization. Three tiers of rigor. Formalization is guided by real structure, not by closure state or importance.

## The proposition

Felt fibers climb three tiers: Annotated (any valid fiber), Formalized (at least one well-formed ASTRA object in frontmatter), and Tempered (`tempered: true`, human-validated). Each tier is a deterministic test. Formalization happens when structure is real enough to write without inventing; temper happens after human review.

The key insight: *everything is the same schema at different levels of fill.* A bare name is valid. A fiber with a decisions block is formalized. The same fiber with `tempered: true` is part of the scientific argument. No separate "astrify" step; the structure accretes in place.

This means the same system can render itself as a wiki (annotated fibers), as an analysis graph (formalized fibers with data flow), or as a publishable record (tempered fibers). The view changes; the data doesn't.

An earlier proposal crossed this ladder with a second axis of fiber *kinds* (decision / computation / finding), giving a 3×3 grid. The Lightcone meeting on 2026-04-04 dropped the kind axis: at the annotated tier it adds nothing, and at the formalized tier the ASTRA fields already tell you which kind of fiber it is. Kind is an observation, not a classification.

## Three tiers

| Tier | What it means | Test |
|------|--------------|------|
| **Annotated** | Any valid felt fiber. Name, outcome, body, tags, links in any combination. | Does the fiber exist? |
| **Formalized** | At least one well-formed ASTRA object in frontmatter. | Could `felt export --format astra` emit this? |
| **Tempered** | `tempered: true` in frontmatter. Human-validated, part of the real scientific argument. | Has a human staked their name on it? |

## Kind as observation

A fiber's shape is whatever its populated ASTRA fields make it.

- `decisions` populated: the fiber is acting as a **decision**, a choice between alternatives with what was rejected and why.
- `inputs` and `outputs` populated: the fiber is acting as a **computation**, a transformation that consumes data and produces results.
- `insights` populated: the fiber is acting as a **finding**, a concrete claim backed by evidence that reduces uncertainty.

A single fiber can play any combination of those roles. There is no "type" to set.

## Formalization threshold

Formalize when structured content is real enough to write without inventing:
- A decision has actual options you considered
- A computation has concrete inputs and outputs
- A finding has a claim with evidence

This can happen *before* the work is finished; outcome is not a prerequisite. Write inputs while scripts run. Keep it annotated if it's still just a note or question.

## Why this matters for the stack

The tier ladder resolves several of the meeting's open questions:

**The funnel problem.** You fan out into 30 experiments. Three matter. The funnel is the transition from annotated → formalized → tempered. Most fibers stay annotated (breadcrumbs). Some get formalized (they have real structure). Few reach tempered (they're part of the argument). The funnel is not a separate operation; it's the natural lifecycle of a fiber.

**The exploration–formalization debate.** You don't choose between exploring freely and maintaining structure. You explore (annotated fibers, filed as you go). Structure accretes when it's real (formalization). Human sign-off happens when it matters (tempered). The three tiers coexist.

**Progressive disclosure in the viewer.** The tier determines what the viewer shows. Tempered fibers form the spine. Formalized fibers fill in methodology. Annotated fibers are available on demand but don't clutter the primary view.

**Agent context injection.** The conscience hook can ask a specific question: "You just made a decision; did you record the excluded alternative?" The tier ladder gives the nudge a vocabulary. Not "did you file?" but "this looks like a decision at the annotated tier; does it have enough structure to formalize?"

