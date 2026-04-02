---
title: Lightcone UX meeting 2026-03-31
status: closed
tags:
    - meeting
    - lightcone
    - doc
created-at: 2026-04-02T11:31:35.872166+02:00
outcome: 'Four-person meeting (Cail, François Lanusse, Liam Holden Parker, Alexandre Boucaud) on UX/UI for Lightcone Research stack and ASTRA spec. Key convergences: exploration layer separate from publishable ASTRA spec; the funnel as missing concept; briefing-not-dashboard; three UX views (analysis/delta/exploration); modular skills not sequential. May 11 announcement target.'
---

(lightcone-ux-meeting-2026-03-31)=
# Lightcone UX Meeting — 31 March 2026

**Participants:** Cail Daley, François Lanusse, Liam Holden Parker, Alexandre Boucaud

A three-hour conversation about the UX of AI-mediated research — how to explore, how to formalize, how to come back and understand what happened. The meeting covered the Lightcone Research stack (ASTRA spec, Prism agent layer, Tessera UI), its upcoming public announcement, and how the pieces should fit together for working scientists.

---

## Timeline

**May 11:** Public announcement. Three things go out together:

1. ASTRA as an open spec for science
2. The Lightcone Research AI stack
3. A set of reproduced papers across fields, formatted in the ASTRA system

The pitch: a researcher lands on the website and within 30 seconds understands the value. They see a paper rendered in this format, click through the results, see the decisions that were made, and can download and extend it. The first impression has to be good — the UI/UX for exploring information needs to clear that bar.

**End of July:** Hackathon in Berkeley. Part of announcement is a registration call. Small group, travel funded. The goal is to kickstart the ecosystem: new skills, new agents, new projects that plug into the standard.

**This week:** UX/UI focus and ASTRA revisions. **Next week:** Lower bandwidth (François in Cambridge, Liam on other work). **Week after:** Prototype pieces. **End of April:** Preview to an extended group; after that, nothing changes except bug fixes.

**Funding:** Proposals submitted through a family office. The office approved; now the principal needs to sign off.

---

## The three dimensions of UX

The conversation kept returning to three distinct views, each with different design requirements. Alexandre named the third explicitly: human accessibility is its own axis, separate from research exploration and publication.

### 1. Analysis view — the completed analysis

What a reader sees when they encounter a finished analysis for the first time. Should feel like a briefing, not a dashboard. Lead with scientific findings, not pipeline status. Group by question, not by pipeline step.

The current Tessera prototype looks too much like a dashboard. Dashboards monitor; science argues. The analysis view needs narrative structure — an argument that builds, with evidence available on demand.

### 2. Research updates — the delta view

When you come back after the agent has been working (hours, days), what changed? This is the fan-in tool. You went away, the agent fanned out, now you need to reconverge with your own mental model.

The principle: show the delta, not the full state. Highlight what's new, let the researcher review and approve each piece. Decisions can be flagged as human-reviewed or not. The danger — losing control, saying yes-yes-yes without understanding — is exactly the skiing metaphor: once you're out of your skis, everything compounds and you can't get back.

### 3. Research exploration — planning and doing

The hardest to design. Two sub-modes:

- **Freeform:** Following your nose. No predefined output, just curiosity and intuition. Especially common at the start of a project.
- **Directed:** Known output, iterating to get there. Training a neural network, calibrating a model. One sub-analysis, progressively refined.

The question of whether this view needs UI at all is open. If everything gets astrified after the fact, maybe exploration is just terminal work and the view appears only at the synthesis stage.

Alexandre raised a specific timing question for the literature skill: should you check if something has been published *before* or *after* exploration? His concern: checking at the beginning sometimes prevents exploration because the system doesn't yet know where you're headed. This suggests the literature skill should be available throughout, not gated at the beginning.

---

## The exploration–formalization debate

The core tension: when does freeform exploration become formal knowledge?

**Liam's position:** Mandate ASTRA sub-analyses even during exploration. The agent can handle the overhead — defining inputs, outputs, findings for each experiment. This preserves provenance: when you try 25 things and one works, you can trace exactly why you chose it.

