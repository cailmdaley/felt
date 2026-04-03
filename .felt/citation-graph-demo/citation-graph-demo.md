---
title: Citation graph demo
status: closed
tags:
    - felt
    - astra
    - example
    - lightcone
depends-on:
    - astra-semantics
    - citation-audit
    - unpublished-evidence
created-at: 2026-04-02T19:39:34.980760555+02:00
closed-at: 2026-04-02T19:42:30Z
outcome: 'Imported a compact three-fiber case study into the felt repo for Lightcone discussion: semantics, a real literature-backed citation graph, and the unpublished-document evidence edge case. Together they show both the practical value of ASTRA-style citation graphs and the remaining schema/authoring gaps.'
---

(citation-graph-demo)=
# Citation graph demo

Imported from the UNIONS B-modes paper workflow as a concrete Lightcone-ready example of ASTRA-style citation graphs in active research.

The three fibers to show are:

- `astra-semantics`: the key semantic pivot, namely that the manuscript statement is the claim and the cited-source anchor is the evidence.
- `citation-audit`: a real working citation graph built from paper sentences, published DOIs, and local companion-manuscript evidence.
- `unpublished-evidence`: the schema gap the workflow exposed, plus the upstream ASTRA issue proposing a `document + commit + quote` evidence shape.

The main lessons from the case study are:

- The graph is genuinely useful for manuscript QA because it forces every important citation-bearing statement to resolve to traceable source evidence.
- Audit logs are not enough; the valuable object is the claim-to-evidence graph itself.
- Rich ASTRA content is easier to author by direct frontmatter edits than by large CLI flag surfaces.
- Unpublished local manuscripts are common in real science workflows and need first-class support.
