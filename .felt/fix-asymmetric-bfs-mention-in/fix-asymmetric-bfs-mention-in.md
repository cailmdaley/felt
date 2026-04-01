---
title: Fix asymmetric BFS mention in graph.md
status: closed
tags:
    - ralph:7
depends-on:
    - doc-review-surface-improvements
created-at: 2026-01-13T01:24:22.680675851+01:00
closed-at: 2026-01-13T01:24:42.301706393+01:00
outcome: Removed '(BFS)' from upstream command docs in graph.md. The algorithm is an implementation detail users don't need to know; what matters is that traversal is transitive. This makes upstream/downstream documentation symmetric.
---

(fix-asymmetric-bfs-mention-in)=
# Fix asymmetric BFS mention in graph.md
