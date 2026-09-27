# Authoring a constitution

You're writing a constitution, not realizing one. If you ideate it, you don't do the work yourself: the constitution is designed in one context and realized in fresh ones.

## What a constitution is

A constitution is a design document with trust built in. Like a governmental one, it lays out principles and aspirations — not specific laws, not the current state of affairs — and is meant to outlast any single iteration. It describes what the system looks like when it is right, never the steps to get there; each worker surveys reality, reasons about the gap, and picks the highest-value slice with fresh context. Plans assume you know the path; constitutions trust the agent to find it, which matters most in science and exploratory work, where each decision is informed by the result just before it.

Write one when the desired state is clear (or can be made clear) but the path is not, and a checklist would either be wrong after one step or race through without judgment. A clearly-scoped atomic task still gets a shuttle block (SKILL.md, the doctrine) but needs only a few lines of spec.

## Flow

1. **Study.** Read the relevant code and fibers. This informs the constitution — pointers the workers will follow — not a head start on the work.
2. **Create the fiber.** `felt add <slug> "<name>" -t constitution [-t <project>]`, pathed under the right parent so containment carries the relationship (`<root>/<branch>/<deliverable>-<purpose>`). The `constitution` tag is a browse handle (`felt ls -t constitution`), never a dispatch gate.
3. **Write the spec** (below). The felt skill's `ideating.md` carries the thinking process: name what "done" *is* before designing how to reach it, fence what is being left alone, and pressure-test whether the framing is right at all.
4. **Refine with the user.** Show the draft, revise, and run the goal / constraints / success self-check before launch. It need not be complete: a live uncertainty can hold an "Open questions" section until resolved, then that section is deleted.
5. **Install the dispatch contract.** `felt shuttle install <fiber-id> --model <agent> --project-dir "$PWD"` writes the `shuttle:` block, validates the agent, and arms the fiber (`status: active`), including an existing open draft. `--disabled` installs as a draft instead.
6. **Assign a role.** `felt shuttle assign <fiber-id> --role <role> [--collaborator <model>]` with the charter under `roles/` that fits, creating one when none does ([collaboration.md](collaboration.md)). A roster left empty makes each worker rediscover the playbooks and gates.

The constitution stays editable while workers run; each dispatch re-reads it, so refinements between iterations are normal.

## The spec

**The lede comes first, with no heading.** The opening paragraph orients both readers — the human skimming the card and the worker landing cold: what this is, why it matters now, where it sits, with `[[wikilinks]]` woven in. Write it to stand alone (felt surfaces it in `-d summary`). The test: someone who knows nothing reads the lede, then Desired State, and never wonders "what *is* this thing?"

**`## Desired State` is the one fixed heading** — the contract: invariants, quality bar, and scope fence (what to aim for AND what to leave alone). Write done-conditions in checkable terms wherever the work allows — grep patterns, test commands, "a reviewer can follow the narrative cold" — because a desired state phrased checkably is its own evidence, and it is what workers and their verifiers measure against. A separate `## Evidence` section is earned only when verification needs its own room (a harness, a measurement procedure).

**Everything after that is earned, and named for what it contains** — "Touch points", "Why directives over modes", "Considered alternatives". If a section's honest name would be "Context" or "Notes", its contents belong elsewhere: background gets linked where it is used, and chronology stays in the git log.

If the work should surface a human-readable report — findings, figures, comparisons rather than commits — say so in the spec.

## Principles

**Pointers, not snapshots.** `grep -r 'old_pattern'` returns nothing, not "50 files remain". Nothing in the constitution should become stale or confusing as the desired state is approached.

**Small body, rich network.** A constitution that repeats a linked fiber will drift from it. Push depth outward — findings into sub-fibers, background into doc fibers — and link it where it does work.

**Leave worker mechanics to this skill.** Verification cadence, subagent use, exit discipline, and handoff surfaces reach every worker through SKILL.md; writing them into a spec duplicates it and dates the fiber as models change. The constitution carries only what is specific to *this* work.

**Reshape, don't accrete.** When the desired state evolves, rewrite the affected sections so the body still reads as one description of now. No "Round 2" sections, amendment appendices, "Decisions made" logs, or resolved "Open questions" left as a victory log; fold each answer into the lede, Desired State, or the earned section where it belongs. The git log carries the chronology; the outcome carries the kanban summary.

**Constraints need reasons.** Bare constraints get creatively circumvented; include enough *why* that a worker knows when one applies.

**Scope is a gift.** A clear fence — "only rename, don't refactor" — frees the worker to move confidently inside it.

**Prefer existing systems.** Before designing anything new, ask whether what is there can handle it.

**Trust the agent's taste.** Prescribing *how* instead of *what* degrades output that defaults would have gotten right; instructions written for weaker models are usually too prescriptive for current ones. When in doubt, delete the instruction.

Some constitutions shape artifacts rather than code — documentation, a research narrative. Their desired state is comprehension, not correctness, and the artifact may keep growing; the constitution shapes how growth presents itself, not when it stops.

## Drafts vs immediate dispatch

`status: active` is armed: the daemon picks it up on the next poll. `--disabled` / `status: open` lands in Drafts; `felt shuttle resume` arms it.

**Default to drafts.** Most constitutions are stash-now-decide-later. Dispatch immediately when context plainly signals it: the user is mid-iteration and pushing toward action, names the agent in an action-shaped sentence, says "launch" / "go" / "dispatch now", or a sibling in the same arc just went straight to dispatch. When signals are mixed, write the constitution first, then ask — drafts vs immediate is the one bit worth confirming.

`install` is create-only. On a fiber that already has a block it refuses and points at `felt shuttle status <fiber>` (inspect), `reshape` (kind or schedule), `set-agent` (agent and axes), or `uninstall` (start over). A hand-written `shuttle:` block works too but skips validation, and one with no `status` is reported undispatchable until armed.

## Human in the loop — directives and gates, not a mode

Every dispatch is autonomous; there is no separate "interactive" dispatch mode. When work needs a human, the expectation rides one of two channels the worker already reads. (Workers also carry standing judgment to stay alive when open taste calls make human input the clear next move — SKILL.md, "When to stay interactive".)

**Per-dispatch "talk to me first"** goes in the From User directive, as a line in the card drawer's message box. A talk-first signal gets a light survey, a greeting, and a wait; it belongs to the moment, and the next dispatch starts clean.

**Structural gates** go in the constitution text: a final **send** in the user's voice, a **2FA** step only they can complete, any "draft-and-stage, human commits" shape — *"The user will be present; drive to the send and wait for them."* Portal work on the chrome axis almost always carries one. Genuinely headless work writes no gate and runs to exit.

**Talking to a worker later** is Resume from the kanban: on an awaiting-review, composted, or in-flight card it reopens the stored session as a live tmux you can attach to, with the drawer's message box for steering. Autonomous workers close normally, and the human resumes when they want the conversation; a missing session id degrades to a fresh dispatch carrying the directive. Standing roles work the same way — the morning run closes to awaiting-review and the user resumes over coffee.

## Agent selection

When the user or the constitution names an agent, use it; otherwise pick from `felt shuttle agents`, the effective registry on this machine (built-ins plus `~/.config/felt/agents.json`; each remote host reads its own copy). Check the listing before assuming an agent exists. There is no `human` agent — write a human gate into the spec instead.

Set with `felt shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]`. Claude agents dispatch with `--permission-mode auto`. Headless (`claude -p`) runs come from a user alias record — `{"id": "claude-opus-headless", "alias_of": "claude-opus", "axes": {"headless": true}}` — since no built-in agent is headless.
