name: "Felt: an ASTRA-aware fiber system"
description: For the Lightcone team. What we built, where it fits, and the open problem of getting agents to actually use it.
---

# Felt: an ASTRA-aware fiber system

*For the Lightcone team. What we built, where it fits, and the open problem of getting agents to actually use it.*

## What felt is

A CLI for accumulating context as directory-contained markdown fibers. Each fiber is a concern — a decision, finding, question, task, or spec — stored as a markdown file with YAML frontmatter. Relationships come from containment by path, `[[wikilinks]]` in the body for narrative connection, and ASTRA `inputs.from` for computational provenance.

No server. The markdown tree in `.felt/` stays the source of truth you version-control, grep, and move between machines; a rebuildable SQLite cache adds citations, typed links, and FTS body search without changing the authoring model. Because the storage format is plain markdown with YAML frontmatter and `[[wikilinks]]`, any `.felt/` directory also opens as a valid Obsidian vault, with Dataview queries over ASTRA frontmatter fields.

```
.felt/
├── myst.yml
├── bao-analysis/
│   ├── bao-analysis.md
│   └── damping-prior/
│       ├── damping-prior.md
│       └── contour_plot.png
└── covariance-estimation/
    └── covariance-estimation.md
```

The filesystem mirrors the analysis tree. A sub-analysis is a subdirectory. IDs are slugs (`bao-analysis/damping-prior`), not UUIDs. `felt show`, `felt ls`, and `felt tree` navigate containment, citations, and data flow without explicit dependency maintenance.

Designed for AI coding agents (Claude Code, Codex) but works fine without them. **File as you go.** Decisions, detours, bugs you can't chase now — everything becomes a fiber. The relationship structure forms behind you as wake.

## How it relates to ASTRA

Felt speaks the ASTRA format but doesn't require it; ASTRA doesn't require felt. Other teams can use different memory/task systems — the common language is the spec.

**The bridge is frontmatter.** A fiber can carry just felt-native fields (`name`, `status`, `outcome`) or accrete ASTRA structure as understanding crystallizes:

```yaml
---
name: BAO Damping Prior
status: closed
outcome: Informative Gaussian priors confirmed.

# ASTRA fields — optional, accrete as understanding crystallizes
inputs:
  - id: clustering_data
    type: data
    from: parent.desi_dr1_vac
decisions:
  damping_prior:
    label: BAO Damping Prior
    rationale: "Without informative priors, broadband projection creates spurious minima"
    default: gaussian
    options:
      gaussian:
        label: Informative Gaussian
      flat:
        label: Flat uniform
        excluded: true
        excluded_reason: "Shifts <0.3σ"
insights:
  damping_physical:
    claim: "BAO damping caused by pairwise displacements of ~10 Mpc"
    created_at: 2026-03-16T09:00:00Z
    evidence:
      - id: ev1
        doi: "10.48550/arXiv.astro-ph/0604361"
---
```

All ASTRA fields are optional; a fiber with just `name` is valid. You don't design the analysis tree upfront. You file fibers as you work and the ASTRA structure fills in as it becomes real.

`felt export --format astra` walks the fiber tree and emits a valid `astra.yaml` that `astra validate` and Prism can consume. Directory nesting maps to ASTRA nesting for legacy consumers. Fibers without ASTRA content are silently skipped.

## What we built (v2)

The recent work reorganized felt around three changes:

### 1. Directory-based fibers and relationship surfaces

Every fiber is now a directory containing `<slug>.md` plus optional artifacts (figures, data). This replaced flat files with hex-suffix IDs (`covariance-estimation-a8b3c4d2.md` → `covariance-estimation/covariance-estimation.md`). The directory structure mirrors the analysis hierarchy — nesting a fiber under a parent creates a sub-analysis.

Containment comes from the path itself. Narrative references are `[[wikilinks]]` resolved lexically from the referencing fiber. Computational provenance is expressed separately through ASTRA `inputs.from`.

`felt migrate` converts old flat-file assemblages in one pass, rewriting `inputs.from` references from hex IDs to slug IDs.

### 2. ASTRA-compatible frontmatter

The fiber file is now the source of truth for both felt metadata and ASTRA structure. Instead of maintaining a separate `astra.yaml` by hand, you write ASTRA fields in frontmatter and export when needed. The fields are:

| Field | Type | Purpose |
|-------|------|---------|
| `inputs` | array | Data sources with provenance (`{id, type, from?, source?}`) |
| `outputs` | array | Products with recipes (`{id, type, recipe?}`) |
| `decisions` | map | Choice points with excluded alternatives |
| `insights` | map | Claims backed by evidence (DOIs, artifact references) |
| `success_criteria` | array | Pass/fail conditions tied to outputs |

These are self-similar with the ASTRA spec v0.1 schema. `felt ls` searches ASTRA fields alongside felt-native ones.

### 3. Consolidated CLI

