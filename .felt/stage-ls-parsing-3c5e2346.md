---
title: stage ls parsing
status: closed
tags:
    - decision
depends-on:
    - felt-perf-simplify-34506bca
created-at: 2026-03-06T15:21:16.086751+01:00
outcome: 'Added staged parsing to internal/felt with metadata-only read/list paths, switched graph/hook/ready/rm/cycle-check callers to metadata scans, and made felt ls parse bodies only when --body is used with a query. Preserved body data on write paths by re-reading full fibers before mutation where needed. Verified with go test ./... and spot timings: felt ls 0.176s, felt ls -t decision 0.009s, felt ls --recent 20 0.008s, felt show chain-9 0.007s, felt hook session 0.009s.'
---
