# Session Mining

Retroactive extraction at session end. What wasn't captured in the moment.

**Autonomous** — no review needed. You were there.

---

## What to Extract

Read through the conversation looking for:

- **Decisions made** — choices, trade-offs, rejections, "decided NOT to"
- **Questions answered** — mechanisms, causes, how things work
- **Patterns discovered** — architectural insights, conventions
- **Outcomes** — what was built, found, produced
- **Documentation candidates** — recurring patterns worth a `doc` fiber

---

## Steps

### 1. Extract Fibers

For each undocumented finding:

```bash
# Simple fiber (title + outcome)
felt add "Chose X over Y for Z reason" -o "X was better because... Y failed due to..."

# Complex fiber (with body for detailed context)
felt add "Architecture decision: event sourcing" -b "Background: needed audit trail..." -o "Chose event sourcing over CRUD because..."
```

The `-o` flag creates the fiber already closed. Use `-b` for the body when there's enough background or complexity that the title and outcome aren't sufficient.

### 2. Link the DAG

For each new fiber:
- What does this depend on?
- What does this enable?
- What else touches these concepts?

```bash
felt find "<concept>"
felt link <new-fiber> <related-fiber>
```

Err toward linking. Isolated fibers are hard to find.

### 3. Update CLAUDE.md

Practical lookups:
- **Commands** — tool invocations, common operations
- **Context pointers** — paths, important fibers, documentation fibers
- **Workflows** — "to do X, run Y then Z"

```bash
# Which CLAUDE.md?
# Project-specific → ./CLAUDE.md
# Cross-project → ~/.claude/CLAUDE.md
```

Keep it lean. Depth goes in documentation fibers.

### 4. Git Commit (if applicable)

```bash
git add -A && git commit -m "session: <what happened>"
```

---

## Quality Checklist

- [ ] Decisions captured with reasoning
- [ ] Questions answered documented
- [ ] Patterns noted
- [ ] New fibers linked to related fibers
- [ ] CLAUDE.md updated if needed
- [ ] Documentation fiber created if pattern is recurring
