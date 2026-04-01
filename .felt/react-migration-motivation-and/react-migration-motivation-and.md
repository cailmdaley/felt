---
title: 'React migration: motivation and implementation'
status: open
tags:
    - tapestry
depends-on:
    - stay-vanilla-ts-defer-react
created-at: 2026-03-30T00:29:30.461542+02:00
---

(react-migration-motivation-and)=
## Motivation

**elkjs** solves deterministic layout. Current d3-force is non-deterministic (different every reload), can't enforce column constraints (sub-nodes drifting away from parent section). elkjs layered algorithm with layerId constraints pins tier:1 to spine, arranges sub-nodes in vertical strips below. This is the layout fix — it's independent of React.

**React Flow** replaces ~2k lines of hand-rolled d3 interaction code (TapestryDagGraph.ts, TapestryDagRendering.ts, TapestryDagVisibility.ts). Gives pan, zoom, minimap, node selection, drag, edge routing, custom node rendering out of the box. It takes positions from elkjs and handles everything after. Not required for the layout fix, but a natural pairing.

**React** enables import of Prism-UI core/lib/astra/ types and utils. Also: component model, state management (Zustand), and alignment with the broader LightconeResearch stack.

## Implementation path

1. New Vite + React app in portolan/ (replaces vanilla TS)
2. React Flow for graph rendering with custom SpineNode and EvidenceNode types
3. elkjs for layout: direction DOWN, layerId 0 for tier:1, sub-nodes in subsequent layers
4. Import Prism-UI core/lib/astra/ (types.ts, transform.ts, insightUtils.ts)
5. Port fog/reveal as React Flow node opacity/filter animations
6. Port detail panel as React component reusing DecisionRow/InsightCard patterns

## Key references
- elkjs layerId constraints: https://eclipse.dev/elk/blog/posts/2023/23-01-09-constraining-the-model.html
- React Flow + elkjs example: reactflow.dev/examples/layout/elkjs
- Prism-UI removed ReactFlow 2026-03-04 (document-layout-redesign.md) — their use case is different (document editor vs DAG viewer)
- Portolan current layout code: TapestryDagLayout.ts (d3-force, 800-tick warm-up, fx/fy pinning)
