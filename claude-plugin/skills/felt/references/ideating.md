# Ideating

Use this when the user is thinking in motion and the shape has not landed yet: a decision, question, finding, sub-analysis, constitution, or concern that should become a fiber but is still fuzzy. The job is to help the thing crystallize, then file the shape while it is fresh.

Ideating is not a general interview script. It is a rhythm for turning live thought into a durable fiber.

---

## The Two Diamonds

First understand what the thing **is**. Then decide what to **do** about it.

```text
    Diamond 1                 Diamond 2
    Wonder                    Design
      diverge                   diverge
        questions                 alternatives
        assumptions               trade-offs
          \                         \
           Ontology                  Delivery
           converge                  converge
           name the thing            commit the shape
```

### Diamond 1: Wonder -> Ontology

Wonder surfaces the real question. Do not rush to answers while the object is still unstable.

Ask:

- What are we actually trying to figure out?
- What word is doing too much work?
- Is this a decision, a finding, a question, a task, or a reference?
- What would make two competent agents file the same fiber from this?

Ontology lands the name. A good name often does half the work:

- "this is a decision about covariance estimation"
- "this is a question about whether leakage matters below ell=100"
- "this is a gotcha about plugin cache version drift"

File a stub once the name is clear enough:

```bash
felt add <slug> "Precise name" -s open
```

Use status only if it is a real todo/question. Otherwise leave it statusless until there is an action state.

### Diamond 2: Design -> Delivery

Design explores alternatives after the object is named:

- What are the real options?
- What would make each option right or wrong?
- What are we explicitly not doing?
- What evidence would change the decision?

Delivery commits the fiber shape:

- outcome if a conclusion landed;
- body if context matters;
- `excluded_reason` or project-owned YAML only when that project owns the schema;
- `felt history` for chronology, not body version notes;
- nesting or wikilinks for relationships.

Close when the thread resolved:

```bash
felt edit <id> --status closed --outcome "What changed, learned, or was decided."
```

---

## Stances

Default is plain conversation. Use one stance only when it helps, then drop it.

| Stance | Use when | Move |
|---|---|---|
| Socratic | assumptions are hidden | ask what must be true |
| Ontologist | the object is poorly named | ask what this really is |
| Contrarian | the frame may be wrong | test the opposite |
| Simplifier | complexity is accumulating | ask what can be removed |
| Researcher | a claim needs evidence | ask what is actually known |
| Architect | friction keeps recurring | ask what structure is wrong |

Do not pipeline stances. If one or two questions reveal the shape, stop questioning and file.

---

## Funnel

During open-ended conversation, keep a small private ledger of things that may need filing:

| Kind | Destination |
|---|---|
| Decision | decision fiber with alternatives/reasoning |
| Finding | finding fiber with evidence |
| Question | open fiber |
| Task/sub-analysis | open or active fiber with inputs/outputs if useful |
| Durable pattern | doc/root fiber or CLAUDE.md pointer |

Flush the ledger when:

- the user says to write it down;
- three or more items have accumulated;
- the topic is about to shift;
- a decision/finding lands cleanly.

When flushing, file directly if the destination is obvious. Ask only when classification or scope is genuinely ambiguous.

---

## Ambiguity Check

Before sealing an outcome, launching a constitution, or closing a decision, check three things qualitatively:

1. **Goal:** is the object specific enough?
2. **Constraints:** what cannot change?
3. **Success:** what would show this is right or done?

No scores, no thresholds. If one is fuzzy, resolve it with one to three concrete choices. If the user wants to proceed anyway, file the fuzziness as an open question.

---

## Mapping

| What landed | Fiber move |
|---|---|
| Name only | create statusless or open stub |
| Open question | open fiber |
| Decision | outcome + rationale in body |
| Finding | claim + evidence anchor |
| Task/sub-analysis | inputs, expected outputs, success condition |
| Reusable lesson | doc/root fiber, then link/nest related leaves |

---

## Anti-Patterns

- **Interrogation.** Questions should clarify, not perform depth.
- **Answering before naming.** If delivery feels forced, return to ontology.
- **Status as importance.** Open/active are todo states.
- **YAML inflation.** Extra structure must earn its keep.
- **Ledger theater.** A ledger that never files anything is just hidden notes.
- **Frozen artifacts.** Fibers can be corrected as the thinking sharpens.
