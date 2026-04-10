# Maintenance

Keeping the assemblage coherent as it grows. Fibers accumulate; over time they go stale, contradict each other, orphan themselves, and pile up without consolidation. Maintenance is where you step back from the work, read across the assemblage, and fix what you find.

Present a plan before making changes when the action set is non-trivial (composting, retirements, re-parenting). Small fixes in place are usually safe.

Maintenance combines two moves that used to feel separate: composting stale fibers upward into doc fibers (archive), and checking coherence across siblings (sweep). **To do good composting you first have to sweep**: you cannot promote a cluster of quick fibers into a doc fiber without reading the surrounding fibers to know what the doc should contain. Sweeping and archiving are the same move at different phases of a single pass.

---

## When to maintain

- **After a burst of exploration.** A lot was filed; little was composted.
- **Before a deadline.** The assemblage needs to be presentable to your future self.
- **When something feels off.** Two fibers seem to contradict, or the same question keeps recurring.
- **When `felt check` warns.** Inconsistent ASTRA formalization depth, broken refs, evidence stubs without anchors.
- **Periodic.** Every few weeks, especially for long-running projects.

Do not maintain work that is still in motion. An active fiber is not a compost candidate.

---

## The two axes of mess

### Horizontal — coherence across siblings

Fibers existing next to each other that should be aware of each other. Look for:

- **Contradictions** — sibling fibers that disagree on a fact, decision, or claim
- **Orphans** — fibers with no containment parent, no `[[wikilinks]]`, and no `inputs.from`
- **Staleness vs code** — a fiber's claim no longer matches what the code does
- **Duplicates** — two fibers covering the same thing from different angles
- **Branching** — a parent with 5+ direct children, no grouping structure

### Vertical — composting upward

Knowledge that has grown beyond its current container. Look for:

- **Stale quick fibers** — closed, older than ~2 months, the lesson is not in any doc fiber
- **Topic clusters** — 3+ fibers circling the same concept without a doc fiber to anchor them
- **Doc fibers not in the root** — a doc fiber exists but the root fiber / CLAUDE.md does not link to it
- **Root-fiber gaps** — a gotcha or pattern that has recurred but never made it into the root fiber

**The two axes interact.** When you spot horizontal mess (contradictions, duplicates), the fix is usually vertical (promote into a single source of truth). When you spot vertical mess (no doc fiber for a topic cluster), the fix requires horizontal reading (what do all these siblings actually say?). This is why sweeping and archiving are one activity.

---

## Workflow

### 1. Survey

Launch Explore agents across the assemblage. Each reads a subset of fibers and reports:
- Contradictions between siblings
- Orphans with no containment / wikilinks / data flow
- Stale claims relative to current code
- Topic clusters that could compost
- Branching points exceeding 5 direct children

Also run `felt check` for mechanical findings:

```bash
felt ls                                  # open/active set
felt ls -s closed --before 60d           # old closed fibers
felt check                               # broken refs, ASTRA issues
felt tree <parent>                       # branching check
```

For large assemblages, parallelize: each Explore agent takes a top-level directory or a specific axis (e.g., "check for contradictions in cmbx/", "audit the felt/ subtree for orphans").

### 2. Present findings

Group by required move:

- **Fix in place** — update a body, add a wikilink, re-nest an orphan
- **Compost** — promote a cluster into a new or existing doc fiber
- **Reshape** — introduce grouping nodes to reduce branching
- **Retire** — delete fibers with no lasting value

Present the full plan before making changes. Confirm with the user. Different categories can be approved independently — fixes in place are usually safe, retirement needs more care.

### 3. Act

After approval:

```bash
# Compost a cluster into a doc fiber
felt add how-x-works "How X works" -b "Synthesized understanding, key decisions, date of last update."
felt edit <old-fiber> -o "Consolidated into how-x-works"

# Re-nest an orphan (edit the markdown directly, or move the file)

# Reshape a branching parent — see Tapestry reshaping below

# Retire truly useless fibers
felt rm <fiber-id>

# Update the root fiber / CLAUDE.md if the lesson belongs there
```

### 4. Verify

- `felt check` returns clean or with only expected warnings
- `felt tree <parent>` shows 2-4 children per node for reshaped subtrees
- No orphans remain in the open/active set
- The root fiber reflects any gotchas that came up

---

## Tapestry reshaping

Reshaping is maintenance applied to tapestry nodes. The trigger is branching: any tapestry node with 5+ direct children needs restructuring.

**Target: 2-4 children per node. 3 is default.** A 60-node tapestry should be 3-4 levels deep, not 2. The graph should be walkable — a reader should be able to parse a neighborhood in one click.

Steps:

1. **Audit** — walk spine nodes, count children with `felt tree <id>`. Flag any with 5+.
2. **Partition** — identify natural groupings among the siblings. Name the partition.
3. **Introduce grouping nodes** — create a tapestry-tagged fiber per group with a 2-3 sentence body (what's here, why it matters). No evidence needed.
4. **Re-parent** — move children under the grouping node with `felt nest <child> <grouping-node>`.
5. **Verify** — `felt tree <parent>` should show 2-4 children. Each grouping node should have 2-4 children.

```bash
# Methods has 7 children → split into Estimators + Covariance + Simulations
felt add estimators "Estimators" -t tapestry:estimators -b "Pipeline independence, foreground bias, cross-checks."
felt nest estimators methods
felt nest child-a estimators
felt nest child-b estimators
```

---

## Compose upward

The hierarchy:

```
quick fiber → doc fiber → root fiber / CLAUDE.md
```

A quick fiber composts into a doc fiber when 3+ fibers share a theme. A doc fiber informs the root fiber when its lesson is foundational enough that every session should read it. CLAUDE.md stays lean — it carries commands, paths, and pointers to doc fibers for the depth.

**The root fiber is a node in the DAG.** Treat it like any other fiber: if its content has drifted, update it. If a doc fiber belongs in it, link it in. The root fiber is where the lessons of mature doc fibers eventually land.

---

## Anti-patterns

- **Premature maintenance.** Do not sweep work that is still in motion. Active fibers are not compost candidates.
- **Over-consolidation.** Do not merge unrelated fibers just because they are old. Different topics stay different.
- **Orphaned doc fibers.** A new doc fiber that nobody links to defeats the purpose. Nest it, cite it, reference it from the root fiber.
- **Stale doc fibers.** If you create a doc fiber, commit to maintaining it. A stale doc is worse than no doc.
- **Silent deletion.** Do not retire fibers without user confirmation. The blast radius is real.
- **Sweep without act.** A coherence check that produces findings but no changes is noise. Either present a plan or do not sweep.
- **Act without sweep.** Composting a cluster into a doc fiber without first reading the surrounding fibers produces a doc that misses context. This is why sweeping and archiving are one activity.
- **Maintenance as a gate.** Do not refuse new work until the backlog is clean. Maintenance is a rhythm, not a blocker.

---

## Where maintenance fits

Formalizing while you work is the primary defense against mess — every decision or finding caught in the reply window is one less thing for maintenance to compost later. Session mining at the end of a coding session is end-of-session maintenance in miniature, a backstop for what slipped through the reply window. Full maintenance is the longer, cross-session version: it runs when the assemblage has genuinely drifted, when `felt check` starts warning, or when the user notices something off.
