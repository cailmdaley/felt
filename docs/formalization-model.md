name: "The 3×3 formalization model"
description: "How fibers move from breadcrumbs to analysis-grade ASTRA structure: three tiers × three kinds."
---

# The 3×3 formalization model

How fibers move through structured formalization. Three tiers of rigor, three kinds of content. Formalization is guided by real structure, not by closure state or importance.

## The proposition

The UX meeting on March 31 surfaced a core tension: when does freeform exploration become formal knowledge? François argued formalization should happen after, as a separate step. Liam argued for mandating ASTRA structure even during exploration. The 3×3 model is our answer: a deterministic ladder that fibers climb as understanding crystallizes, without forcing structure before it's real.

The key insight: *everything is the same schema at different levels of fill.* A bare name is valid. A fiber with a decisions block is formalized. The same fiber with `analysis-grade: true` is part of the scientific argument. No separate "astrify" step — the structure accretes in place.

This means the same system can render itself as a wiki (annotated fibers), as an analysis graph (formalized fibers with data flow), or as a publishable record (analysis-grade fibers). The view changes; the data doesn't.

## Three tiers

| Tier | What it means | Test |
|------|--------------|------|
| **Annotated** | Any valid felt fiber. Name, outcome, body, tags, links in any combination. | Does the fiber exist? |
| **Formalized** | At least one well-formed ASTRA object in frontmatter. | Could `felt export --format astra` emit this? |
| **Analysis-grade** | `analysis-grade: true` in frontmatter. Human-validated, part of the real scientific argument. | Has a human staked their name on it? |

## Three kinds

| Kind | Core ASTRA fields | What it captures |
|------|-------------------|-----------------|
| **Decision** | `decisions` block with options, default, excluded reasoning | A choice between alternatives, with what was rejected and why |
| **Computation** | `inputs` + `outputs`, optional `recipe` | A transformation that consumes data and produces results |
| **Finding** | `insights` with claim + evidence pointers | A concrete claim backed by evidence that reduces uncertainty |

## The 3×3 table

| Kind | Annotated | Formalized | Analysis-grade |
|------|-----------|------------|----------------|
| **Decision** | A note that blind A may become the fiducial choice | `decisions:` block with real options, default, and excluded reasoning | Collaboration-validated, relied upon in downstream analysis |
| **Computation** | A breadcrumb about binning tests | Concrete `inputs:` and `outputs:` for the comparison, with recipe | Result is part of the real analysis argument |
| **Finding** | A note that blind independence may hold | `insights:` claim with evidence pointers | Human-validated, incorporated into the scientific case |

## Formalization threshold

Formalize when structured content is real enough to write without inventing:
- A decision has actual options you considered
- A computation has concrete inputs and outputs
- A finding has a claim with evidence

This can happen *before* the work is finished — outcome is not a prerequisite. Write inputs while scripts run. Keep it annotated if it's still just a note or question.

## Why this matters for the stack

The 3×3 model resolves several of the meeting's open questions:

**The funnel problem.** You fan out into 30 experiments. Three matter. The funnel is the transition from annotated → formalized → analysis-grade. Most fibers stay annotated (breadcrumbs). Some get formalized (they have real structure). Few reach analysis-grade (they're part of the argument). The funnel is not a separate operation — it's the natural lifecycle of a fiber.

**The exploration–formalization debate.** You don't choose between exploring freely and maintaining structure. You explore (annotated fibers, filed as you go). Structure accretes when it's real (formalization). Human sign-off happens when it matters (analysis-grade). The three tiers coexist.

**Progressive disclosure in the viewer.** The tier determines what the viewer shows. Analysis-grade fibers form the spine. Formalized fibers fill in methodology. Annotated fibers are available on demand but don't clutter the primary view.

**Agent context injection.** The conscience hook can now ask a specific question: "You just made a decision — did you record the excluded alternative?" The 3×3 model gives the nudge a vocabulary. Not "did you file?" but "this looks like a decision at the annotated tier — does it have enough structure to formalize?"

## Examples from the pure-eB analysis

The pure-eB B-mode analysis has 1,130 fibers. Here's how the tiers distribute:

- **~1,100 annotated**: breadcrumbs, process notes, reviewer comments, bug reports
- **~20 formalized**: fibers with ASTRA decisions, inputs/outputs, or findings
- **~5 analysis-grade**: the spine of the paper — estimator choice, covariance method, PSF model, scale cuts, main conclusion

The viewer should let you navigate from the 5-node spine to the 20-node methodology graph to the full 1,130-fiber archive. Same data, different zoom levels.
