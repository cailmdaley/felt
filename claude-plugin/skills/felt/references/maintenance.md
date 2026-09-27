# Maintenance

Fibers are cheap to create, so a store naturally accumulates stale todos, duplicated findings, orphaned leaves, and top-level sprawl. The user should not have to manage that entropy. The aim is not a tidy archive but an environment that orients the next session quickly: current work is visible, old work has outcomes, knowledge has been composted upward, and the tree has enough shape to walk.

## Shape to keep

**Open and active mean todo.** They do not mean important, reference, or canonical. `active` is current attention, `open` a real unresolved todo or question, statusless is ordinary documentation and containers, `closed` carries a strong outcome. A container fiber that is open/active is usually not itself a todo: demote it and keep the actionable children tracked.

**The tree stays walkable.** Top level is for roots and large buckets and should stay under about 20 entries. Within a subtree, a parent with more than 5–7 direct children probably wants grouping nodes. Deeper and narrower beats flat.

**Understanding composes upward.** `quick fiber → doc/reference fiber → root fiber / CLAUDE.md pointer`. Extract the lesson, decision, or durable pattern; leave chronology to the git log.

## When to garden

Whenever you notice the mess — the best moment is right after a session surface shows what drifted. In particular:

- `felt session` shows `## Attention`;
- more than ~20 root-level fibers, or a parent with 5+ children in natural subgroups;
- open/active fibers that are old, stale, or containers rather than todos;
- 3+ fibers circling the same idea, or a recurring gotcha that belongs in a doc fiber;
- `felt check` reports issues.

Take the obvious small fix now, without asking; don't let maintenance block urgent user work.

## Authority

Safe to do proactively:

- nest leaves under an obvious existing bucket, or create a bucket when several leaves plainly share a category;
- demote containers from open/active; close test, scratch, or stale todos whose outcome is obvious;
- consolidate settled small fibers into a doc fiber;
- add or repair wikilinks whose relationship is plain;
- commit the reshape with a message that explains it.

Pause or ask before deleting fibers with possible historical value, merging fibers when the synthesis needs domain judgment, moving sensitive or private fibers across roots, changing project-owned YAML semantics, substantially rewriting a root fiber's argument, or cleaning a large area while the user waits on unrelated work. When in doubt, prefer reversible moves: nest rather than delete, close with an outcome rather than remove, commit before large reshapes.

## Moves

**Triage status.** `felt ls -s open`, `felt ls -s active`. For each: is it a current todo? If it has children, is the parent itself actionable? If it is old, can the outcome be stated now? Close with an outcome that teaches:

```bash
felt edit <id> -s closed -o "Decision/finding in one sentence."
```

**Reduce top-level sprawl.** `felt tree -L 1`, then `felt nest <leaf> <bucket>`. Create a bucket only when it names a real category future fibers will reuse, with a short body saying what belongs there. Broad but not vague (`performance`, `setup`, `history`), never temporary (`misc`, `cleanup`).

**Compost clusters.** Read the siblings horizontally first — a doc fiber made from one leaf misses the shape. Then:

```bash
felt add <topic> "Topic reference" -b "Current understanding..."
felt edit <old-id> -s closed -o "Consolidated into [[<topic>]]."
```

The doc fiber says what is true now; the old fibers keep chronology and evidence.

**Repair relationships.** Nest for containment, wikilinks in prose for narrative, project-owned frontmatter only where the project owns that schema.

**Reshape wide subtrees.** Read the children, name 2–4 natural groups, create grouping nodes, nest, and check with `felt tree <parent>`.

**Update the root surface** when a pass yields a general lesson — lean: commands, durable constraints, links to doc fibers.

## Finish

`felt check`, `felt session`, `felt tree -L 2`. A good pass leaves fewer root-level leaves, open/active fibers that are genuinely current, clear outcomes on closed fibers, `felt check` clean or with understood residue, and non-trivial reshapes committed. A sweep that produces no edits or commits was noise.
