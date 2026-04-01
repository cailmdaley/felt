---
title: Tapestry × ASTRA design
status: open
tags:
    - tapestry
created-at: 2026-03-30T00:28:39.302148+02:00
---

(tapestry-astra-design)=
Bridge between ASTRA (declarative analysis spec), felt (fiber DAG), and the tapestry viewer. Design doc covers: paper-structure spine layout, progressive disclosure (L0 spine → L1 decisions → L2 evidence), delta view (mtime-driven initial visibility), status encoding (shape > color), cross-cutting decisions via evidence tags.

Phase 1: ASTRA decision metadata in tapestry.json export + decision rendering in detail panel.
Phase 2: Spine layout (strict horizontal, vertical-only branches).
Phase 3: Delta view (mtime-driven fog).
Phase 4: Decision drill-in with ASTRA insights.
Phase 5: ASTRA insights bridge.
