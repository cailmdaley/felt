# Authoring a constitution

When you write a constitution, you design the work; fresh workers do it. Like a governmental constitution, it lays out principles and aspirations rather than laws or the current state of affairs, and it outlasts any single session. It describes what the world looks like when the work is right, never the steps: each worker surveys reality, reasons about the gap, and picks the most valuable slice with fresh context. A plan assumes you know the path; a constitution trusts the worker to find it, which matters most in science and exploration, where each step depends on the result just before it.

Write one when the desired state is clear, or can be made clear, but the path isn't. A small, well-scoped task still gets a shuttle block so it can reach the board, with a spec of a few lines.

## Flow

1. **Study.** Read the code and fibers the work touches, so you can point workers at them. This is not a head start on the work itself.
2. **Create the fiber** under the parent it belongs to: `felt add <root>/<branch>/<slug> "<name>" -t constitution`. The tag lets people browse constitutions (`felt ls -t constitution`); it never gates dispatch.
3. **Write the spec** (below). The `ideating` skill carries the thinking: name what done *is* before designing how to get there, fence what stays untouched, and test whether the framing is right at all.
4. **Refine it with the user.** Show the draft and revise it. A live uncertainty can sit in an "Open questions" section until it's resolved; then fold the answer in and delete the section.
5. **Install the block.** `felt shuttle install <fiber-id> --model <agent> --project-dir "$PWD"` writes and validates the `shuttle:` block and arms the fiber; add `--disabled` to leave it in Drafts.
6. **Give it a role.** `felt shuttle assign <fiber-id> --role <role> --collaborator <model>`, choosing or creating the charter that fits ([collaboration.md](collaboration.md)). Without one, each worker has to rediscover the playbooks and the human gates.

Workers re-read the constitution at every dispatch, so keep refining it between sessions.

## The spec

**Open with the lede, unheaded.** It orients both readers — a human skimming the card and a worker landing cold — with what this is, why it matters now, and where it sits, `[[wikilinks]]` woven in. Test it: someone who knows nothing reads the lede and Desired State and never wonders what this thing *is*.

**`## Desired State` is the one fixed heading**, and the contract: invariants, the quality bar, and a fence around what to aim for and what to leave alone. Phrase done-conditions so they can be checked wherever the work allows — a grep that returns nothing, a test command, "a reviewer can follow the narrative cold" — since workers and their verifiers measure against them. Give verification its own `## Evidence` section only when it needs room (a harness, a measurement procedure).

**Every later section is earned, and named for what it holds** — "Touch points", "Considered alternatives". If the honest name would be "Context" or "Notes", the contents belong elsewhere: link background where it's used, and leave chronology to git. If the work should produce something a human reads — findings, figures, comparisons — say so, and workers will keep a `report.html`.

## Principles

- **Pointers, not snapshots.** Write "`grep -r 'old_pattern'` returns nothing", not "50 files remain", so nothing goes stale as the work approaches done.
- **Small body, rich network.** Push depth into linked fibers — findings into sub-fibers, background into doc fibers — rather than repeating it, which drifts.
- **Leave worker mechanics to the skill.** Verification cadence, subagents, exits and handoffs reach every worker through the shuttle skill; repeating them in a spec dates it. Write only what is specific to this work.
- **Reshape, don't accrete.** When the desired state moves, rewrite the affected sections so the body still reads as one description of now — no "Round 2" sections, amendment logs, or resolved questions kept as trophies.
- **Give constraints reasons.** A bare constraint gets worked around; the reason tells a worker when it applies.
- **Fence the scope.** A clear fence — "only rename, don't refactor" — frees the worker to move confidently inside it.
- **Prefer what exists** before designing anything new.
- **Trust the worker's taste.** Prescribing *how* instead of *what* degrades work that defaults would have got right; when in doubt, delete the instruction.

A constitution that shapes an artifact rather than code — documentation, a research narrative — aims at comprehension rather than correctness, and may never stop growing; it shapes how the growth presents itself.

## Drafts or dispatch

An `active` fiber dispatches on the next poll; `--disabled` (`status: open`) lands it in Drafts, and `felt shuttle resume` arms it later. Default to drafts: most constitutions are stashed now and launched later. Dispatch straight away when the user plainly wants action — they are mid-iteration, name the agent in an action-shaped sentence, or say "launch", "go" or "dispatch now". When the signals are mixed, write the constitution first and then ask; that is the one thing worth confirming.

`install` only creates. On a fiber that already has a block it refuses and points you to `felt shuttle status` (inspect), `reshape` (kind or schedule), `set-agent` (agent and its settings), or `uninstall` (start over).

## The human in the loop

Every dispatch runs autonomously; there is no interactive mode. When a particular run needs the human, say so in its launch directive ("stay interactive", "talk to me first"); the next dispatch starts clean. Workers also stay alive on their own judgment when open taste calls make the human's input the clear next move.

Put **structural gates** in the constitution itself: a final send in the user's voice, a 2FA step only they can complete, any draft-and-stage shape where the human commits — "The user will be present; drive to the send and wait for them." Work in a real browser usually carries one. Headless work writes no gate and runs to exit.

To talk to a worker later, the human resumes its card, which reopens the stored session in tmux; you don't need to design for that.

## Choosing the agent

Use the agent the user or constitution names; otherwise pick from `felt shuttle agents`, the registry on this machine (built-ins plus `~/.config/felt/agents.json`, read separately on each host). Check the listing before assuming an agent exists, and remember there is no `human` agent — write a human gate instead. Change it with `felt shuttle set-agent <fiber> <agent-id> [--effort E] [--chrome]`. Claude agents run with `--permission-mode auto`. For headless (`claude -p`) runs, add an alias to the registry, such as `{"id": "claude-opus-headless", "alias_of": "claude-opus", "axes": {"headless": true}}`; no built-in agent is headless.
