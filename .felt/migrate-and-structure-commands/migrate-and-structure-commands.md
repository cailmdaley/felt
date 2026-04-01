---
title: Migrate and structure commands
status: closed
tags:
    - constitution
created-at: 2026-04-01T02:12:19.484465+02:00
outcome: Added felt migrate, nest, and unnest on top of storage-level subtree moves and flat-file migration. Exact ID matches now win over broader prefix matches, so top-level fibers remain addressable after nesting.
---

(migrate-and-structure-commands)=
# Migrate and structure commands

Implemented storage helpers to move a fiber subtree and rewrite dependency IDs across the repository. Added `felt migrate --dry-run|--dir`, `felt nest`, and `felt unnest`, then covered the new behavior with storage and integration tests, including migration of legacy flat files and exact-ID resolution in nested trees.
