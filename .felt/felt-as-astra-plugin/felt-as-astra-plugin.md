---
title: felt as ASTRA plugin
status: active
tags:
    - astra
    - lightcone
depends-on:
    - felt-v2-constitution
    - lightconeresearch-ecosystem
created-at: 2026-04-02T11:27:36.543931519+02:00
---

(felt-as-astra-plugin)=
# Felt: an ASTRA-aware fiber system

*For the Lightcone team. What we built, where it fits, and the open problem of getting agents to actually use it.*

## What felt is

A CLI for accumulating context as linked markdown fibers in a directed graph. Each fiber is a concern — a decision, finding, question, task, or spec — stored as a markdown file with YAML frontmatter. Fibers depend on each other, forming a DAG: upstream to trace reasoning, downstream to follow consequences.

No database, no server. `.felt/` is a directory tree of markdown files you version-control, grep, and move between machines.

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

The filesystem mirrors the analysis tree. A sub-analysis is a subdirectory. IDs are slugs (`bao-analysis/damping-prior`), not UUIDs. `felt show`, `felt ls`, `felt tree` navigate the graph.

Designed for AI coding agents (Claude Code, Codex) but works fine without them. **File as you go.** Decisions, detours, bugs you can't chase now — everything becomes a fiber. The DAG forms behind you as wake.

## How it relates to ASTRA

Felt speaks the ASTRA format but doesn't require it; ASTRA doesn't require felt. Other teams can use different memory/task systems — the common language is the spec.

**The bridge is frontmatter.** A fiber can carry just felt-native fields (title, status, outcome, depends-on) or accrete ASTRA structure as understanding crystallizes:

```yaml
---
title: BAO Damping Prior
status: closed
outcome: Informative Gaussian priors confirmed.
depends-on:
  - broadband-model

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

All ASTRA fields are optional; a fiber with just `title` is valid. You don't design the analysis tree upfront. You file fibers as you work and the ASTRA structure fills in as it becomes real.

`felt export --format astra` walks the fiber tree and emits a valid `astra.yaml` that `astra validate` and Prism can consume. Directory nesting maps to ASTRA nesting. Fibers without ASTRA content are silently skipped.

## What we built (v2)

The recent work reorganized felt around three changes:

### 1. Directory-based fibers

Every fiber is now a directory containing `<slug>.md` plus optional artifacts (figures, data). This replaced flat files with hex-suffix IDs (`covariance-estimation-a8b3c4d2.md` → `covariance-estimation/covariance-estimation.md`). The directory structure mirrors the analysis hierarchy — nesting a fiber under a parent creates a sub-analysis.

`felt migrate` converts old flat-file assemblages in one pass, rewriting all dependency references from hex IDs to slugs.

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

### Level 4: Stop hook conscience (small model as nudge)

The newest experiment, and the most instructive. A small model (Haiku 4.5) reviews each turn and nudges toward filing when decisions or insights slip by unrecorded.

We tested three implementations, each revealing different constraints in Claude Code's hook system:

**4a. Prompt hook** (`type: "prompt"`). Built-in, fast (~1s), no external process. But by *talking to haiku through the hook* — iteratively updating the prompt to ask it about its own experience — we discovered it receives only 7 JSON fields, and `last_assistant_message` contains **only the final prose text**, not tool calls, file edits, or commands. Haiku reported 47 characters of prose from a turn with multiple tool calls and file writes. Without visibility into what actually happened, the conscience can't judge.

**4b. Agent hook** (`type: "agent"`). Has tool access — can Read the transcript file directly. But it blocks the session, ~10+ seconds of frozen UI. Unacceptable.

**4c. Async command hook** (`type: "command"` with `asyncRewake: true`). The current winner. A shell script reads the JSONL transcript, extracts recent tool calls, and pipes context to `claude -p --model haiku`. If haiku has a nudge: exit 2 + stderr wakes the main model asynchronously. If nothing to say: exit 0, silence.

`asyncRewake` is the key discovery — a hook that runs in the background but can still wake the model when it has something to say. The ~5s haiku call is invisible to the user; the nudge arrives naturally.

More moving parts than a prompt hook (shell script, transcript parsing, external CLI call). But it sees everything — tool calls, file paths, commands — and the async delivery means zero UX cost.

**Talking to a stateless model.** We ran a diagnostic loop, iteratively updating the prompt hook to ask haiku what it sees, what fields it receives, whether it remembers previous firings. Each response taught us something; we updated the prompt for the next firing. The state accumulated in the prompt text, not in the model. This pattern — conversation via prompt iteration — may be useful beyond this specific application.

### The landscape

These levels stack. Our current setup:
- CLAUDE.md provides baseline instructions
- Session hook injects fiber state
- PreToolUse gate enforces skill activation
- Async Stop conscience nudges toward ASTRA formalization

The gate (level 3) solved the activation problem definitively. The conscience (level 4) is still being calibrated — we're not sure which implementation is best, and the prompt engineering for the small model matters a lot. This is active research.

Open questions:
- Can the main model cooperate by leaving structured summaries in its prose for a lightweight prompt hook to read? (Avoids the transcript-parsing complexity.)
- Should the conscience have memory across firings? (Currently stateless — each firing is fresh.)
- Is there a middle ground between "prompt hook sees nothing useful" and "command hook reads the whole transcript"?

## For the Lightcone team

Felt is one implementation. The ASTRA spec is the shared language. The pieces that matter for interoperability:

1. **`felt export --format astra`** produces valid `astra.yaml` from the fiber tree. This is the handoff point — anything downstream (Prism, validation, visualization) consumes the spec, not felt's internal format.

2. **Frontmatter is the source of truth.** No separate spec file to maintain. Structure accretes in the fibers as work happens.

3. **The context injection ladder is transferable.** Session context, tool gating, LLM conscience — these patterns work with any tool that speaks Claude Code hooks.

4. **The conscience prompt is the interesting part.** Teaching a small fast model to recognize ASTRA-worthy moments is a prompt engineering problem independent of felt. `asyncRewake` makes it practical.

5. **Hook types have sharp constraints.** Prompt hooks: fast, blind to tool calls. Agent hooks: full visibility, blocks the session. Async command hooks: full visibility, non-blocking, more moving parts. Worth understanding for anyone building agent-integrated tooling on Claude Code.

Status: experimental. The gate works. The conscience is promising. Working prototype of the full stack for testing tomorrow.
