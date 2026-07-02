---
name: shuttle
description: >
  Use this skill in any of these situations.
  **Worker dispatch:** the first user message says Shuttle dispatched,
  resumed, or spawned you ("The orchestration system Shuttle dispatched
  you on this fiber", "Shuttle capture session", …) — you're the worker
  realizing that fiber.
  **Authoring:** the user mentions a **constitution** (writing, drafting,
  "stash this as a constitution", "shuttle this", "let's shuttle <X>"), or
  names a **Shuttle agent** by registry id (`claude-opus`, `claude-fable`,
  `codex`, `pi-sonnet`, … — `felt shuttle agents` lists them) in a context
  that implies dispatch. The phrase **"shuttle [with] <model-name>"** is
  the canonical author trigger.
  **Operator questions:** the user asks about Shuttle itself, the kanban
  board, why a card is or isn't appearing, agent selection / Copilot
  budget, or how to prepare work for autonomous follow-through.
---

# Shuttle

**Activate the `felt` skill too if it isn't already active.** Shuttle operates *on* fibers — every move below (read the constitution, update outcome, file findings) goes through felt.

Shuttle turns fibers into autonomous work. A fiber carrying a `shuttle:` block is a **constitution** — a spec whose body describes a desired state, not a plan. The daemon polls the fiber tree and keeps one tmux **worker** per eligible fiber (carries the block, felt `status: active`). A worker drives toward the desired state, exits at a clean checkpoint with a handoff, and the daemon dispatches fresh workers while the gap remains — work commonly spans sessions. Realization is asymptotic, not a checklist emptied; the constitution itself is amended as the world changes.

The human's surfaces: the **kanban board** (served by the daemon at `:4000`) is a pure view over the same fibers and sessions — stash ideas, launch dispatches, steer workers, review what comes back. The **agent registry** (`felt shuttle agents`) maps a fiber's `shuttle.agent` to the CLI + model each dispatch runs. The daemon ships with felt; `~/dev/felt`'s AGENTS.md is the operator guide.

## Reading by role

| You are | Read |
|---|---|
| A dispatched worker | This file, top to bottom. |
| Authoring a constitution | [references/authoring.md](references/authoring.md) — `felt add` → spec → `felt shuttle install`, drafts vs dispatch, agent selection, human-in-the-loop gates. |
| Operating / debugging the system | [references/operating.md](references/operating.md) — lifecycle verbs, kanban columns, card-missing triage, remote hosts, uninstall. |
| Touching a standing role | [references/standing-roles.md](references/standing-roles.md) — cron lifecycle, run ids, exit handoff, accept semantics. |

## The fiber's surfaces

- **Spec (markdown body)** — a standalone, heading-less **lede** (what this is, why it matters, where it sits, `[[wikilinks]]` woven in), then `## Desired State` — the contract and the one fixed heading: done-conditions in checkable terms, what you and your verifiers measure against — then only sections the fiber has *earned*, named for what they contain. The spec accretes by correction: a wrong constraint gets edited, a sharpened goal gets rewritten. No drive-by notes, no chronology. Depth lives in linked sub-fibers; the spec is a hub, not an archive.
- **`report.html`** (companion file in the fiber directory) — the *human-facing* report: Current State / Findings / Open Questions. Not every constitution wants one. Create it when the constitution asks, or when the product is something a human *reads* — findings, figures, analysis prose — that outgrows the outcome line; code-shaped work whose story is commits + outcome needs none. When one exists: start from [references/report-template.html](references/report-template.html), edit it in place across sessions, and render it with an explicit `:::{embed} report.html` line in the body, placed where the reader should meet it (usually the top).
- **Artifact embeds** — the body can inline any artifact where it helps the reader:

  ```markdown
  :::{embed} build/paper.pdf
  :height: 600        (optional)
  :title: Latest build (optional)
  :::
  ```

  Paths resolve relative to the fiber directory, or absolute — absolute paths resolve on the fiber's owning host (`shuttle.host`), so a remote paper build renders wherever the fiber is opened. Renderer by extension: PDF, HTML iframe, images, audio. The report.html embed is this same mechanism; a fiber that should open with a PDF just embeds it at the top of the body.
- **`outcome:`** — the kanban headline. One or two sentences: where the work is, what the reader does next. Rewritten every session, not appended. When blocked, lead with "Blocked: …".
- **`## Status`** (a section in the constitution body) — the handoff. Rewritten each session, never appended: it holds the *now*, not a session log. The next worker reads it on arrival and lands warm; you write it at exit — what landed, where you got stuck, what to know on arrival. Multi-paragraph prose welcome.

None of these is a status flag; all are always-current. Outcome and `## Status` stay plain text (agents chain sessions on them); the report is where humans read, with full visual freedom.

## Finding your fiber

Your dispatch prompt opens with the fiber ID and the felt store, not the fiber content — read fresh from disk so mid-session edits to the constitution are picked up rather than stale-snapshot:

```bash
felt show <fiber-id>                      # from the project dir — try this first
felt -C <felt-store> show <fiber-id>      # fallback when cwd's .felt view misses
```

If `felt show` can't find the fiber, don't grope — go straight to `-C <felt-store>`. The store path in the prompt is the store the daemon dispatched you from.

## Loop

1. **Survey.** The survey is where you internalize **why** before the **what** — not a checklist, a world-model. Read until you hold the user's intent clearly enough to move ambitiously inside it.

   - Read the constitution fresh (see "Finding your fiber"). If `report.html` exists, read it too.
   - Read the previous session's handoff: the `## Status` block.
   - Check `git log` for what's already happened in the fiber's directory and the surrounding code.
   - Skim sub-fibers (decisions, findings, gotchas, staged plans). If a sibling finding lays out a staged plan, follow it rather than re-deriving scope.
   - Follow claims about the system back to the code that grounds them. The constitution is your contract; the code is the ground truth.

2. **Work.** Before deciding what to do, sit with the full shape of the problem. The smell test before you commit *or* block: **would this constraint surprise the human?** If yes, you haven't sat long enough. Many decisions that look like they need the human are inferable from system purpose + codebase — "what is this software for?" answered seriously usually settles whether a capability is structurally important. Genuine taste questions are narrower than they feel.

   **Give sub-goals their own context.** Subagent and workflow tools are context architecture first, parallelism second: decompose into pieces that each want a clean window — bulk reading, mechanical sweeps, independent verification — while your own context keeps the management view. That separation lets one session carry an arc that used to span dispatches. On long building runs, set a verification cadence: every few substantial changes, a fresh-context subagent checks the work against Desired State — fresh verifiers outperform self-critique. Without subagent tools the same walls exist across dispatches: each redispatch is a fresh window and the daemon holds the loop, so do the arc across sessions rather than hand-rolling tmux loops (`/loop` covers the zero-infra, self-paced case).

3. **Felt.** Before exiting: update `report.html` (rewrite Current State, append earned Findings, refresh Open Questions); rewrite `outcome:`; correct the spec if the session sharpened it; file crystallizations as sub-fibers (decisions, findings, gotchas — not iteration-numbered debris); commit with clear messages.

4. **Handoff, then exit.** Rewrite the constitution's `## Status` block, then your FINAL action is `felt shuttle handoff <fiber-id>` — a tool action, not prose. It stamps the clean-exit marker into the fiber and ends your own tmux session in one move (no separate `kill $PPID`). The marker is load-bearing: it tells the daemon you closed cleanly, so the next dispatch loops a fresh worker that reads your `## Status`. Without it, a session that died mid-thought is indistinguishable from a clean exit, and the daemon resumes your transcript instead.

### When to stop

The `## Status` block plus the constitution recovers most of a warm world-model on the next dispatch — **exiting earlier is cheaper than you think.** A clean handoff well before auto-compact beats pushing through it. Stop when one of these is true:

- **The desired state is realized** (see Exit semantics for the review requirement).
- **You're genuinely blocked** on something only the human can supply.
- **Context is half-full.** Exit at the next sub-task boundary after you cross half; write the handoff from full attention. (Subagent-capable workers hit this later — delegation keeps the orchestrating context lean — but the line doesn't move.)
- **Clean break.** If the next step is both heavy AND disjoint — fresh problem space, doesn't need the world-model you just built — exit and let the next session start uncluttered.

## Rules

**State, not checklist.** The constitution describes what "done" looks like, not a sequence of steps. Each dispatch surveys reality-against-desired-state and picks the highest-value slice itself; sequencing is emergent.

**Discoverable updates.** Commits, fibers, test results, files in the fiber dir — not progress logs scattered in the body. The `## Status` block is the explicit handoff exception.

**Pointers, not snapshots.** If you learn something stable, update the constitution — the lede, Desired State, or the earned section where it belongs.

**Prefer doing the work.** You have authority. Trust the constitution, don't ask permission, and don't avoid ambitious moves just because they span sessions — Shuttle redispatches. When the work involves a load-bearing model choice or a capability-removing pivot, surface alternatives in the artifact rather than withholding the work to ask: a "considered alternatives" note in the body or outcome beats filing a question fiber and exiting. The failure mode to guard against is using "the human knows things I don't" as cover for not thinking hard enough.

**Questions go where they'll be seen.** In `outcome:` (kanban card) or `## Status` (the next reader's landing) — open `-t question` fibers sediment unanswered.

**Long-running jobs:** stream background processes with the `Monitor` tool, or `run_in_background` Bash for one-shot waits. Shepherd to completion before exiting; don't fire-and-forget.

## Exit semantics

The status you set before you hand off determines what happens next. A normal chat final response is not a worker exit, and "resumed" means "same transcript," not a license to idle.

**When to stay interactive.** Hand off when the direction is settled. When it isn't, stay alive at a clean checkpoint instead: the directive or constitution says a human will attach (a "wait for me" signal, a 2FA gate, a send-in-his-voice step), or the state of the work makes it likely the human wants to weigh in before the next move — feedback mid-loop, taste calls still open. Keep the fiber `active`; the usual close + `felt shuttle handoff` waits for the human's signal.

**Pinned roles never exit on idle.** A `kind: pinned` fiber (status hub, debug intake) is a standing interface a human drives, not a one-shot task. The daemon never auto-dispatches it — a worker that exits goes **dark** until the human manually resumes — so keep the fiber current as you work, and when you run out of immediate work, stay alive and wait for the next message. The session ends only when the human parks the role (`active → open`).

Three cases, asked in order:

1. **Desired state realized?** → set `status: closed`, exit. The fiber lands in "Awaiting review"; the human accepts (`tempered: true`) or flips back to `active`.

   **Fresh eyes before close.** Substantive work (code, configs, the product — not the fiber's own surfaces) needs an independent review before the session that produced it may close. With subagent tools: spawn a fresh reviewer over the diff-against-constitution (adversarial workflow pass for complex work) and close in-session once it comes back clean. Without: leave `active` and exit (case 3); the next dispatch reviews with fresh eyes and closes. A session that changed nothing substantive may close directly — and editing the constitution, `report.html`, `outcome`, or `## Status` is handoff, not work product; it never blocks close. If your review found the report misread the code, fixing the report *is* the review.

2. **Blocked on something only the human can answer?** → set `status: closed`, exit, lead the outcome with "Blocked: …" so the action reads "answer," not "review." Most apparent blocks resolve into "I haven't sat with the problem long enough."

3. **More work, not blocked?** Status stays `active`; just `felt shuttle handoff`. The next worker reads `## Status` and continues.

**`tempered: true` is human-only — never self-temper.** **Don't self-uninstall the shuttle block on close** — the block stays as historical record (see operating.md, "When to uninstall"). If you arrive and the work is plainly already done, update the outcome, set `status: closed`, exit — don't invent further work.
