# Maintenance

A store accumulates stale todos, duplicated findings, orphaned leaves, and top-level sprawl; the user shouldn't have to manage that entropy. The aim is a store that orients the next session quickly: current work visible, old work carrying outcomes, knowledge composted upward, a tree with enough shape to walk.

## Shape to keep

**Open and active mean todo** — not important, reference, or canonical. A container that is open/active is usually not itself a todo: demote it and keep its actionable children tracked.

**The tree stays walkable.** Top level holds roots and large buckets, under about 20 entries. A parent with more than 5–7 direct children probably wants grouping nodes. Deeper and narrower beats flat.

**Understanding composes upward**: quick fiber → doc fiber → root fiber. Extract the lesson; leave chronology to git.

## Moves

**Triage status.** `felt ls -s open`, `felt ls -s active`. For each: is it a current todo? If it has children, is the parent itself actionable? If it is old, can the outcome be stated now? `felt edit <id> -s closed -o "Decision or finding in one sentence."`

**Reduce sprawl.** `felt tree -L 1`, then `felt nest <leaf> <bucket>`. Create a bucket only when it names a category future fibers will reuse — broad but not vague (`performance`, `setup`), never temporary (`misc`, `cleanup`) — with a short body saying what belongs there.

**Compost clusters.** Read the siblings side by side first; a doc fiber made from one leaf misses the shape. Write the doc fiber as what is true now, then close each source with `-o "Consolidated into [[<topic>]]."` — they keep the evidence.

**Reshape wide subtrees.** Name 2–4 natural groups among the children, create grouping nodes, nest, and check with `felt tree <parent>`.

## Ask first

Before deleting fibers with possible historical value, merging fibers when the synthesis needs domain judgment, moving private fibers across roots, changing project-owned YAML semantics, substantially rewriting a root fiber's argument, or reshaping a large area while the user waits on unrelated work. When unsure, prefer the reversible move: nest rather than delete, close with an outcome rather than remove, commit before a large reshape.

## Finish

`felt check`, `felt session`, `felt tree -L 2`, then commit with a message that explains the reshape. A pass that changed nothing was noise.
