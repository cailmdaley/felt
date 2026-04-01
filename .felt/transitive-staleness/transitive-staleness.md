---
title: Transitive staleness
status: closed
created-at: 2026-03-14T21:47:06.950354+01:00
closed-at: 2026-03-14T21:47:52.423649+01:00
outcome: ComputeStaleness now traverses upstream transitively through nodes without evidence, stopping on newer evidence-bearing ancestors and guarding against cycles with a visited set. Added tests covering stale propagation through one grouping node, freshness when the transitive ancestor is older, and stale propagation across multiple no-evidence grouping nodes.
---

(transitive-staleness)=
# Transitive staleness
