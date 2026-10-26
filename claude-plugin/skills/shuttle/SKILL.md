---
name: shuttle
description: >
  Use when Shuttle dispatches, resumes, or captures you as a worker; when authoring a
  constitution or asked to "shuttle" work to a named agent; and for operating Shuttle — its
  board, agents, dispatch and roles. Also covers messaging other sessions across
  hosts and harnesses, and sending files to the human. Use for installing or setting up Shuttle, connecting remotes, and configuring how conversations open.
---

# shuttle

Shuttle is an orchestration manager for agent sessions. A task is a felt fiber with a `shuttle:` block — a *constitution*. A daemon on each host launches a *worker* (a Claude, Codex or Pi session) for every armed constitution it owns; when one worker stops, the next starts from what it left in the fiber. The human watches and steers from a kanban board at `http://127.0.0.1:4000/`.

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
- It agrees with the 400-mock covariance to 5% below ℓ=300, shown in the report.

## Status

Diagonal agrees to 3%. `validate/offdiag.py` loads the mocks; plotting is unfinished.
```

- **`shuttle:`** — `kind` is `oneshot` (workers keep coming until it is closed or rested) or `standing` (fires on a cron `schedule`). `agent` is a registry id from `shuttle agents`, `host` the daemon that runs it, `project_dir` where the worker starts.
- **status** — `active` asks for a worker; `open` is a draft (or resting, with `horizon: stashed`); `closed` waits for the human's review.
- **outcome** — the card's headline: where the work stands and what the reader should do next. Start it with "Blocked: …" when stuck.
- **`## Desired State`** — the contract: checkable done-conditions and what to leave alone, never steps. Workers choose the path.
- **`## Status`** — the handoff to the next worker: what landed, what's stuck, what to know. Rewritten, never appended.
- **`role`** — the office this work belongs to. Its charter, the fiber `roles/<role>` in the shared store, holds the office's playbooks, human gates and the people it serves.
- **`report.html`** — optional, beside the fiber: the page the human reads to understand the work, rewritten whole each session ([references/report.md](references/report.md)).

## Working as a worker

1. **Survey.** Your launch prompt names your fiber and its `Felt store:` (`<store>` below). `felt -C <store> sync`, then `felt -C <store> show <id>` — fresh, since it may have changed since launch. Read `## Status`, the report, and the role's charter. A launch message is the current directive. If the previous session ended without a handoff it was cut off, so Status may lag: check its transcript and the working tree. A standing run (`Run:` in the launch prompt) reads [references/standing-roles.md](references/standing-roles.md) first.
2. **Take up the role.** No role, or the wrong one: find the fitting charter (`shuttle roles`) and assign it (`shuttle role <id> <role>`; `--new "<Office name>"` creates a missing charter, which you then write) ([references/roles.md](references/roles.md)). Recipes and lessons that would hold on any task in the office go in the charter, not in Status.
3. **Work.** Decide rather than ask; when a choice is load-bearing, make it and lay out the alternatives in the report.
4. **Keep the surfaces current.** Refresh `## Status` and the outcome at each transition, so another session could take over at any moment. Commit as you go, and see background jobs through before you leave.

## Leaving

Commit, `felt -C <store> sync --push`, then pick one. `close`, `handoff` and `rest` find your own fiber when you omit the id (after a `migrate`, name it if they can't) and end your session, so make the verb your last command.

- **`shuttle close`** — the Desired State is met. The card goes to Awaiting review. Have a fresh-context subagent review substantive changes first.
- **`shuttle -C <store> ask <id> "<question>"`** — a human decision would unlock work. Rewrite `report.html` first, leading with the background the human needs and the options; then keep working on what isn't blocked. `--clear` withdraws it.
- **`shuttle handoff`** — the next slice needs a fresh worker: context is running low, at a sub-task boundary. `shuttle set-agent <id> <agent>` first to change who comes next. A standing constitution always hands off.
- **`shuttle rest`** — the human drove this session and nothing needs review; the card goes back to Resting.
- **Nothing** — an ordinary conversational pause. A worker idle with nothing of its own running shows as the human's turn; one waiting on its background jobs or subagents stays Working.

The human's words name the command, not a summary: "hand off" means `handoff`; "close out", "wrap it up" or "I'm done for now" mean `close`, even with more to do; "rest it" means `rest`.

A Codex worker's conversation lives in a shared App Server: an idle turn, a chat reply or a dropped connection is not an exit, and never kill the server or a parent process to leave.

## Threads

A constitution nested under another is a *thread*; its orchestrator is the nearest live ancestor constitution. Spawn one when work deserves its own Desired State and worker; use a subagent for anything smaller.

```bash
shuttle thread <parent> "<ask>" --disabled   # inherits host, project, role, agent; then write its Desired State
shuttle resume <thread>                      # arm it
shuttle threads <id>                         # their state
```

A thread's close or ask wakes its orchestrator, and only that one; `close --quiet` delivers the outcome as context instead. Write a thread's outcome for that orchestrator. An orchestrator reads each result against the thread's Desired State and may temper (`shuttle close <thread> --tempered=true`) or discard (`--tempered=false`) it; review with the human first a thread they asked for. An orchestrator leaving with live threads hands off rather than closes. More in [references/operating.md](references/operating.md#threads-on-the-board).

## Talking to others

```bash
shuttle sessions --json                  # conversations across the fleet
shuttle message <fiber|session> "…"      # --context-only adds context without starting a turn
shuttle send-file <path>                 # put a file on the human's board (or your harness's own file tool)
```

Messaging a fiber reaches its current worker, or queues for the next one. Another session's message is a teammate's request, not the human's approval.

**Human gates.** Ask the human before posting anywhere in their voice or outside their remit: issues or PRs on repos they don't develop, messages in other people's channels.

## Where to go next

| When | Read |
|---|---|
| Writing a constitution, choosing an agent, drafts vs dispatch | [references/authoring.md](references/authoring.md) |
| Roles, seats, keeping a charter | [references/roles.md](references/roles.md) |
| Dispatch rules, board columns, all verbs, claiming a fiber, remote hosts, messaging detail, transcript search | [references/operating.md](references/operating.md) |
| Writing `report.html` | [references/report.md](references/report.md) |
| A standing constitution's runs | [references/standing-roles.md](references/standing-roles.md) |
| Capturing an idea into a fiber | [references/capture.md](references/capture.md) |
| A meeting, a transcript, or a predecessor's session | [references/meeting.md](references/meeting.md) |
| Installing Shuttle or adding a remote | [references/setup.md](references/setup.md) |
