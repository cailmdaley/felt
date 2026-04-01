---
title: Opt-in modtime metadata scans
status: closed
tags:
    - decision
depends-on:
    - felt-perf-simplify
created-at: 2026-03-08T09:53:06.228754+01:00
outcome: Changed storage metadata listing so file modtimes are fetched only when a caller actually needs them. ListMetadata now stays on frontmatter-only parsing without per-file stat calls; ListMetadataWithModTime preserves the old behavior for hook output and JSON paths that surface ModifiedAt. Updated ls, ready, tree, traversal, and hook call sites to choose the cheap path by default, kept body hydration opt-in, and added tests covering the modtime split plus metadata-only exact-title and outcome searches. go test ./... passes.
---

(opt-in-modtime-metadata-scans)=
# Opt-in modtime metadata scans
