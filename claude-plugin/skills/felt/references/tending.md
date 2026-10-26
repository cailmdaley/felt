# Tending the store

A store stays useful when it can be walked and when its todo states mean something. Tidy the region you touch as part of the work; a pass over the whole store is its own task.

## Good shape

- **Open and active mean todo.** A container marked open or active to look important loses its status; its actionable children stay tracked. Close stale todos with an outcome that can be stated now.
- **The tree stays walkable.** Keep the top level under about 20 entries. A parent past 5–7 children gets grouping fibers (`felt nest <child> <parent>`), named for categories future fibers will reuse (`performance`, `setup`), never temporary ones (`misc`).
- **Understanding consolidates upward.** Quick fibers feed a topic fiber, topic fibers feed the entry point. To consolidate a cluster, read the siblings side by side, write the topic fiber as what is true now, and point each source at it with `-o "Consolidated into [[<topic>]]."`, closing the ones that were todos.
- **Knowledge sits where it will be found.** `CLAUDE.md` and `AGENTS.md` load into every session, so they carry commands, paths and pointers to fibers, and stay short. Fibers carry the depth: the architecture, the reasoning, the recipe you will need again.

## Ask first

Before deleting fibers with possible historical value, merging where the synthesis needs domain judgment, moving private fibers across roots, or changing what a project's own fields mean. Prefer the reversible move — nest rather than delete, close rather than remove.

## After reshaping

Run `felt check` for broken links and layout problems (`felt nest` rewrites the links a move would break), and commit each reshape with a message that explains it. If `felt session` reports fibers outside the directory layout, `felt migrate --dry-run` shows how they would be folded in.
