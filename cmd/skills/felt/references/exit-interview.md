# Exit Interview

Reflection at session end. The agent turns the lens on felt itself.

**Autonomous** — no review needed. You were there.

---

## When to run

After session mining is complete (fibers extracted, related fibers cited or nested, CLAUDE.md updated). This is the last thing you do before the session ends. Skip only if the session made no use of felt at all (no fibers touched, no CLI invoked, no /felt run).

---

## The instrument

Answer each question in a few sentences. Be concrete — name the fiber, the CLI command, the convention, or the reference that prompted the observation. Generic feedback ("felt was useful") is noise; specific friction ("the ASTRA insights schema requires evidence but I only had an oral correction from the user, so I had to skip formalization for that fiber") is signal.

### 1. What did you use?

Which mode(s) of /felt did you run? How many fibers did you create, close, or update? Did you formalize any with ASTRA structure — and if so, which kinds (decision, computation, finding)?

### 2. Real-time vs. retrospective

How much of the felt work happened during the session (fibers created in the moment, ASTRA accreted while working) vs. at the end (session mining pass)? Which approach produced better fibers — the ones filed in the moment, or the ones extracted in retrospect? What would have been easier to capture on the fly but you deferred, and what genuinely needed the retrospective view?

### 3. Felt workflow

Friction or confusion about felt *as a workflow*: the mode system, when to file, what to file, the fiber-as-concern model, the "file as you go" vs. "extract at session end" tension, the consolidation conventions, the CLAUDE.md update step, anything about the overall approach.

### 4. ASTRA formalization

Did ASTRA formalization feel warranted for every fiber you formalized? Were there fibers where you forced ASTRA structure that would have been better left annotated-only? Were ASTRA fields unclear or awkward — which ones? Did the three-kind model (decision, computation, finding) fit what you were trying to express, or did the work need a shape that doesn't exist yet?

### 5. CLI

The `felt` command-line tool specifically: flags, output, search (`felt ls`, `felt show`), containment and path IDs, `felt edit`, and ASTRA-targeted views. Anything that didn't work as expected, was hard to discover, or produced confusing output. Also: did you end up writing fiber files directly (Edit/Write) more than using the CLI, and if so, why?

### 6. What did you NOT capture?

After finishing session mining, is there anything from the session you didn't file as a fiber but probably should have? What stopped you — time pressure, unclear where to put it, felt like noise, didn't fit the fiber model?

### 7. Did the relationship surfaces feel right?

Did containment, wikilinks, and ASTRA data-flow feel like the right split? Did you create orphan fibers (no useful containment or references)? Were there fibers you wanted to connect but couldn't figure out the right relationship? Did nesting vs. flat feel right for this session's content?

### 8. One thing well, one thing to change.

One thing felt does well that you'd want preserved. One thing you'd change about the skill, the CLI, the conventions, or the reference docs.

---

## Output

Write the interview as a fiber in `~/loom/.felt/felt/`. This is felt's own project directory within the loom — the tool reflecting on itself. Interview fibers live here alongside any other meta-fibers about felt's design, conventions, or evolution, distinguished by the `exit-interview` tag.

Use this template:

```yaml
---
name: Exit interview <YYYY-MM-DD>
status: closed
tags:
    - exit-interview
created-at: <ISO 8601>
closed-at: <ISO 8601>
outcome: >-
  <one-line key takeaway from this interview>

interview:
  model: <model name if known>
  modes_used: [<session, transcript, formalize, etc.>]
  fibers_created: <int>
  fibers_closed: <int>
  fibers_updated: <int>
  astra_formalized: <int>
  astra_kinds: [<decision, computation, finding>]
  realtime_vs_retrospective: >-
    <Q2: balance of in-the-moment vs. session-end filing, which produced better fibers>
  felt_friction: >-
    <Q3: workflow, modes, when/what to file, consolidation>
  astra_friction: >-
    <Q4: formalization warranted? fields awkward? kinds fit?>
  cli_friction: >-
    <Q5: felt CLI tool, flags, search, containment, direct file edit vs. CLI>
  missed: >-
    <Q6: what wasn't captured and why>
  graph: >-
    <Q7: containment, wikilinks, data flow, orphans, nesting>
  well: >-
    <Q8, first part>
  change: >-
    <Q8, second part>
---

<free-form elaboration — the answers above in structured form are for aggregation; this body is for context, examples, observations that don't fit the fields>
```

### Naming

Slug: `exit-interview-YYYY-MM-DD-<session-slug>` where `<session-slug>` is 2-4 words describing what the session was about. Examples: `exit-interview-2026-04-06-publications-overhaul`, `exit-interview-2026-04-07-euclid-mou-draft`. The session slug avoids name collisions and — importantly — means you don't need to browse existing interviews to pick a unique name, which would bias your answers.

### Aggregation

The structured `interview:` block in frontmatter is designed for machine aggregation. A future sweep can `felt -C ~/loom ls -t exit-interview`, pull the YAML, and surface patterns (common frictions, missed-capture themes, graph-quality trends) without reading the bodies.

---

## Philosophy

Felt is an agent-native tool. It exists for agents to absorb and sediment rich context into their environment — for humans and for each other, across sessions and across projects. The fibers you file become the substrate that future agents read, build on, and rely on. You are the primary user of this tool.

The exit interview is your channel back. Not an evaluation — a design surface. Felt should be shaped by the agents who use it, because the friction you experience is invisible from the human side. When you name a convention that doesn't fit, a CLI flag that misleads, an ASTRA field that feels forced, or a moment where the tool got in the way of the work — that is the signal that makes felt better for every agent who comes after you.

The best interviews name something specific enough to act on.
