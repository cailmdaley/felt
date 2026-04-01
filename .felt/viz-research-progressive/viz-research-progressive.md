---
title: 'Viz research: progressive disclosure + status encoding'
tags:
    - tapestry
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:29:45.015856+02:00
outcome: |-
    Research agents gathered design principles for the tapestry viewer:

    **Shneiderman**: Overview first (L0 verdict), zoom (click spine → L1 decisions), filter (status chips), details-on-demand (hover/expand → L2 evidence).

    **NNGroup**: Max 3 disclosure levels. Collapsed headers must have information scent. Accordions only when sections are independent. Focus+context preferred over drill-down for DAGs.

    **Minto/BLUF**: L0 badge IS the verdict — no expansion needed. L1 decisions are the arguments. L2 is the evidence. Minto MECE: L1 nodes should be non-overlapping and collectively sufficient.

    **Status encoding**: Shape > color (8% male colorblindness). Four states: ✓ resolved (filled circle, teal), ○ open (hollow, gray), ? suspicious (dashed, amber), ✕ blocked (crossed, rust). Grayscale test required.

    **Metro map**: Horizontal spine + vertical branches. elkjs layered with direction DOWN + layerId 0 for tier:1. nf-core pipelines use hand-drawn metro maps — automated subway rendering is unsolved.

    **ABT narrative**: And/But/Therefore for auto-generated summaries. ~20% context, ~40% results, ~40% interpretation.

    Sources: NNGroup progressive-disclosure, Shneiderman 1996 IEEE, Tufte data-ink, Datawrapper colorblindness guide, nf-core workflow diagram guidelines.
---

(viz-research-progressive)=
# Viz research: progressive disclosure + status encoding
