---
title: Stay vanilla TS, defer React
tags:
    - decision
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:28:48.337567+02:00
outcome: 'Tapestry viewer stays vanilla TS for now. React + React Flow + elkjs deferred to later phase. Motivation: layout is already working (d3-force with tier:1 pinning), detail panel is the immediate work surface, and a framework migration would delay the ASTRA integration that matters. Prism-UI removed ReactFlow on 2026-03-04 in favor of a document layout — so the ''reuse Prism-UI components'' argument is weaker than expected (data types transfer, layout architecture doesn''t). When React migration happens: React Flow + elkjs for deterministic spine layout, import Prism-UI core/lib/astra/ types.'
---

(stay-vanilla-ts-defer-react)=
# Stay vanilla TS, defer React
