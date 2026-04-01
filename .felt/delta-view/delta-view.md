---
title: Delta view
status: open
tags:
    - tapestry
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:39:43.581762+02:00
---

(delta-view)=
Initial visibility driven by evidence mtime recency, not click interaction. Nodes with evidence newer than a configurable threshold (last session timestamp) start revealed; everything else starts fogged. Selecting a node highlights it + all connections; rest fades. Items stay revealed until reviewed/validated, then fold back.

This repurposes the existing fog/reveal mechanic — the change is making initial state data-driven (by recency) instead of interaction-driven (by click).

Agent-as-presenter: reads ASTRA spec + fibers + execution state, generates BLUF entry: 'Since last session: 10 mocks generated. sigma_floor still unresolved — blocking calibration. Next decision needed: mask_strategy.'

The tapestry is a briefing, not a dashboard. The returning researcher needs: (1) what's decided, (2) what changed, (3) what needs attention, (4) feedback — not just data but judgment. Lead with science, not pipeline.
