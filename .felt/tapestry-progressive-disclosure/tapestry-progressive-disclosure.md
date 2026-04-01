---
title: Tapestry progressive disclosure
status: closed
tags:
    - tapestry
created-at: 2026-03-14T23:48:10.033217+01:00
outcome: |-
    Three changes shipped:

    1. **Branching discipline** — 2-4 children per node, 5+ triggers reshaping. Grouping nodes carry summaries, not empty. Documented in felt skill references/tapestry.md and references/archiving.md (reshaping section).

    2. **Transitive staleness** — ComputeStaleness walks through no-evidence nodes (grouping nodes are transparent). Fixed in both felt Go (evidence.go) and portolan TS (EvidenceReader.ts). Tests cover 1-hop, 2-hop, and fresh cases.

    3. **File-link copying** — felt tapestry export finds file paths in fiber body/outcome, copies to files/ with flattened names (/ → _), rewrites paths in exported JSON. Static viewer resolves flat names via TapestryStaticFileModal.resolveFileUrl().

    Also: /tapestry skill absorbed into /felt as reference files. claude-desktop reference removed.
---

(tapestry-progressive-disclosure)=
# Tapestry progressive disclosure
