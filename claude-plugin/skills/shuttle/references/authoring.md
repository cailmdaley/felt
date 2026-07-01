# Authoring a constitution

You're writing a constitution, not realizing one. The flow has three steps:

1. **Create the fiber.** `felt add <slug> "<name>" -t constitution [-t <project> ...]` — creates the directory and a markdown skeleton. Path the slug under the right parent so containment carries the relationship (`<root>/<branch>/<deliverable>-<purpose>`); felt resolves the leading segment against existing fibers when nesting is implied.
2. **Write the spec.** Open with a standalone **lede** — a heading-less paragraph that orients both readers (human skimming the card, worker landing cold): what this is, why now, where it sits, `[[wikilinks]]` woven in. Then `## Desired State` — the one fixed heading: the contract, including any specifically-NOT-doing and any quality bar that earns naming, with done-conditions in checkable terms where the work allows (a desired state phrased checkably is its own evidence). Any further sections are *earned* and named for what they contain — "Touch points", "Why X", "Considered alternatives" — never a default "Context": background that matters gets linked where it's used; a section named for nothing in particular fills like a junk drawer. Keep the body small and the network rich; the felt skill's `constitution.md` reference carries the craft. Don't write worker mechanics (verification cadence, exit discipline, subagent use) into the spec — this skill carries those for every worker, and prescription dated to one model generation degrades the next.
3. **Install the dispatch contract.** `felt shuttle install <fiber-id> --model <agent> --project-dir "$PWD"` — writes the `shuttle:` block, validates the agent against the registry, bumps felt status to `active` if missing. Add `--disabled` to stash as a draft for kanban review.

A good constitution makes worker decisions inferable from system purpose + codebase rather than gating on the human; spend the authoring time on the lede and Desired State. If the work should surface a human-readable report — findings, figures, comparisons rather than commits — say so in the constitution; workers create `report.html` when asked or when the product is read rather than run (see SKILL.md, "The fiber's surfaces").

**Tag the fiber `constitution`** when you stash one — it's how `felt ls -t constitution` pulls these into a single browse. (Tags never gate dispatch; see operating.md.)

## Drafts vs immediate dispatch

`status: active` (armed) → daemon picks up on next poll. `--disabled` / `status: open` → lands in drafts for human review on the kanban; `felt shuttle resume` arms it.

**Default to drafts.** Most authored constitutions are stash-now-decide-later. Switch to immediate dispatch when context plainly signals it:

- The user is mid-iteration on the topic and pushing toward action.
- The user names the agent in an action-shaped sentence ("write this up as a constitution that uses pi-sonnet").
- The user says "launch" / "go" / "dispatch now" / "shuttle this and start it."
- A just-shipped sibling fiber went straight to dispatch — same arc, same posture.

When signals are mixed, ask via AskUserQuestion — drafts vs immediate is the one bit worth confirming. Don't withhold the writing to ask; write the constitution, then ask about dispatch.

## Writing the shuttle: block by hand

The mechanical alternative — write the `shuttle:` block directly into the frontmatter while drafting — also lands somewhere useful. `felt shuttle install` is **idempotent**: on an existing block it prints the block's state plus the daemon's dispatch assessment, and exits 0 unless a passed flag conflicts with what's there. The install verb adds schema validation, which is why step 3 above is the canonical flow. A hand-written block with no `status` is reported as undispatchable (set `status: active` or run `resume`); install does not auto-arm it. On a conflict (e.g. `install --model claude-opus` against an existing `agent: codex`), install exits non-zero and points at the right mutation verb (`set-model`, `pause`, `resume`, `uninstall`).

## Human in the loop — directives and gates, not a mode

Every dispatch is autonomous: the worker drives to a clean checkpoint and exits via `felt shuttle handoff`; the handoff lives in `outcome` / the `## Status` block / commits, and the human reads the result later off the kanban. There is **no separate "interactive" dispatch mode**. When work needs a human in the loop, that expectation rides one of two channels the worker already reads.

**Per-dispatch "talk to me first."** When *this* run should pause for Cail before doing anything heavy — he wants to steer, or the autonomous scope is unclear — put it in the **From User directive**. The kanban requeue/resume modal has a one-click **"wait for me"** affordance that prepends a canned talk-first line to the directive box; or write your own. The worker reads the From User block at the top of context: talk-first signal → light survey (constitution + last handoff), greet, wait; no signal → ordinary autonomous run. This is a property of the *moment*, not the fiber — the next dispatch starts clean unless its directive says otherwise.

