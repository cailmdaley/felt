# Transcript Mining

Processing external transcripts (meetings, voice notes) for knowledge extraction.

**Review required.** You weren't there — present the plan, get approval, then file.

---

## Steps

### 1. Survey

Read end-to-end. Note:
- Main topics discussed
- Who's speaking (if identifiable)
- Emotional tone shifts (often signal important content)
- Asides and tangents (often contain philosophy/ideas)

### 2. Plan Extractions

List candidates before creating any fibers:

```
EXTRACTION PLAN:
1. Decision: Chose algorithm X because Y
2. Question resolved: Why the pipeline was failing
3. Task: [Person] will run the chain with new priors
4. Claim: Measurement shows σ₈ = 0.8 (needs verification)
5. Status: Collaboration with team Y is blocked on data access
...
```

**Notes:**
- **Claims** — only extract if they require verification by you
- **Status** — human coordination or scientific progress, not internal system state
- **Documentation updates** — big decisions may warrant updating CLAUDE.md or documentation fibers

**Hunt implicit content:**
- Ideas buried in problems ("This keeps breaking because..." → idea for better approach)
- Philosophy as aside ("I always think you should..." → principle)
- Decisions by omission ("We could do X but..." [moves on] → decided NOT to)

### 3. Review with User

Present the plan split by relevance:

```
**Probably relevant:**
- Decision: Chose algorithm X because Y
- Claim: Measurement shows σ₈ = 0.8

**Probably skip:**
- Action item: [other person] will do Z
- Infrastructure detail
```

**Wait for approval.** They may promote, demote, or cut items.

### 4. File

For each approved extraction:

```bash
felt add "Decision: Use algorithm X" -o "Meeting 2025-01-21. Compared X vs Y. X chosen because faster. Y failed benchmarks."
```

Update existing fibers if content is status on existing work:
```bash
felt comment <id> "Update from meeting: progress on X"
felt edit <id> -s closed -o "Resolved in meeting: decided to Z"
```

### 5. Link

```bash
felt find "related concept"
felt link <new-fiber> <related-fiber>
```

---

## Quality Checklist

- [ ] Read transcript end-to-end
- [ ] Planned extractions before filing
- [ ] **Presented plan for user review**
- [ ] Only filed approved extractions
- [ ] Outcomes contain full context
- [ ] Linked new fibers to related fibers
