---
title: Goreleaser cross-repo push needs PAT secret
status: closed
tags:
    - decision
depends-on:
    - professional-open-source
created-at: 2026-01-31T03:26:23.545538+01:00
closed-at: 2026-01-31T03:26:23.545545+01:00
outcome: 'Default GITHUB_TOKEN only has access to current repo. Goreleaser brews section can''t push formula to homebrew-tap without PAT. Options: (1) Add PAT as repo secret (HOMEBREW_TAP_TOKEN), update workflow to use it. (2) Manual formula push after release. Chose manual for v0.1.0; PAT setup deferred.'
---

(goreleaser-cross-repo-push)=
# Goreleaser cross-repo push needs PAT secret