**Structural human-gates.** When the work *structurally* can't one-shot — a final **send** in Cail's voice, a **2FA** step only he can complete, any "draft-and-stage, human commits" shape — write the gate into the **constitution text** (Desired State or Context): *"Cail will be present; drive to the send and wait for him."* The worker reads the spec as its contract and stays alive at that gate because the spec says so. `claude-opus-chrome` portal work almost always carries such a gate. Genuinely headless work — a refactor, a research sweep, a triage pass producing a report — writes no gate and runs to exit.

**Talking to a worker, finished or not.** Resume from the kanban — on an awaiting-review, composted, or still-in-flight card — drops you into the stored session as a live tmux you can attach to, with the directive box for steering text. This is the replacement for "leave it running so I can chat": autonomous workers close normally, and you resume when you want the conversation. A missing/expired session id degrades to a fresh dispatch carrying the directive.

So when authoring: if a flow has a human-gated step, **write the gate into the spec** — don't reach for a flag. Standing roles are autonomous too (the morning-post pattern: the run closes to awaiting-review, Cail resumes over coffee).

## Agent selection

Three CLI harnesses cover the working space. Cail's setup runs **subscription-first**: Claude ($200/mo) and Codex have weekly quotas that should get fully used before they reset, so default to those. Pi (Copilot) is the fill-in once weeklies run out.

**Copilot bills per message, not per token, with per-model multipliers** — a dispatch that runs two hours and writes ten commits is the same charge as one that runs two minutes. Long-running shuttle dispatches are exactly where pi pays off; ad-hoc one-shots are where it doesn't (the bare `pi` CLI default is `pi-deepseek-flash` on openrouter, so casual use doesn't burn the Copilot budget). Thinking level is pinned per-model in the registry via the `:level` suffix; Copilot caps Sonnet at `:high` and the GPT family at `:xhigh`.

| Agent | Cost | Use for |
|---|---|---|
| `claude-opus` | subscription | **Shuttle default.** The bulk of dispatches — taste-y implementation, design/UX/narrative, architecture, exploratory work. Drains the weekly first. |
| `claude-fable` | subscription, expensive | The heavyweight. Subagent/workflow orchestration (fan-out surveys, migrations, in-session adversarial review), the hardest architecture and taste work, arcs that should converge in one dispatch instead of five. Burns the weekly fast — reach for it when the task earns it, not by default. |
| `claude-sonnet` | subscription | Lighter-weight dispatches where Opus is overkill — cheaper weekly burn for routine general/frontend work. |
| `claude-opus-chrome` | subscription | Portal automation that needs Cail's *running* Chrome — logged-in sessions, bot-walls, anything driven through a real browser. Connects via the `agent-browser` skill (Chrome-CDP). Almost always carries a **structural human-gate in its constitution** (the human does 2FA / the final send). See [[personal/travel/flight-check-in]] for conventions. |
| `codex` | subscription | Hard well-defined implementation — gritty refactors, tight algorithmic problems, work that wants codex CLI's harness (sandbox, head-down focus). |
| `codex-spark` | separate Codex Spark quota | Fast, low-latency Codex work. Quick iteration, straightforward bugfixes, mechanical implementation. |
| `pi-sonnet` (Sonnet 4.6, `:high`) | 1× Copilot | Sonnet-shape work after the Claude weekly is used up. |
| `pi-gpt-5.4` (`:xhigh`) | 1× Copilot | GPT-shape work after subscriptions are used up. |
| `pi-gpt-5.4-mini` (`:xhigh`) | 0.3× Copilot | Cheap. Easy/repetitive tasks. ~3.3 dispatches per "real" message. |
| `pi-gpt-5-mini` (`:xhigh`) | **0× (free)** | Free. Anything where capability margin is comfortable; low-stakes or exploratory dispatches. |

Other entries (`pi-kimi`, `pi-deepseek-pro`, `pi-deepseek-flash`, `claude-haiku`) exist but aren't defaults; reach for them only when the user names them. All claude agents dispatch with `--permission-mode auto`.

Set with `felt shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]` (`set-model` is the agent-only shorthand). The registry is felt's single source of truth — `internal/shuttle/agents.json` in the felt repo (`~/dev/felt`), embedded into the CLI at build; `felt shuttle agents` lists it. Registry changes need `make cli-install` and a rebuild on each remote host.
