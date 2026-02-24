---
name: felt
description: Felt CLI access for fibers via osascript MCP. Claude Desktop only.
---

# Felt CLI (Claude Desktop)

Access the felt CLI for fiber management via the osascript MCP tool. Fibers live in `.felt/` directories.

## Philosophy

**Fibers track concerns, not just tasks.** Open fibers = active concerns. Closed fibers = documented decisions.

The `-o "outcome"` on close IS the documentation. What was decided, what was learned — capture it there. Closed fibers are searchable project memory (`felt ls -s closed`).

**Pattern:**
```
Open: concern arises → felt "Decide X"
Work: discuss, explore, decide
Close: outcome captured → felt edit <id> -s closed -o "Chose Y because Z"
```

**Bodies are the source of truth.** Titles are for scanning/finding. Bodies hold:
- What exactly needs to be done
- Context and background
- Links to emails, docs, URLs
- Blockers or dependencies in prose
- Acceptance criteria

Always write meaningful descriptions when filing. Read bodies fully before working on a fiber (`ls -j` or `show`). Never assume title tells the whole story.

---

## Invocation (Critical)

**Always use this pattern:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt <command>"
```

**Why `cd ~/loom` is required:**
- osascript runs from a sandboxed/read-only directory
- The felt CLI looks for `.felt/` in current directory or parents
- Global fibers live at `~/loom/.felt/`

**Why full path `~/go/bin/felt`:**
- Shell aliases are not available in osascript context
- Must use the explicit path

---

## Global Tapestry

Global fibers live at `~/loom/.felt/` as markdown files. Projects can have their own `.felt/` directories.

```
~/loom/.felt/      # global fibers (life, cross-project)
~/projects/foo/.felt/  # project-specific fibers
```

**Claude Desktop typically works global fibers** (life, cross-project concerns).

---

## Title Prefix Conventions

Tags in fiber titles organize by scope. Use square brackets for consistent filtering with `find`.

| Tag | Meaning |
|-----|---------|
| `[life]` | Personal, family, admin |
| `[research]` | Research concerns |
| `[project-name]` | Specific project work |
| `[tool-name]` | Tool/skill development |
| `[person]` | Person-specific tasks |
| `[to:X]` | Message to session X (needs acknowledgment) |

**Example:** `felt add "[life] Pack for Chicago trip" -d "Flight Jan 9"`

Prefixes enable easy filtering:
- `felt find "life"` — shows all life admin
- `felt find "research"` — shows all research concerns

---

## Core Commands

### Listing

**`ls` — All open fibers**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt ls"
```

**`ls -j` — All open fibers with full data (USE THIS)**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt ls -j"
```

Returns all fibers with complete data in one call.

**`ready` — Unblocked fibers only**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt ready"
```

**`ls -s active` — Currently being worked on**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt ls -s active"
```

**`ls -s closed` — Closed fibers (project memory)**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt ls -s closed"
```

---

### Adding

**Quick add (title only):**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt '[tag] Title'"
```

**Full add with description:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt add '[life] Task title' -d 'Description with context'"
```

**Flags:**
- `-b "body"` — Body text
- `-p <number>` — Priority (0-4, lower = more urgent)
- `-t <tag>` — Tag (repeatable)
- `-a <dep-id>` — Depends on (cannot start until dep is closed)
- `-D YYYY-MM-DD` — Due date
- `-o "outcome"` — Creates fiber already closed

---

### State Transitions

**Start working:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt edit <id> -s active"
```

**Complete fiber:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt edit <id> -s closed -o 'What was decided/learned'"
```

**Remove fiber entirely:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt rm <id>"
```

Use `rm` for junk/duplicates. Use `edit -s closed -o` for completions.

---

### The DAG

Fibers form a directed graph via dependencies.

**Creating with dependencies:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt add 'Implement X' -a design-decision-xxx"
```

**Traversal:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt upstream <id>"     # What this depends on
do shell script "cd ~/loom && ~/go/bin/felt downstream <id>"   # What depends on this
```

**Managing:**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt link <id> <dep-id>"    # Add dependency
do shell script "cd ~/loom && ~/go/bin/felt unlink <id> <dep-id>"  # Remove dependency
```

---

### Search

**`find` — Search fibers**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt find 'query'"
```

**`show` — Fiber details**
```applescript
do shell script "cd ~/loom && ~/go/bin/felt show <id>"
```

---

## Claude Session Workflow

### Morning Catchup

1. `felt ls -j` — load full context in one call
2. Synthesize, don't enumerate — understand the shape of what's open
3. Identify what needs attention today

### During Work Session

1. `felt edit <id> -s active` — mark what you're working on
2. Do the work
3. `felt edit <id> -s closed -o "outcome"` — complete with context
4. File new fibers for things discovered along the way

### When to File

**File proactively:**
- Work begins (decompose if needed)
- "I notice this should be fixed, but it's a detour" — file it, keep moving
- A decision point arises
- Email says "need your review by Friday"
- Commitment mentioned that needs tracking

**Don't file:**
- Already exists (check first with `find`)
- Too vague to be actionable
- User handling it right now

---

## Handoff with Claude Code

Claude Desktop and Claude Code share the global tapestry (`~/loom/.felt/`). When you file a fiber like `[to:research] Check the maps paper status`, the research session will see it.

---

## Notes

- osascript has a 30-second timeout
- Use full path `~/go/bin/felt` for reliability
- `cd ~/loom` is required — osascript runs from a sandboxed directory otherwise
