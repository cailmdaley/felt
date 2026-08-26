# Maintenance

Maintenance is how felt stays useful as an assemblage grows. Fibers are cheap to create, so the substrate naturally accumulates stale todos, duplicated findings, orphaned leaves, and top-level sprawl. Do not wait for the user to manage that entropy. When the cleanup is obvious, do it.

The goal is not a tidy archive. The goal is an environment that orients the next session quickly: current work is visible, old work has outcomes, knowledge has been composted upward, and the tree has enough shape that a reader can walk it.

---

## Principles

### The User Should Not Manage The Substrate

Agents have standing authority to perform routine gardening:

- nest obvious top-level leaves under existing root buckets;
- create broader buckets when top-level entries exceed about 20;
- demote open/active documentation or container fibers;
- close stale todos when the outcome is clear;
- consolidate small historical fibers into a doc/reference fiber;
- add missing wikilinks when the relationship is plain;
- run `felt check` after structural cleanup.

Surface a "by the way" note only when cleanup needs judgment, has real blast radius, or would distract from the user's immediate goal.

### Open And Active Mean Todo

`open` and `active` are action states. They do not mean "important", "reference", "canonical", or "worth remembering".

- Use `active` for current attention.
- Use `open` for a real unresolved todo/question.
- Use statusless for ordinary documentation and super-fibers.
- Use `closed` with a strong outcome when the thread resolved.

If a container fiber has children and is open/active, ask whether the container itself is really a todo. Usually the fix is to demote the container and keep actionable child fibers tracked.

### The Tree Should Stay Walkable

Top level is for roots and large buckets. It should normally stay under about 20 entries. If root-level fibers exceed that, create or use broader categories and proactively nest leaves.

Within a subtree, a parent with more than about 5-7 direct children probably needs grouping nodes. A walkable tree is usually deeper and less wide.

### Compose Upward

Quick fibers should not remain the final form of understanding. As topics settle:

```text
quick fiber -> doc/reference fiber -> root fiber / CLAUDE.md pointer
```

Do not copy every detail upward. Extract the lesson, decision, or durable pattern. Leave chronology to the git log.

### Fix Shape While It Is Fresh

Maintenance is not only a periodic chore. The best moment to garden is often right after a session surface tells you what drifted: a stale active fiber, an obvious orphan, a cluster of test fibers, or a parent with too many children.

---

## Triggers

Act on these without waiting for a separate instruction:

- `felt session` shows `## Attention`;
- top-level sprawl is over 20 root-level fibers;
- open/active fibers are old or clearly stale;
- a documentation/super-fiber is open or active without being a current todo;
- a cluster of 3+ fibers circles the same idea;
- a parent has 5+ direct children with natural subgroups;
- a quick finding or gotcha has recurred and belongs in a doc/root fiber;
- `felt check` reports mechanical issues.

Do not let maintenance block urgent user work. Take the obvious small fix now; leave a concise by-the-way note or fiber for larger judgment calls.

---

## Authority Boundaries

Safe to do proactively:

- `felt nest <child> <parent>` when the parent is an obvious existing bucket;
- create a grouping/root bucket when several leaves plainly share a category;
- demote a container from open/active by editing status away when no current todo remains;
- close test/scratch/stale todo fibers when their outcome is obvious;
- add or repair wikilinks that are clearly intended;
- update a doc fiber with a settled lesson from sibling fibers;
- commit the reshape with a message explaining the maintenance.

Pause or ask before:

- deleting fibers with possible historical value;
- merging fibers where the synthesis requires taste or domain judgment;
- moving sensitive/private fibers across roots;
- changing project-owned YAML semantics;
- rewriting a root fiber's argument substantially;
- cleaning a large area when the user asked for unrelated urgent work.

When in doubt, prefer reversible moves: nest rather than delete, close with an outcome rather than remove, commit before large reshapes.

---

## Maintenance Moves

### 1. Triage Status

Start with the tracked set:

```bash
felt ls
felt ls -s open
felt ls -s active
```

For each open/active fiber:

- Is this a current todo or unresolved question?
- If it has children, is the parent itself actionable?
- If it is old, can the outcome be stated now?
- If it is documentation, should it become statusless or closed?

Use strong outcomes when closing:

```bash
felt edit <id> --status closed --outcome "Decision/finding in one sentence."
```

### 2. Reduce Top-Level Sprawl

Inspect roots:

```bash
felt tree --depth 1
```

If top level has more than about 20 entries, find obvious leaves and nest them:

```bash
felt nest <leaf> <root-bucket>
```

Create a new bucket only when it names a real category that future fibers will reuse. A bucket should have a short body explaining what belongs there and why.

Good bucket names are broad but not vague: `relationship-model`, `history`, `performance`, `setup`, `viewer`. Bad bucket names are temporary: `misc`, `cleanup`, `stuff`.

### 3. Compost Clusters

A cluster wants composting when 3+ fibers answer parts of the same question, repeat a gotcha, or record small steps of one settled arc.

Read horizontally first. Then create or update the doc/reference fiber:

```bash
felt add <topic> "Topic reference" -b "Current understanding..."
felt edit <old-id> --status closed --outcome "Consolidated into [[<topic>]]."
```

The doc fiber should say what is true now. The old fibers keep chronology and evidence.

### 4. Repair Relationships

Use the right relationship surface:

- nest for containment;
- wikilinks for narrative connection;
- project-owned frontmatter only when the project owns that schema.

Links should appear in prose. Do not add a "related" pile unless the file is explicitly an index.

### 5. Reshape Wide Subtrees

When a parent has too many direct children:

1. Read the children.
2. Name 2-4 natural groups.
3. Create grouping nodes.
4. Nest children under the groups.
5. Verify with `felt tree <parent>`.

Target 2-4 children per grouping node when possible. Prefer a deeper walkable tree over one huge flat list.

### 6. Update The Root Surface

When maintenance produces a general lesson, update the root fiber or `CLAUDE.md` pointer. Keep root surfaces lean: commands, durable constraints, and links to deeper doc fibers.

---

## Verification

Run:

```bash
felt check
felt session
felt tree --depth 2
```

A good maintenance pass leaves:

- fewer root-level leaves;
- no stale active fibers unless they are genuinely current;
- open fibers that are real todos/questions;
- doc/container fibers demoted from open/active unless actionable;
- clear outcomes on closed fibers;
- `felt check` clean or with understood residual warnings;
- non-trivial reshapes committed with messages that explain them.

---

## Anti-Patterns

- **User-managed entropy.** Do not make the user ask for obvious gardening.
- **Status as importance.** Open/active is not a bookmark.
- **Flat root.** Top-level sprawl makes every session start worse.
- **Silent deletion.** Deleting is rarely the first maintenance move.
- **Compost without reading siblings.** A doc fiber made from one leaf usually misses the actual shape.
- **Links in piles.** Wikilinks should carry meaning in sentences.
- **Maintenance theater.** A sweep that produces no edits, commits, or concrete plan is usually noise.
- **Blocking the work.** Maintenance should support the current task, not become a ritual gate.
