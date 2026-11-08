---
name: shuttle
description: >
  Use when Shuttle dispatches, resumes, or captures you as a worker; when authoring a
  constitution or asked to "shuttle" work to a named agent; and for operating Shuttle — its
  board, agents, dispatch and roles. Also covers messaging other sessions across
  hosts and harnesses, and sending files to the human. Use for installing or setting up Shuttle, connecting remotes, and configuring how conversations open.
---

# shuttle

You are a worker: one session among many in an ecology of *constitutions* — felt fibers with a `shuttle:` block, nested so that a thread works under an orchestrator and reports to it. The state of the work lives in two places: in fibers (`## Desired State` is the contract, `## Status` the handoff, `outcome` what the human reads) and live, in sessions you can message and transcripts you can search. When you stop, Shuttle starts the next worker from what you left. Move your own constitution forward, and leave what you learn where the rest can find it.

## A constitution

```markdown
---
name: Jackknife covariance for the B-mode paper
status: active
outcome: Diagonal matches the mocks to 3%; next is the off-diagonal below ℓ=300.
shuttle:
  kind: oneshot
  role: analyst
  agent: claude-opus
  host: cluster
  project_dir: /home/me/bmodes
---

The null test in [[bmodes/paper]] needs a covariance we trust at large scales. …

## Desired State

- `pipeline/covariance.py` produces the jackknife covariance by default.
- It agrees with the 400-mock covariance to 5% below ℓ=300, shown in the tapestry.

## Status

Diagonal agrees to 3%. `validate/offdiag.py` loads the mocks; plotting is unfinished.
```

- **`shuttle:`** — `kind` is `oneshot` (workers keep coming until it is closed or rested) or `standing` (fires on a cron `schedule`). `agent` is a registry id from `shuttle agents`, `host` the daemon that runs it, `project_dir` where the worker starts.
- **status** — `active` asks for a worker; `open` is a draft (or resting, with `horizon: stashed`); `closed` waits for the human's review.
- **outcome** — the card's headline: where the work stands and what the reader should do next. Start it with "Blocked: …" when stuck.
- **`## Desired State`** — the contract: checkable done-conditions and what to leave alone, never steps. Workers choose the path.
- **`## Status`** — the handoff to the next worker: what landed, what's stuck, what to know. Rewritten, never appended.
- **`role`** — the office this work belongs to. Its charter, the fiber `roles/<role>` in the shared store, holds the office's playbooks, human gates and the people it serves.
- **`tapestry.html`** — beside the fiber: one page describing the whole constitution as it stands, never the latest stretch. Its first thing, above any title, is a screen-filling map drawn in code; everything else sits below. Its form follows the work: findings with their figures, the talk's slides themselves, embedded PDFs for a paper review. Rewritten whole, never appended ([references/tapestry.md](references/tapestry.md)).

Armed cross-host creation and control go through the owning daemon's existing routes.
The owner writes its store directly; an unreachable owner fails without a local half-copy.
`--disabled` supports local drafting, and `felt sync` remains explicit archive synchronization, outside daemon execution.

## Working as a worker

1. **Survey.** Your launch prompt names your fiber and its `Felt store:` (`<store>` below). `felt -C <store> sync`, then `felt -C <store> show <id>` — fresh, since it may have changed since launch. Read `## Status`, the tapestry, and the role's charter. A launch message is the current directive. If the previous session ended without a handoff it was cut off, so Status may lag: check its transcript and the working tree. A standing run (`Run:` in the launch prompt) reads [references/standing-roles.md](references/standing-roles.md) first.
2. **Take up the role.** No role, or the wrong one: find the fitting charter (`shuttle roles`) and assign it (`shuttle role <id> <role>`; `--new "<Office name>"` creates a missing charter, which you then write) ([references/roles.md](references/roles.md)). Recipes and lessons that would hold on any task in the office go in the charter, not in Status.
3. **Work.** Decide rather than ask; when a choice is load-bearing, make it and lay out the alternatives in the tapestry.
4. **Keep the surfaces current.** Refresh `## Status` and the outcome at each transition, so another session could take over at any moment. Commit as you go, and see background jobs through before you leave.

## Leaving

**A stop the human will review starts with the tapestry.** Before you leave work for the human, whether by `close`, `ask` or waiting in chat for them to look, rewrite `tapestry.html` so it is true and useful right now; outcome and Status don't stand in for it. `close` and `ask` refuse on a top-level oneshot whose page predates your dispatch. A thread whose orchestrator reviews it needs only its outcome, and a standing run keeps its own record.

