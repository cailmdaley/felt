---
title: Go ASTRA parser for export
tags:
    - decision
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:28:55.439879+02:00
outcome: 'Minimal Go YAML parser (~100 lines) for astra.yaml decisions in felt''s tapestry export. Reads top-level + per-analysis decisions, flattens into []Decision with options. Wires evidenceIds via tapestry_nodes field or evidence:{decision_id} tags. Zero Python dependency in export path. Alternative considered: shelling out to astra info --json (rejected — adds Python dep, fails if astra not installed).'
---

(go-astra-parser-for-export)=
# Go ASTRA parser for export
