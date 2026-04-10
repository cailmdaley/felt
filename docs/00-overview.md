name: "Felt × ASTRA: Week of March 31"
description: Overview of the felt v2 work for the Lightcone team — what we built, what we learned, what's next.
---

# Felt × ASTRA: Week of March 31

After the UX meeting on March 31 with François, Liam, and Alexandre, this week was a building sprint: testing whether felt's fiber system could carry ASTRA structure in a real research environment, and whether AI agents could be taught to use it.

## What we built

- **felt v2** — Directory-based fibers with ASTRA-compatible frontmatter. Consolidated CLI (~22 → ~10 commands). `felt export --format astra` produces valid specs from the fiber tree. Deployed across three projects: pure-eb (1,130 fibers), portolan, and felt itself.

- **Context injection ladder** — Four levels for getting AI agents to actually use felt during sessions: static instructions (CLAUDE.md), session hooks (fiber state injection), PreToolUse gate (deny tools until skill activated), and an async Stop conscience (small model nudges toward filing). The gate works definitively; the conscience is experimental.

- **Citation graph** — Built a working ASTRA-style citation graph for the UNIONS B-modes paper. 51 citations audited against source papers, converted into claim/evidence structures. Surfaced a gap in the ASTRA spec: unpublished local manuscripts need first-class evidence support (ASTRA issue #53).

- **Meeting infrastructure** — Portolan's MeetingBridge now produces continuously-updated live-brief.md documents during research meetings, with ASTRA provenance, clickable evidence, and promotion into the fiber DAG. 22 fibers closed under the meeting constitution.

- **MySTRA viewer** — Barycenter layout for the analysis DAG, status glyphs, fullscreen detail panel, and a cluster of gotcha fixes from real use. Detached mystra-theme as a standalone LightconeResearch repo.

- **Formalization model** — A 3×3 matrix (annotated/formalized/analysis-grade × decision/computation/finding) that clarifies what "formalization" means at each level of rigor.

## The proposition

Everything is the same schema at different levels of fill. A bare title is a fiber. Add a `decisions:` block and it's formalized. Mark it `analysis-grade: true` and it's part of the scientific record. The same data, rendered differently:

- **As a wiki** — annotated fibers rendered as linked markdown pages (what you're reading now)
- **As an analysis graph** — formalized fibers with data-flow edges, rendered as a navigable DAG
- **As a publishable record** — analysis-grade fibers forming the spine of a paper's methodology
- **As an execution DAG** — computation fibers with recipes, renderable as a Snakemake/Dagster pipeline

The view is up to the user. The schema doesn't change. Plugins and themes determine how the same structure appears — MySTRA renders the analysis view, the document renders the narrative view, and felt's containment plus indexed citations keep the exploratory substrate navigable.

This is the core bet: if you accumulate structured context as you work (not after), the same substrate supports exploration, formalization, and publication. The 3×3 model makes the ladder explicit.

## Documents in this site

- **The 3×3 formalization model** — How fibers move from breadcrumbs to analysis-grade structure: three tiers × three kinds.
- **Felt as ASTRA plugin** — The full write-up for the Lightcone team: what felt is, how it relates to ASTRA, and the context injection problem.
- **Citation audit** — A working ASTRA analysis: the B-modes citation network with DOI-backed evidence, rendered with full MySTRA structure.
- **Meeting interface** — The design and implementation of Portolan's meeting-to-ASTRA pipeline.
- **Ralph constitution example** — A working constitution spec, showing how autonomous iteration loops are directed.
