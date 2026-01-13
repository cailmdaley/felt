# Workflows

## DAG Patterns

**Sequential:** Research → Design → Implement → Test
```bash
felt add "Research auth" -p 1
felt add "Design auth" -a research-auth
felt add "Implement auth" -a design-auth
```

**Parallel:**
```bash
felt "Backend API"
felt "Frontend UI"
felt add "Integration" -a backend-api -a frontend-ui  # waits for both
```

**Spec-driven:**
```bash
felt add "User auth spec" -k spec
felt add "Implement auth" -a user-auth-spec
```

## Decision Records

The close reason is the record:

```bash
felt off auth-design -r "JWT with refresh tokens.
Considered session cookies but need mobile support."
```

Later: `felt find "JWT"` surfaces this.

## JSON for Scripts

```bash
felt ls --json | jq '.[] | select(.priority < 2)'
felt ready --json
```

## Claude Code Integration

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "command": "felt hook session" }
    ]
  }
}
```

**`felt hook session`** — compact context for session start (active + ready fibers, core rules).

**`felt prime`** — full context recovery after compaction/clear (active with bodies, ready with descriptions, recently closed).
