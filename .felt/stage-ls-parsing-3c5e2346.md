---
title: stage ls parsing
status: closed
tags:
    - decision
depends-on:
    - felt-perf-simplify-34506bca
created-at: 2026-03-06T15:21:16.086751+01:00
outcome: Added staged parsing to internal/felt with metadata-only read/list paths, switched graph/hook/ready/rm/cycle-check callers to metadata scans, made felt ls filter on metadata first and hydrate bodies only for body-search candidates, and fixed ls --json --body to emit hydrated body text. Preserved body data on write paths by re-reading full fibers before mutation where needed. Verified with go test ./..., go test -tags integration ./cmd, and timing spot-checks on ls/show/hook paths.
---
