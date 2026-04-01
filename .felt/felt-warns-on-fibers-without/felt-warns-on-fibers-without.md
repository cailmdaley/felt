---
title: felt warns on fibers without frontmatter
status: closed
tags:
    - felt-cli
created-at: 2026-01-17T14:26:26.950335+01:00
closed-at: 2026-01-17T21:22:10.277455+01:00
outcome: Deferred. Current behavior (warning on malformed files) is fine. Tolerant parsing would be nice-to-have but not blocking.
---

(felt-warns-on-fibers-without)=
Got repeated warnings:

```
warning: failed to parse remote-sessions-35dbe9b6.md: file must start with ---
```

The fiber file starts with `# Title` instead of YAML frontmatter.

**Options:**
1. Fix the file to have proper frontmatter
2. Make felt more tolerant (extract title from `# Heading` if no frontmatter)
3. Both — tolerant parsing + migration tool
