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
felt find "authentication" -s closed
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
felt find "topic"                   # Check for existing doc
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

## Anti-patterns

- **Premature archiving** — don't archive recent work
- **Over-consolidation** — don't merge unrelated fibers just because they're old
- **Orphaned docs** — documentation fibers need to be findable (link them, reference in CLAUDE.md)
- **Stale docs** — if you create a doc, commit to maintaining it
