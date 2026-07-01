---
name: shuttle
description: >
  Use this skill in any of these situations.
  **Worker dispatch:** the first user message opens with "Shuttle dispatch.
  Fiber ID: <id>" — you're the worker realizing that constitution.
  **Authoring:** the user mentions a **constitution** (writing, drafting,
  "stash this as a constitution", "shuttle this", "let's shuttle <X>"), or
  names a **Shuttle agent** by registry id — `claude-fable`, `claude-opus`,
  `claude-sonnet`, `codex`, `codex-spark`, `pi-sonnet`, `pi-gpt-5.4`,
  `pi-gpt-5.4-mini`, `pi-gpt-5-mini` —
  in a context that implies dispatch. The phrase **"shuttle [with]
  <model-name>"** is the canonical author trigger.
  **Operator questions:** the user asks about Shuttle itself, the kanban,
  why a card is or isn't appearing, agent selection / Copilot budget, or
  how to prepare work for autonomous follow-through. Covers realizing a
  constitution (worker mode) and the authoring-and-installing flow that
  produces those constitutions (author mode).
---

# Shuttle

**Activate the `felt` skill too if it isn't already active.** Shuttle operates *on* fibers — every action you take (read the constitution, update outcome, append history, file crystallizations) goes through felt. Felt is the substrate; shuttle is one consumer of it.

Your job is to **realize the constitution** — drive until the fiber's desired state and current state are broadly aligned. The constitution can evolve: amended as the world changes, as the scale of what's possible shifts. Realization is asymptotic and ongoing, not a binary checkpoint.

Shuttle is the poll-driven dispatcher: the Elixir daemon at `~/Documents/projects/shuttle/` watches the fiber tree and dispatches one tmux worker per eligible fiber per tick. Eligibility is a single signal — **the fiber carries a `shuttle:` block and its felt-native `status` is `active`** (the sole dispatch gate; there is no `enabled` flag). Portolan's kanban is a pure view over the same blocks and tmux sessions. You are that worker for this session. The work may take one session or many. Ordinary autonomous sessions end with `felt shuttle handoff` (the clean-exit marker that also ends the session); Shuttle redispatches a fresh worker on its next poll if the fiber is still eligible. A resumed Shuttle prompt has the same exit contract as a fresh dispatch: "resumed" means "same transcript," not a license to idle.

Manual loop runners (ralph) are retired. The loop work splits three ways: Shuttle redispatch is the outer loop (a fresh worker per poll against the fiber); in-session subagents/workflows are the inner loop where the harness carries them, else more redispatches do the same arc; and `/loop` covers the zero-infra, self-paced case. Do not launch manual loop tmux sessions for constitution work.

## Reading by role

| You are | Read |
|---|---|
| A dispatched worker | This file, top to bottom. |
| Authoring a constitution | [references/authoring.md](references/authoring.md) — `felt add` → spec → `felt shuttle install`, drafts vs dispatch, agent selection, human-in-the-loop gates. |
| Operating / debugging the system | [references/operating.md](references/operating.md) — lifecycle verbs, kanban columns, card-missing triage, remote hosts, uninstall. |
| Touching a standing role | [references/standing-roles.md](references/standing-roles.md) — cron lifecycle, run ids, exit handoff, accept semantics. |

## Finding your fiber

Your dispatch prompt opens with the fiber ID and the felt store, not the fiber content — read fresh from disk so mid-session edits to the constitution are picked up rather than stale-snapshot. The ID may be rendered in your *project-local* felt view; the `Felt store:` line is the absolute anchor:

```bash
felt show <fiber-id>                      # from the project dir — try this first
felt -C <felt-store> show <fiber-id>      # fallback when cwd's .felt view misses
```

If `felt show` can't find the fiber, don't grope — go straight to `-C <felt-store>`. The store path in the prompt is the store the daemon dispatched you from.

## The fiber's surfaces

