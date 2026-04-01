---
title: 'Multi-tapestry design: walkable directories, aggregated views, connected-component move'
status: open
tags:
    - decision
created-at: 2026-01-18T14:34:51.203906+01:00
---

(multi-tapestry-design-walkable)=
## Context

Git's directory discovery model: run `git status` anywhere and it finds the repo above. Want similar for felt, plus visibility into child tapestries and cross-tapestry moves.

## Decisions

1. **No cross-tapestry dependencies** — too complicated. Tapestries stay self-contained.

2. **Move = connected component** — `felt move <id> <target>` moves the fiber plus all transitively connected fibers (upstream + downstream). Atomic relocation.

3. **Aggregated views only** — `felt ls --all` shows fibers from parent + children + global tapestries in one view, but they remain separate. Can't reference across.

4. **Discovery**: Find tapestries walking up (exists), scanning children (new), and checking global `~/loom/.felt/` (new).

## Open questions

- How deep to scan for children? Configurable? Default depth?
- What happens on ID collision during move?
- Should `felt ls` show a hint about other tapestries, or only `--all`?