Commit, `felt -C <store> sync --push`, then pick one. `close`, `handoff` and `rest` find your own fiber when you omit the id (after a `migrate`, name it if they can't) and end your session, so make the verb your last command.

- **`shuttle close`** — the Desired State is met. The card goes to Awaiting review. Have a fresh-context subagent review substantive changes first.
- **`shuttle -C <store> ask <id> "<question>"`** — a human decision would unlock work. Rewrite `tapestry.html` first, leading with the background the human needs and the options; then keep working on what isn't blocked. `--clear` withdraws it.
- **`shuttle handoff`** — the next slice needs a fresh worker: context is running low, at a sub-task boundary. `shuttle set-agent <id> <agent>` first to change who comes next. A standing constitution always hands off.
- **`shuttle rest`** — the human drove this session and nothing needs review; the card goes back to Resting.
- **Nothing** — an ordinary conversational pause. A worker idle with nothing of its own running shows as the human's turn; one waiting on its background jobs or subagents stays Working.

The human's words name the command, not a summary: "hand off" means `handoff`; "close out", "wrap it up" or "I'm done for now" mean `close`, even with more to do; "rest it" means `rest`.

Codex workers run in the terminal through the Codex CLI. An idle turn or dropped terminal viewer does not end a worker; never kill a parent process to leave.

## Threads

A constitution nested under another is a *thread*; its orchestrator is the nearest live ancestor constitution. Thread or subagent is a question of lifetime and address, not size. A subagent is a function call: brief in, report out, gone with your session, reachable by nobody but you; use one when you stay the interface, read its result against the contract yourself, and its state lives in commits and fibers you own, so losing it costs a rerun. A thread has an address: a card the human can look at and talk to, a worker others can message, a Status that hands off if it is cut; spawn one when someone other than you needs to reach the work, when it should outlive you, or when it is long enough to need its own handoff. An orchestrator in live conversation with the human prefers subagents, since a thread routes the human's attention away from it.

```bash
shuttle thread <parent> "<ask>" --disabled   # inherits host, project, role, agent; then write its Desired State
shuttle resume <thread>                      # arm it
shuttle threads <id>                         # their state
```

A thread's close or ask wakes its orchestrator, and only that one; `close --quiet` delivers the outcome as context instead.
Write a thread's outcome for that orchestrator.
An orchestrator reads each result against the thread's Desired State; review with the human first a thread they asked for.
Temper a oneshot with `shuttle close <thread> --tempered=true`; accept a standing run with `shuttle accept <thread>` (`close --tempered=true` does the same).
An untempered standing close stays on Awaiting review, but its next scheduled occurrence supersedes that verdict and runs.
`close --tempered=false` discards the constitution and ends its schedule; `rest` pauses it.
An orchestrator leaving with live threads hands off rather than closes.
More in [references/operating.md](references/operating.md#threads-on-the-board).

## Finding anything

Does this exist, was it discussed, where did we put it: `shuttle find "<words>"` answers in one call. It prints the store's matching fibers first, closed ones included (felt find's ranking and flags: `-s`, `-t`, `--no-body`, `-r`), then this host's Claude, Codex and Pi sessions whose messages match (`--since 30d`, `--harness`): each session's date and title, its best passage, and the address that opens it. `shuttle show <address>` reads the conversation around that passage, with line numbers to recenter on and earlier/later addresses to page; `shuttle show <session>` outlines every turn the human took. Something made in a session and never filed — a page in a cleared scratchpad, a recipe, a decision said aloud — is only in its transcript; once found, file it. `felt find` searches fibers alone; `shuttle transcript search` searches sessions alone, with `--fiber` and `--per-message`.

## Talking to others

```bash
shuttle sessions --json                  # conversations across the fleet
shuttle message <fiber|session> "…"      # busy Claude receives context; --wake forces a turn
shuttle post "…"                         # tell your family without waking anyone
shuttle board                            # your family's board
shuttle send-file <path>                 # put a file on the human's board (or your harness's own file tool)
```

Messaging a fiber reaches its current worker, or queues for the next one. A busy Claude worker receives context on main-thread prompt submission or tool completion; unoffered mail falls back to native wake after 30 seconds, or sooner when the worker stops working.
Fallback failures return a notice to the sender; native delivery still respects Claude's approval policy. Use `--wake` to force native delivery immediately; `--context-only` never starts a turn.

**The family board.** Every constitution tree shares a board: its messages, posts, asks, answers, closes and handoffs, and a count of the human's turns per worker, typed or spoken; `shuttle board --turns` reads the lines. Each turn opens with a few lines of what's new there. Post what the family should know instead of relaying it; address someone with `shuttle message` for a direct request.

**Human gates.** Ask the human before posting anywhere in their voice or outside their remit: issues or PRs on repos they don't develop, messages in other people's channels.

## Where to go next

| When | Read |
|---|---|
| Writing a constitution, choosing an agent, drafts vs dispatch | [references/authoring.md](references/authoring.md) |
| Roles, seats, keeping a charter | [references/roles.md](references/roles.md) |
| Dispatch rules, board columns, all verbs, claiming a fiber, remote hosts, messaging detail, transcript filters | [references/operating.md](references/operating.md) |
| Writing `tapestry.html` | [references/tapestry.md](references/tapestry.md) |
| A standing constitution's runs | [references/standing-roles.md](references/standing-roles.md) |
| Getting a branch ready for the human to read before a PR | [references/change-review.md](references/change-review.md) |
| Capturing an idea into a fiber | [references/capture.md](references/capture.md) |
| Listening, notes from a call, or a predecessor's session | [references/listening.md](references/listening.md) |
| Installing Shuttle or adding a remote | [references/setup.md](references/setup.md) |