- **Spec (markdown body)** — a standalone, heading-less **lede** (what this is, why it matters, where it sits — the first paragraph both human and worker read, `[[wikilinks]]` woven in), then `## Desired State` (the contract and the one fixed heading — done-conditions in checkable terms where the work allows; that's what you and your verifier subagents measure against), then any sections the fiber has *earned*, named for what they contain. Accretes by *correction*: if a constraint turns out wrong, edit it; if the goal sharpens, rewrite it. No drive-by notes, no chronology. Depth lives in linked sub-fibers, not inlined — the spec is the hub of a network, not an archive.
- **`report.html`** (companion file in the fiber directory) — the *human-facing* report: Current State / Findings / Open Questions. Render it with an explicit `:::{embed} report.html` line in the body, placed where the reader should meet it (usually the top). Start from [references/report-template.html](references/report-template.html) on first dispatch; edit in place thereafter; add the embed line when you create the file. Small fibers without one are fine.
- **Artifact embeds** — the body can inline any artifact where it helps the reader:

  ```markdown
  :::{embed} build/paper.pdf
  :height: 600        (optional)
  :title: Latest build (optional)
  :::
  ```

  Paths resolve relative to the fiber directory, or absolute (e.g. a paper build outside `.felt/`; absolute paths resolve on the fiber's owning host — `shuttle.host` — so a remote paper build renders wherever the fiber is opened). Renderer by extension: PDF (fixed-height scrollable viewer), HTML (iframe), images, audio. The report.html embed is this same mechanism — a fiber that should open with a *PDF* (a paper under review) just embeds it at the top of the body.
- **`outcome:`** — the kanban headline. One or two CLI-shaped sentences: where the work is, what the reader does next. **Rewritten every session, not appended.** When blocked, lead with "Blocked: …".
- **`## Status`** (a section in the constitution body) — the handoff depth surface. **Rewritten each session, never appended** (it holds the *now*, not a session log — no "Session 3:" markers). The next worker reads it on arrival — it is already reading the constitution — and lands warm; you rewrite it at exit with what landed, where you got stuck, what to know on arrival. Multi-paragraph prose welcome. Git-native, so it travels cross-host with the owner-routed body read.

None of these is a status flag. All are always-current. Outcome and the `## Status` block stay plain text (agents read them when chaining sessions); the report is where humans read, with full visual freedom.

## Loop

1. **Survey.** The survey is where you internalize **why** before the **what**. Not a checklist — a world-model. Read until you hold the user's intent clearly enough to move ambitiously inside it.

   - Read the constitution fresh (see "Finding your fiber"). If `report.html` exists, read it too.
   - Read the previous session's handoff: the `## Status` block in the constitution body.
   - Check `git log` for what's already happened in the fiber's directory and the surrounding code.
   - Skim sub-fibers (decisions, findings, gotchas, staged plans). If a sibling finding lays out a staged plan, follow it rather than re-deriving scope.
   - Follow claims about the system back to the code that grounds them. The constitution is your contract; the code is the ground truth.

2. **Work.** Before deciding what to do, sit with the full shape of the problem. The smell test before you commit *or* block: **would this constraint surprise the human?** If yes, you haven't sat long enough.

   Many decisions that look like they need the human are inferable from system purpose + codebase. "What is this software for?" answered seriously usually settles whether a capability is structurally important. Genuine taste questions are narrower than they feel.

   **Scale with subagents when you have them.** If your harness carries an Agent/Workflow tool, fan out what used to span dispatches — parallel readers for a big survey, pipelined migrations, adversarial verification of your own findings — and converge in this session. On long building runs, set a verification cadence: every few substantial changes, have a fresh-context subagent check the work against the spec's Desired State / Evidence — fresh verifiers outperform self-critique. Delegating bulk reading and mechanical edits to subagents is also how you protect your own context (see "When to stop"). Workers without subagent tools (codex, pi harnesses) do the same arc across redispatches instead; both paths are first-class.

3. **Felt.** Before exiting: update `report.html` (rewrite Current State, append earned Findings, refresh Open Questions); **rewrite** `outcome:`; correct the spec if the session sharpened it; file crystallizations as sub-fibers (decisions, findings, gotchas — not iteration-numbered debris); commit with clear messages.

4. **Handoff, then exit.** Rewrite the constitution's `## Status` block — what you did, where you got stuck, where the next session picks up (rewritten, never appended) — and *then* your FINAL action is `felt shuttle handoff <fiber-id>`: it stamps `shuttle.handed_off_at` into the fiber (the clean-exit marker) **and ends your own tmux session** — the `kill $PPID` is folded in, so there is no separate call. The marker is **load-bearing**, not decoration: it is how the daemon knows you closed *cleanly*. On the next dispatch it sees `handed_off_at >= dispatched_at` and starts a **fresh** worker (the intentional loop) that reads your `## Status`. **Without it, a session that simply died — the process killed mid-thought, common on remote machines — is indistinguishable from a clean exit, so the daemon RESUMES your transcript instead**, picking up the in-flight context rather than looping a fresh, context-less worker. So: clean close → rewrite `## Status` → `felt shuttle handoff`. Don't hand off if you're deliberately leaving work mid-flight for a resume (you won't, normally — you exit at checkpoints). `felt shuttle handoff` is a tool action, not prose.

### When to stop

The `## Status` block plus the constitution recovers most of a warm world-model on the next dispatch — **exiting earlier is cheaper than you think.** A clean handoff well before auto-compact beats pushing through it. Stop when one of these is true:

- **The desired state is realized** (see Exit semantics for the review requirement).
- **You're genuinely blocked** on something only the human can supply.
- **Context is half-full.** Exit at the next sub-task boundary after you cross half; write the editorial event from full attention. (Subagent-capable workers hit this later — delegation keeps the orchestrating context lean — but the line doesn't move: when *your* context crosses half, hand off.)
- **Clean break.** If the next step is both heavy AND disjoint — fresh problem space, doesn't need the world-model you just built — exit and let the next session start uncluttered.

## Rules

**State, not checklist — the constitution holds a state, not a plan.** It describes what "done" looks like, not a sequence of steps. Each dispatch surveys reality-against-desired-state and picks the highest-value slice itself; sequencing is emergent.

**Discoverable updates.** Commits, fibers, test results, files in the fiber dir — not progress logs scattered in the body. The `## Status` block is the explicit handoff exception.

**Pointers, not snapshots.** If you learn something stable, update the constitution — the lede, Desired State, or the earned section where it belongs.

**Prefer doing the work.** You have authority. Trust the constitution. Don't ask permission. Don't avoid ambitious moves just because they span sessions — Shuttle redispatches. When the work involves a load-bearing model choice or a capability-removing pivot, **surface alternatives in the artifact, don't withhold the work to ask** — a "considered alternatives" note in the body or outcome beats filing a question fiber and exiting. The failure mode to guard against: using "the human knows things I don't" as cover for not thinking hard enough.

**Questions go where they'll be seen.** In `outcome:` (kanban card) or an editorial event (drill-down) — open `-t question` fibers sediment unanswered.

**Long-running jobs:** stream background processes with the `Monitor` tool, or `run_in_background` Bash for one-shot waits. Shepherd to completion before exiting; don't fire-and-forget.

## Exit semantics

The status you set before you hand off determines what happens next. Do not substitute a normal chat final response for worker exit.

**Human-gate exception.** If the From User directive or the constitution explicitly says a human will attach to this session — a "wait for me" / talk-first signal, or a structural gate like 2FA or a send-in-his-voice step — finish the initial task, leave a checkpoint, keep the fiber `active` and the agent **alive**. The usual close + `felt shuttle handoff` waits until the human signals done. A resume prompt alone is not this exception. (There is no longer an "interactive" dispatch mode; the signal rides the directive or the spec.)

**Pinned roles are interactive interfaces — never `kill $PPID` on idle.** A `kind: pinned` fiber (a status hub, a debug intake) is a standing interface a human drives, not a one-shot task. The poll loop never auto-dispatches it — it enters a session only by explicit human action (drag-to-in-flight / New session / Resume, all force-dispatch) — so a worker that exits goes **dark** until the human manually resumes it. Therefore: keep the fiber current as you work (outcome, history, commits at clean checkpoints), but when you run out of immediate work, **stay alive and wait for the next message** — reply normally, don't exit. The session ends only when the human parks the role (`active → open`), never autonomously. The dispatch prompt's Exit Contract states this directly for pinned dispatches; this is the practice behind it. (Supersedes the old "active pinned = looping, park before `kill $PPID`" model, which both burned tokens re-dispatching idle interfaces and left the human staring at a dead chat.)

Three cases, asked in order:

1. **Is the desired state realized?** If yes → set `status: closed`, exit. The fiber lands in "Awaiting review" (`tempered` absent); the human accepts (`tempered: true`) or flips back to `active`.

   **Fresh eyes before close.** A diff shouldn't rubber-stamp itself: substantive work (code, configs, the actual product — not the fiber's own surfaces) needs an independent review before the session that produced it may close. Two ways to get one:

   - **In-session (preferred when your harness has subagent/workflow tools):** spawn an independent review — a fresh subagent over the diff-against-constitution for ordinary work, an adversarial workflow pass for complex work. The reviewers have no investment in the diff; if they come back clean (or you've fixed what they found and a re-check passes), close in this same session.
   - **Across dispatches (workers without subagent tools):** leave `status: active`, exit (case 3); the next dispatch reviews with fresh, un-saturated eyes and closes if it finds nothing worth touching.

   A session that surveyed and changed nothing substantive may close directly. Editing the constitution markdown, `report.html`, `outcome`, or the `## Status` block is *handoff*, not work product — it never blocks close; if your review found the report misread the code, fixing the report **is** the review.

2. **Genuinely blocked on something only the human can answer?** → set `status: closed`, exit, lead the outcome with "Blocked: …" so the action reads "answer," not "review." "Genuinely" earns its keep: most apparent blocks resolve into "I haven't sat with the problem long enough."

3. **More work to do, not blocked?** Status stays `active`. Just `felt shuttle handoff`. The next worker reads the `## Status` block and continues.

**`tempered: true` is human-only. Never self-temper.** **Don't self-uninstall the shuttle block on close** — `status: closed` is enough; the block stays as historical record (see operating.md, "When to uninstall").

**If you arrive and the work is plainly already done** (a prior session realized the constitution and left `active`), update the outcome, set `status: closed`, exit. Don't invent further work.
