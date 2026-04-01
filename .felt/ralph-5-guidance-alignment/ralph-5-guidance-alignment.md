---
title: Ralph 5 guidance alignment
depends-on:
    - felt-v2-constitution
created-at: 2026-04-01T02:05:29.878271+02:00
outcome: Aligned generated agent guidance and public docs with the consolidated CLI surface. Added a docs test that scans generated snippets and bundled skills for retired command spellings, updated hook/setup output to mention path IDs and ASTRA export, and documented ASTRA frontmatter/search/export in the README. Verified with go test ./cmd ./internal/felt ./internal/tapestry, go test -tags integration ./cmd, and grep over cmd/skills for retired commands.
---

(ralph-5-guidance-alignment)=
# Ralph 5 guidance alignment