**François's position:** Enforcing formalization during exploration hinders discovery. The freeform phase should be maximally free. The formalization happens after, as a separate "astrify" step that compactifies the exploration into publishable knowledge. He pointed to Cosmos as a cautionary example: their enforced structure gets in the way of exploration.

**Cail's position:** Everything should be written down and searchable, always. The power of agents is that they can search files and recover information — you just need text on disk. Fibers work because Claude dumps what it's doing at every step. The question is whether that dump can have ASTRA's structure without losing the freedom. Willing to try: fibers with ASTRA frontmatter, every action formalized on the fly.

**Convergence:** The publishable ASTRA layer stays clean and formal — this is the system of record. Below that, exploration can happen however the user wants. Lightcone provides one default implementation (their agent layer) that tracks everything, but users can bring their own workflow. The interface between exploration and ASTRA is the "astrify" command: after freeform work, funnel the results into formal spec. Whether the agent also maintains ASTRA structure during exploration is an open experiment — Cail is testing this approach.

---

## The funnel

Everyone agreed this is the missing concept. ASTRA has decisions, sub-analyses, inputs, outputs — but no native many-to-one synthesis. You fan out into 30 experiments. Three matter, 27 don't. You need a node that pulls findings together: a summary that extracts the compact representation for both humans and agents.

This is functionally the fan-out/fan-in pattern. A revolution produces ideas; a congress makes them functional. The research parallel: explore freely, then consolidate into something you can stand behind.

Proposed solutions:

- **Summary nodes / doc nodes** — with a mandate to keep them current. Problem: summaries go stale.
- **Astrify command** — an explicit step that pulls findings from exploration into the formal layer. Could create sub-analyses after the fact, linking the code and outputs that matter.
- **Hierarchical sub-analyses** — the funnel itself is a sub-analysis whose inputs are the outputs of other sub-analyses.

The funnel also relates to the storytelling question: how do individual findings compose into an argument? This is the synthesis part of writing a paper.

---

## Contradictory findings

Cail raised this as a serious worry. Different sessions can produce conflicting conclusions — you looked at a different plot, forgot a correction, the agent hallucinated, you read the wrong file. Once contradictory findings enter the system, confusion compounds.

ASTRA's formal structure could help: if findings must be supported by code-produced outputs, you can traverse provenance and verify. The more structured the exploration, the easier this verification becomes.

No resolution on how to do this well. Everyone agreed it's critical.

---

## Progressive disclosure

Converged on three levels:

| Level | Content | What you see |
|-------|---------|-------------|
| **Spine** | Paper sections / sub-analysis status | Verdict sentence, decision summary, worst-status badge |
| **Decisions** | Per-decision detail | Declarative title (from outcome or finding), evidence count, status |
| **Evidence** | Fibers, plots, outputs | Full body, output plots, upstream chain |

Two clicks maximum. Shneiderman's mantra: overview first, zoom and filter, details on demand. Collapsed branches show count + worst status, never blank. Fiber outcomes serve as the declarative titles.

The spine follows paper structure: background → methodology → validation → results → synthesis. Horizontal axis is this progression; vertical is investigation depth.

---

## Spatial layout: 2D maps vs trees vs documents

Unresolved. The positions:

**For 2D maps:** You build a mental map of where things are. Spatial proximity lets you see cross-cutting relationships (e.g., N(z) calibration feeds into cosmological parameter estimation). A tree is one-dimensional; a map captures relationships.

**Against:** If you give someone else's map to a newcomer, they're lost. Spatial position needs spatial meaning. Trees have clear semantics (parent-child, depth). Alexandre: spatial layouts work as long as there's also spatial meaning. François: wants to see an example where this works.

**Possible compromise:** A document with hyperlinks IS a graph, and can be rendered as a 2D map. Both views on the same data — people start with the document (natural for discovery) and graduate to the map (natural for navigation once you know the territory). A minimap alongside the document, like games use.

---

## Insights: what they are, how to store them

The current ASTRA insight format is three fields. Everyone agreed it needs to be richer. An insight isn't a sentence and some quotes — it's an argument.

