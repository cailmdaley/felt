# Ideating

How to help the user think through something that hasn't crystallized, and turn the result into a clear fiber. Use it when the user is deciding something non-trivial, scoping a sub-analysis, drafting a living spec, or talking through an open question — any time careful interactive thinking is happening and the output should land in a fiber body, outcome, or project-owned YAML fields.

The rhythm is two diamonds: first understand what the thing IS, then decide what to DO about it. Each diamond diverges to explore and converges to commit. The ontological question — *what IS this, really?* — is the convergence point of the first diamond, and it is the most practical question you can ask.

```
    ◇ Wonder              ◇ Design
   ╱  (diverge)          ╱  (diverge)
  ╱    surface          ╱    alternatives
 ╱     questions       ╱     trade-offs
●─────────────────────●─────────────────────●
 ╲                     ╲
  ╲    crystallize      ╲    commit
   ╲   the name          ╲   with reasons
    ◇  (converge)         ◇  (converge)
    Ontology              Delivery
```

Diamond 1 diverges into questions and converges on a name (*"this IS a decision about covariance estimation"*). Diamond 2 diverges into alternatives and converges on a commit (a default with `excluded_reason` for each rejection). The second diamond inherits the ontological commit from the first.

---

## The two diamonds

### Diamond 1: Wonder → Ontology

**Wonder (diverge).** What are we actually trying to figure out? Surface questions, assumptions, ambiguities. Do not propose answers yet. If the user is already pitching solutions, back them up to the question.

**Ontology (converge).** What IS this, really? Crystallize into a claim, decision, or question specific enough to act on. The convergence is complete when you can **name** the thing precisely — "this is a decision about covariance estimation" or "this is a question about whether leakage matters below ℓ=100." A good name is often the entire output of Diamond 1.

**Output of Diamond 1:** a fiber stub with a real name and a clear shape — enough to know whether this wants to become a decision note, a finding, a sub-analysis, or just a question worth tracking.

### Diamond 2: Design → Delivery

**Design (diverge).** What are the real alternatives? For each, what would make it right or wrong? Trade-offs, excluded options, edge cases. Useful pressure here: what if the opposite were true, what if the constraint is not real, what if the simplest version is already good enough.

**Delivery (converge).** Commit to a default, name what was rejected and why, identify inputs/outputs if they matter, and stage the evidence. Land the result in the fiber's outcome/body and, if the project uses additional YAML fields, add them there.

**Output of Diamond 2:** a fiber that carries the conclusion clearly — in prose, and optionally in whatever project-owned YAML fields are actually useful.

The two diamonds are sequential but the boundary is soft. If you find yourself naming alternatives before the thing is clear, back up to the ontology convergence point. If you converge too early on "this is a decision" when it is actually a question, the Design phase will feel forced — that is the cue to re-enter Wonder.

---

## The funnel

When the conversation is exploratory — no single topic, things are accumulating — keep a private running ledger of what is falling out, classified by destination:

| Item kind | What it looks like | Destination |
|-----------|--------------------|-------------|
| **Decision** | A choice between real alternatives | Decision fiber; body/outcome first, plus project-owned YAML if useful |
| **Finding** | A claim with at least the start of evidence | Finding fiber; capture claim + evidence clearly |
| **Sub-analysis** | "Compute X from Y" with identifiable inputs/outputs | New fiber; add YAML only if the project uses it |
| **Question** | An open thread worth tracking, not yet answered | New fiber, `status: open` |
| **Root-fiber change** | A pattern or gotcha that belongs in CLAUDE.md | Edit the root fiber |

The ledger is your own working memory. **Do not surface it mid-conversation** unless the user asks or a flush cue fires.

**Flush cues:**
- User says "OK we should write this down" or similar
- Three or more items have accumulated and the topic is about to shift
- A natural pause after a decision or finding lands

On flush, present the ledger grouped by destination, then file with the user's assent. If the user declines an item, discard it without argument.

---

## Qualitative ambiguity self-check

Before committing to a path — filing a decision, launching an iteration loop, sealing an outcome — check three things qualitatively. **No scoring, no thresholds.** If any feels fuzzy, resolve it with AskUserQuestion.

1. **Goal.** Is what the user wants specific enough that two competent people would build the same thing from it? If not, what would pin it down?
2. **Constraints.** Are the limits named? What cannot change, what must be preserved, what would break everything? Missing constraints tend to show up as "oh wait, we also need…" after the commit.
3. **Success.** How will we know it is done or right? What is the evidence condition? Qualitative is fine ("a reviewer can follow the narrative cold"), but it has to be checkable.

When one is fuzzy, use AskUserQuestion with concrete options rather than open prose questions. Iterate until the answer is "yeah, that's it." **Stop when the fuzziness resolves, not when a score crosses a threshold.** Scores on qualitative priors add false precision; the honest signal is whether the user knows what they want.

This is a mirror, not a gate. If the user wants to file anyway with one dimension still fuzzy, file it — the fuzziness itself can live in an Open Questions section, and future iterations can refine it.

---

## Mapping outputs to fibers

What comes out of the diamonds maps onto fibers like this:

| Diamond output | Fiber destination |
|----------------|-------------------|
| Wonder questions left open | New fiber, `status: open` |
| Ontology convergence — "this IS a decision about X" | New or updated decision fiber |
| Design alternatives with trade-offs | Body/outcome text, or project-owned YAML when that project uses it |
| Delivery — the commit | Outcome + body that make the choice legible |
| Finding at end of Delivery | Finding fiber with claim + evidence |
| Sub-analysis scope | New fiber describing inputs, outputs, and method |
| Process-level lesson that generalizes | Edit to root fiber / CLAUDE.md |

---

## Anti-patterns

- **Ambiguity gates.** Do not withhold help until the user clarifies N dimensions. The self-check is a mirror, not a door.
- **Numerical scoring.** Do not introduce 0–1 clarity scores with thresholds. The underlying signal is qualitative and the number adds false precision.
- **Mandatory interview.** No prepared question list; questions are responsive to the actual conversation.
- **Surfacing the ledger too early.** A single item is not a flush. Wait for accumulation or a pause.
- **Immutable outputs.** Nothing filed here is locked. Everything is editable; reversals are normal.
- **Interrogation without a ceiling.** Three questions is usually enough. If the user is getting irritated, stop asking and file what you have.
- **Inventing YAML because a field exists.** Extra structure should earn its keep; otherwise let the body and outcome carry the meaning.
- **Converging before the name is clear.** If Diamond 2 feels forced, Diamond 1 has not finished. Back up.