The command set went from ~22 to ~10. Modifier commands (`tag`, `untag`, `link`, `comment`) became flags on `felt edit`. Graph commands (`upstream`, `downstream`, `graph`) became modes of `felt tree`. `felt export` replaces `felt tapestry export` and adds `--format astra`.

## The context injection problem

Storing structured research context is solved. Getting AI agents to actually *use* it during a session is not.

An agent starts with tools, instructions, and context. It doesn't naturally pause to record decisions or formalize ASTRA structure — unless something prompts it to. We tried several approaches, each revealing different constraints:

### Level 1: CLAUDE.md / AGENTS.md

Static instruction files loaded at session start. You write "use felt for everything" and hope.

Simple and portable — works with any agent that reads project instructions. But not enforceable. The agent sees "use felt" alongside 50 other instructions and makes its own priority call. No progressive disclosure.

### Level 2: Session-start hooks

`felt hook session` runs at the start of every Claude Code session, injecting active fibers, ready fibers, and a CLI reference. The agent sees what's in flight and what's unblocked.

Reliable — the context is always there. But one-shot: fires once, no progressive disclosure. The agent gets fiber state but not the methodology for working with fibers. We tried adding "activate the /felt skill before calling any other tools" to the session output. It didn't work. The agent reads it, acknowledges it, and reaches for Grep anyway.

### Level 3: PreToolUse gate (deny until skill activated)

The session hook's advisory failed, so we made it enforcing. The PreToolUse hook now returns `permissionDecision: deny`, blocking all non-Skill tool calls until the felt skill is activated.

This works. The agent hits the wall, activates the skill, then has the full felt context for the rest of the session. Progressive disclosure achieved: session hook provides fiber state, skill provides methodology. The cost is bluntness — it blocks the first tool call, which feels jarring.

### Level 4: Channel-based idle nudge (previously: Stop hook conscience)

The goal at this level is a small-model or rule-based watcher that recognizes when decisions or insights are slipping by unrecorded and nudges toward filing.

Our first iteration was an async Stop-hook conscience running haiku against the transcript. The design claimed "exit 2 + stderr wakes the model asynchronously" — but empirical testing on Claude Code v2.1.109 showed that **async Stop hooks do NOT actually wake the model**. Only synchronous Stop hooks honor exit 2, and those block the user while the hook runs. The conscience appeared to work because it mostly exits QUIET (exit 0); the broken wake path was rarely exercised.

The working mechanism is **Channels** (v2.1.80+, research preview): a local MCP server declares the `claude/channel` capability, watches the session's transcript, and pushes `notifications/claude/channel` events into the running session as `<channel source="...">` tags. Non-blocking, in-session, no exit-code gymnastics.

The current reference implementation is a watcher-internal channel that fires a `/felt` directive after 4 minutes of transcript inactivity — hitting the prompt-cache window (5-min TTL) so formalization runs cheaply even on abandoned sessions. Each claude process spawns its own MCP subprocess; addressing is by parent PID, which the SessionStart hook writes to a registry file so the MCP server can find its own session's transcript.

See the `hook-architecture-exploration/idle-formalize-channel` fiber for the design tree and the [Channels docs](https://code.claude.com/docs/en/channels) for the underlying primitive.

### The landscape

These levels stack. Our current setup:
- CLAUDE.md provides baseline instructions
- Session hook injects fiber state
- PreToolUse gate enforces skill activation
- Channel-based idle nudge pushes /felt into idle sessions before the cache expires

The gate (level 3) solved the activation problem definitively. The channel-based nudge (level 4) delivers reliable wake-ups without blocking; what's still being tuned is *what* triggers the nudge (pure idle timer today; could become transcript-content-aware).

## For the Lightcone team

Felt is one implementation. The ASTRA spec is the shared language. The pieces that matter for interoperability:

1. **`felt export --format astra`** produces valid `astra.yaml` from the fiber tree. This is the handoff point — anything downstream (Prism, validation, visualization) consumes the spec, not felt's internal format.

2. **Frontmatter is the source of truth.** No separate spec file to maintain. Structure accretes in the fibers as work happens.

3. **The context injection ladder is transferable.** Session context, tool gating, idle nudges — these patterns work with any tool that speaks Claude Code hooks or Channels.

4. **Channels, not async Stop hooks, for out-of-band session messages.** Async Stop hook exit codes don't actually steer the model; Channels (v2.1.80+) are the supported mechanism for pushing events into a running session.

5. **Hook types have sharp constraints.** Prompt hooks: fast, blind to tool calls. Agent hooks: full visibility, blocks the session. Sync command hooks: can steer the model via exit 2 but block the user. Async command hooks: non-blocking but their output is advisory-only. For anything that needs to reach a waiting session without blocking, use Channels.

Status: experimental. The gate works. The channel-based idle nudge works. Working prototype of the full stack deployed and tested.
