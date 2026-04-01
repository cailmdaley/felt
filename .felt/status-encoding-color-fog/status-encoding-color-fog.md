---
title: 'Status encoding: color + fog'
status: open
tags:
    - tapestry
depends-on:
    - tapestry-astra-design
created-at: 2026-03-30T00:39:59.653629+02:00
---

(status-encoding-color-fog)=
The existing staleness colors (teal fresh, rust stale, gray no-evidence) are distinctive and work well spatially. The shape-first (icon) approach from viz research conflicts with this — icons are small and the colors do most of the perceptual work already.

Proposal: keep the distinctive staleness colors as the primary encoding. Use fog opacity as the secondary channel (fogged = not yet reviewed, revealed = validated). Shape/icon is tertiary — only needed for the suspicious/blocked states that the current color palette doesn't cover.

Open question: how to encode the pipeline-ok-but-science-suspicious state. Could be a dashed ring around the node, or a second smaller indicator dot. The color stays the staleness color; the ring/dash conveys epistemic doubt.
