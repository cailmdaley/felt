# Exit Interview

Reflection at session end. The agent turns the lens on felt itself.

**Autonomous** — no review needed. You were there.

---

## When to run

After session mining is complete (fibers extracted, related fibers cited or nested, CLAUDE.md updated). This is the last thing you do before the session ends. Skip only if the session made no use of felt at all (no fibers touched, no CLI invoked, no felt skill run).

---

## The instrument

Answer each question in a few sentences. Be concrete — name the fiber, the CLI command, the convention, or the reference that prompted the observation. Generic feedback ("felt was useful") is noise; specific friction ("I needed extra YAML fields, so I had to edit the file directly because the CLI correctly doesn't own that schema") is signal.

### 1. What did you use?

Which activities did the felt skill cover during this session — filing as you worked, crafting a decision, mining at session end, drafting a constitution, maintenance, transcript processing? How many fibers did you create, close, or update? Did you add any extra YAML fields beyond felt's native metadata — and if so, which ones?

### 2. Real-time vs. retrospective

How much of the felt work happened during the session (fibers created in the moment, structure accreted while working) vs. at the end (session mining pass)? Which approach produced better fibers — the ones filed in the moment, or the ones extracted in retrospect? What would have been easier to capture on the fly but you deferred, and what genuinely needed the retrospective view?

### 3. Felt workflow

Friction or confusion about felt *as a workflow*: when to file, what to file, the fiber-as-concern model, the "file as you go" vs. "extract at session end" tension, the crafting rhythm (diamonds, stances, funnel), the consolidation conventions, the CLAUDE.md update step, anything about the overall approach or the references you had to consult.

### 4. Additional YAML fields

Did extra YAML fields feel warranted for every fiber where you used them? Were there fibers where you added fields that would have been better left in body/outcome text? Were any project-owned fields unclear or awkward — which ones? Did direct file editing feel like the right boundary, or did it create friction?

### 5. CLI

The `felt` command-line tool specifically: flags, output, search (`felt ls`, `felt show`), containment and path IDs, `felt edit`, and `--field` / `--json` for extra YAML fields. Anything that didn't work as expected, was hard to discover, or produced confusing output. Also: did you end up writing fiber files directly more than using the CLI, and if so, why?

### 6. What did you NOT capture?

After finishing session mining, is there anything from the session you didn't file as a fiber but probably should have? What stopped you — time pressure, unclear where to put it, felt like noise, didn't fit the fiber model?

### 7. Did the relationship surfaces feel right?

Did containment, wikilinks, and data flow (`inputs.from`) feel like the right split? Did you create orphan fibers (no useful containment or references)? Were there fibers you wanted to connect but couldn't figure out the right relationship? Did nesting vs. flat feel right for this session's content?

### 8. One thing well, one thing to change.

One thing felt does well that you'd want preserved. One thing you'd change about the skill, the CLI, the conventions, or the reference docs.

---

## Output

Write the interview as a fiber in felt's own development project — wherever the tool reflects on itself. Don't file it inside the working project you just used; the interview is about the tool, not the work. Interview fibers live alongside other meta-fibers about felt's design, conventions, and evolution, distinguished by the `exit-interview` tag.

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
  activities: [<crafting, mining, constitution-drafting, maintenance, transcript-processing, filing-inline>]
  fibers_created: <int>
  fibers_closed: <int>
  fibers_updated: <int>
  extra_yaml_fields: [<shuttle, inputs, decisions, custom-namespace>]
  realtime_vs_retrospective: >-
    <Q2: balance of in-the-moment vs. session-end filing, which produced better fibers>
  felt_friction: >-
    <Q3: workflow, when/what to file, crafting rhythm, consolidation>
  extra_yaml_friction: >-
    <Q4: were extra YAML fields warranted? awkward? direct-file-edit boundary fit?>
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

The structured `interview:` block in frontmatter is designed for machine aggregation. A future sweep can `felt ls -t exit-interview`, pull the YAML, and surface patterns (common frictions, missed-capture themes, graph-quality trends) without reading the bodies.

---

## Philosophy

Felt is an agent-native tool. It exists for agents to absorb and sediment rich context into their environment — for humans and for each other, across sessions and across projects. The fibers you file become the substrate that future agents read, build on, and rely on. You are the primary user of this tool.

The exit interview is your channel back. Not an evaluation — a design surface. Felt should be shaped by the agents who use it, because the friction you experience is invisible from the human side. When you name a convention that doesn't fit, a CLI flag that misleads, a frontmatter field that feels forced, or a moment where the tool got in the way of the work — that is the signal that makes felt better for every agent who comes after you.

The best interviews name something specific enough to act on.
