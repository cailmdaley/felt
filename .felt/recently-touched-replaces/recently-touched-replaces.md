---
title: Recently Touched replaces Recently Closed in hook
status: closed
tags:
    - decision
depends-on:
    - read-time-fidelity-modes-for
created-at: 2026-02-11T00:37:23.092834864+01:00
outcome: Session hook now shows 5 most recently modified fibers (by file mod time) instead of 5 most recently closed. Captures statusless fibers that were commented on, edited, etc. — not just closed ones. Added ModifiedAt field to Felt (populated from file stat, not persisted). Subsumes the old Recently Closed section since closed fibers have recent mod times too. Status icons distinguish fiber states; outcomes shown where present.
---

(recently-touched-replaces)=
# Recently Touched replaces Recently Closed in hook
