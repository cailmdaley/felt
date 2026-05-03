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
felt add chose-x-over-y "Chose X over Y for Z reason" -o "X was better because... Y failed due to..."

# Complex fiber (with body for detailed context)
felt add architecture-decision-event-sourcing "Architecture decision: event sourcing" -b "Background: needed audit trail..." -o "Chose event sourcing over CRUD because..."
```

The `-o` flag creates the fiber already closed. Use `-b` for the body when there's enough background or complexity that the title and outcome aren't sufficient.

### 2. Connect it

For each new fiber:
- What should it cite with `[[wikilinks]]`?
- Should it live under an existing parent fiber?
- Does it need `inputs.from` because the relation is computational?

```bash
felt ls -s all "<concept>"
felt show <id>
```

Err toward useful connection. Isolated fibers are hard to find.

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

### 5. Exit Interview

After extraction is complete, run the exit interview. This is part of mining, not an optional extra pass. Read [exit-interview.md](exit-interview.md) for the instrument and output template, then write the interview fiber to `~/loom/.felt/felt/`.

Skip if the session made no use of felt.

---

## Quality Checklist

- [ ] Decisions captured with reasoning
- [ ] Questions answered documented
- [ ] Patterns noted
- [ ] New fibers linked to related fibers
- [ ] CLAUDE.md updated if needed
- [ ] Documentation fiber created if pattern is recurring
