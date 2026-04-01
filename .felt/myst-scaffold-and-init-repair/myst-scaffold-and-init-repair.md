---
title: MyST scaffold and init repair
status: closed
tags:
    - felt
    - astra
depends-on:
    - felt-v2-constitution
created-at: 2026-04-01T02:00:31.555278+02:00
outcome: Made felt init idempotent for .felt/ + myst.yml, and made saved fibers persist a MyST anchor/body scaffold by default. edit --body now treats the generated scaffold as empty initial content, so first real body writes stay non-destructive in CLI semantics. Added unit + integration coverage for myst config repair, default body scaffolding, comment anchoring, and hydrated body output.
---

(myst-scaffold-and-init-repair)=
# MyST scaffold and init repair
