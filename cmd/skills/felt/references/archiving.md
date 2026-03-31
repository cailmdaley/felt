# Archiving

Consolidating old fibers into documentation. Old fibers become noise — archive composts them into richer, denser forms.

**Review required.** Confirm the plan before making changes.

---

## When to Archive

- **Time-based:** Fibers older than ~2 months are candidates
- **Topic clusters:** Many fibers covering the same concept
- **Before it's lost:** Patterns across sessions that aren't captured anywhere

---

## Steps

### 1. Query

```bash
# Fibers older than 60 days
felt ls -s closed --before 60d

# Or by topic
felt ls -s closed "authentication"
```

Look for clusters around the same concept, decisions that informed later decisions, patterns that recurred.

### 2. Group

Identify natural clusters:
- Same feature/system
- Same type of decision
- Same time period or collaborator

### 3. Summarize

For each cluster:
- What was the core insight?
- What context led to it?
- What's still relevant? What can be forgotten?

Not everything needs preserving. Some fibers were useful in the moment but have no lasting value.

### 4. Promote

If a cluster represents recurring knowledge:

```bash
felt ls -s all "topic"              # Check for existing doc
felt add "How X works"              # Create new doc fiber
```

The doc fiber body should contain synthesized understanding, key decisions with reasoning, and date of last update.

### 5. Prune and Update

After consolidation:

```bash
# Point old fibers to the doc
felt edit <old-fiber> -o "Consolidated into <doc-fiber-id>"

# Or delete if truly useless
felt rm <fiber-id>

# Add pointer to CLAUDE.md if sessions should reference it
```

**Keep** fibers with unique context. **Archive** fibers whose value is captured in the doc. **Delete** sparingly.

---

## Tapestry Reshaping

Reshaping is archiving applied to tapestry nodes. The trigger is branching: any tapestry node with 5+ children needs restructuring.

### When to Reshape

- A tapestry node has 5+ children (check with `felt tree <id> --down`)
- The DAG is wide and shallow — many siblings, little depth
- A reader can't parse a neighborhood in one click

### Steps

1. **Audit** — walk spine nodes, count children. Flag any with 5+.
2. **Partition** — identify natural groupings among the siblings. Name the partition.
3. **Introduce grouping nodes** — create a tapestry-tagged fiber for each group. Write a 2-3 sentence summary body (what's here, why it matters). No evidence needed.
4. **Re-parent** — `felt edit <child> --unlink <parent>` to detach children, then `felt edit <child> --link <grouping-node>` and `felt edit <grouping-node> --link <parent>`.
5. **Verify** — `felt tree <parent> --down` should show 2-4 children. Each grouping node should have 2-4 children.

```bash
# Example: Methods has 7 children, split into Estimators + Covariance + Simulations
felt add "Estimators" -t tapestry:estimators -b "Pipeline independence, foreground bias, cross-checks."
felt edit estimators-id --link methods-id
felt edit child-a --unlink methods-id --link estimators-id
felt edit child-b --unlink methods-id --link estimators-id
```

### Target

2-4 children per node. 3 is default. The graph should be 3-4 levels deep for a 60-node tapestry, not 2.

---

## Anti-patterns

- **Premature archiving** — don't archive recent work
- **Over-consolidation** — don't merge unrelated fibers just because they're old
- **Orphaned docs** — documentation fibers need to be findable (link them, reference in CLAUDE.md)
- **Stale docs** — if you create a doc, commit to maintaining it
