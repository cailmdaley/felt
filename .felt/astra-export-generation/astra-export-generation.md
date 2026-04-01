---
title: ASTRA export generation
status: closed
tags:
    - felt
    - astra
depends-on:
    - astra-frontmatter-plumbing
    - felt-v2-constitution
created-at: 2026-04-01T01:48:49.546706+02:00
outcome: Implemented felt export in astra mode by walking the fiber directory tree into nested analyses YAML, exporting ASTRA-compatible fields from frontmatter, skipping fibers without substantive ASTRA content, and covering the CLI path with unit and integration tests. The generated file defaults to astra.yaml at the project root and preserves directory nesting via structural parent nodes when needed.
---

(astra-export-generation)=
# ASTRA export generation
