---
title: Metadata scans stop at frontmatter
tags:
    - decision
depends-on:
    - felt-perf-simplify-34506bca
created-at: 2026-03-08T09:40:56.540075+01:00
outcome: Changed metadata-only storage reads to stream just YAML frontmatter instead of os.ReadFile on the whole fiber. ListMetadata and ReadMetadata now stop at the closing --- delimiter, reuse a shared frontmatter parser, and keep full reads unchanged. Added tests for frontmatter extraction and error cases. go test ./... passed, and the constitution timing commands for felt ls, felt ls -t decision, and felt ls --recent 20 were rerun after the change.
---