**Agreed format direction:** Markdown with YAML frontmatter. The YAML carries structured fields (evidence links, decisions, inputs/outputs, status). The markdown body carries the argument. This gets both machine-readability (for search, for verification) and expressiveness (for the reasoning).

Alexandre suggested a naming convention: standalone publishable analyses use `astra.yaml`; sub-analyses that live inside a broader analysis could use `astra.sub.yaml` to signal they're components.

---

## Narrative and storytelling

Should ASTRA capture the storytelling — the argument that ties findings together — or is that a separate layer?

Arguments for including it:
- **Agents work better with narrative context.** Explaining *why* you're doing something improves the quality of the agent's work.
- **Findings compose into further findings.** Discussion sections mix insights from different sub-analyses into higher-order conclusions.
- **The analysis view needs it.** If the entry point is a briefing, someone has to write it.

Alexandre's strong position: keep the human in the loop for storytelling. Tools should help write papers, not write them autonomously. His concern: the loss of skills by relying too much on AI power. The tool empowers; it doesn't replace.

**No final decision.** The relationship between decisions, narrative structure, and explanatory text warrants its own design session.

---

## Skills and agent workflow

Beta tester feedback: the structured, sequential workflow gets in the way when users just want to do something. The `prism init` interview is fine for onboarding, but during actual research, rigid sequencing is counterproductive.

**Agreed direction:** Modular skills that surface at natural points. A `/literature` skill for checking the literature. A `/brainstorm` skill. An astrify skill. Users compose them as needed, not in a prescribed order.

Session start hooks (injecting open fibers, recent work context) were praised as powerful — they make agent pickup seamless without the user having to retype context.

The CLAUDE.md template problem was acknowledged: Prism's large CLAUDE.md stomps user files. Reference content belongs in skills, not in CLAUDE.md.

François also emphasized that the stack should be agent-agnostic. They want to support alternative agent frameworks that return results capturable in ASTRA format.

---

## DESI NFZ as multiverse demo

A concrete suggestion for the May 11 demo: a DESI paper where the choice of N(z) fiducials moves cosmology by ~1.5σ on real data, but shows no difference in mocks. This is exactly the kind of moment that would sell the multiverse concept in 30 seconds.

---

## Concrete next steps

**Cail (this week):**
- Test ASTRA sub-analyses for everything — fibers with ASTRA frontmatter, every action formalized on the fly
- Bring results to Friday meeting (April 3) with evidence of how it works in practice
- Look for fields that are missing or unnecessary in the ASTRA schema

**Liam (this week):**
- Analysis view prototype
- Joint proposal with François for analysis view + research exploration view design

**François:**
- Iterate on spec for document structure (Google Doc for commenting)
- Coordinate Friday session (at Gallicano or Zoom)

**Alexandre:**
- Execution layer — making things run without manual intervention on any platform
- UX/UI feedback

**Week after next:** Each person picks a prototype component. Within two weeks: working prototype with revised UX.

**Notion:** François created a meetings entry in the team Notion. Meeting notes go there. They also took a photo of the whiteboard for reference.

---

## Constraints that cannot be broken

- Self-contained directory structure per sub-analysis
- `astra.yaml` inside each sub-level
- Universes/baseline can be auto-generated (if only baseline, you just have one set of decisions)
- `astra validate` and `astra init` must work as CLI entry points — this is what makes it easy for Claude to create sub-analyses on the fly
- Nothing is public yet. Work on branches in existing repos. Don't create new public repos.

---

## Open questions for future sessions

1. **The funnel spec** — what does a synthesis node actually look like in ASTRA?
2. **Insight depth** — how much argument is enough? When does an insight become a paper section?
3. **Contradictory findings** — automated consistency checking between findings across the system
4. **2D vs 1D** — need a working example of a 2D layout that adds value over a tree/document before committing
5. **Narrative structure in ASTRA** — does the spec capture storytelling, or is that always a layer on top?
6. **Agent exploration limits** — how much to let an agent fan out before mandating consolidation
