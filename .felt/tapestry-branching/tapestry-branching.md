---
title: Tapestry branching
status: closed
tags:
    - tapestry
created-at: 2026-03-14T19:40:15.587891+01:00
closed-at: 2026-03-14T19:40:40.651585+01:00
outcome: 'Progressive disclosure in tapestry DAGs should be governed by bounded reveal, not a universal tree arity rule. Prefer a soft target of 2-4 visible children per navigational node, with 3 as the default and 5+ as a shaping trigger. Grouping nodes should be ordinary tapestry fibers tagged/documented as navigational containers: no evidence required, excluded from truth-bearing summaries, but still part of dependency paths when they express traversal structure. New fibers should attach at filing time to the nearest semantic parent using a simple rule set; later shaping passes should remain available to split overloaded neighborhoods and insert grouping nodes without changing causal computation edges. Preserve distinction between semantic/causal edges and navigational containment: if forced grouping rewrites real causality, the tapestry becomes misleading. Best model is a layered DAG: truth edges stay faithful; optional grouping nodes compress presentation. For staleness, grouping nodes should not terminate propagation. They can either show derived child status (fresh/stale/mixed/no-evidence) or be treated as transparent for stale traversal, but downstream evidence checks must continue through them.'
---

(tapestry-branching)=
# Tapestry branching
