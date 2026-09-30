# shuttle

Two Go CLIs divide the work. `felt` stores fibers as Markdown and preserves
unknown frontmatter as opaque data. `shuttle` interprets an optional `shuttle:`
block, validates it, and owns orchestration. The optional Elixir daemon polls
felt stores, launches workers, and serves the board.

A fiber without the block stays a plain note. Add it and the daemon can hand
the fiber to a coding agent as a **constitution**: a description of the desired
state, not a list of steps.

!!! note "You can skip this whole section"
    felt works without the Shuttle CLI or daemon. Use it for a notes-and-tasks
    store, and stop at [Concepts](../concepts/fibers.md) — you lose nothing.

## The block

```yaml
---
name: Rewrite the covariance loader
status: active
shuttle:
  kind: oneshot
  host: my-laptop
  project_dir: /home/me/dev/pipeline
  agent: claude-opus
---
```

Those keys cover the dispatch interface. felt preserves this block without
interpreting or validating it; `shuttle install`, `shuttle check`, and the daemon
own its schema and behavior. Remove Shuttle and you still have a readable,
greppable, version-controlled markdown file.

(The board reads a small calendar vocabulary outside the block — `start:`,
`horizon:`, and the `cycle` tag. See [Cycles and eras](cycles.md).)

## The loop

1. **Author.** Write a fiber body that describes a *desired state*. Then run
   `shuttle install` to attach the block and arm the fiber.
2. **Dispatch.** The daemon polls the fiber tree every 30 s by default. For each
   eligible fiber it starts exactly one tmux session, running an agent CLI in
   `project_dir`. `shuttle session-name <fiber>` prints the session name,
   `<slug-leaf>-<uid>-shuttle`.
3. **Work.** The worker reads the constitution fresh from disk. It reads the
   previous session's `## Status` handoff. Then it drives toward the desired
   state and picks its own slice. Sequencing emerges; nobody scripts it.
4. **Exit.** Before exiting, the worker rewrites `outcome:` (the kanban
   headline) and the body's `## Status` block (the next worker's landing pad).
   Then it exits one of two ways: to continue, it runs `shuttle handoff
   <fiber>`, which stamps a clean-exit marker and ends its own tmux session
   in one move; to stop, it runs `shuttle close <fiber>` and does nothing else.
5. **Redispatch or review.** A fiber still marked `active` gets a fresh worker
   on the next tick, and that worker lands warm on `## Status`. A fiber the
   worker closed waits for a human verdict.

## State across sessions

Realization spans sessions by design. A context window is finite; a piece of
work often is not. So the fiber carries the durable state, not a transcript.
Each worker starts fresh, reads the spec and the handoff, and adds what it can.

Realization therefore stays asymptotic. You amend the constitution as the world
changes. You do not empty it like a checklist. Work finishes when a human says
it finishes.

Two state channels cross sessions. Keep them apart:

| Channel | Fields | Who writes it |
|---|---|---|
| Handoff prose | `outcome:`, the body's `## Status` | The worker, rewritten every session |
| Machine continuation | `shuttle.runtime.{session_uuid, dispatched_at, run_id, handed_off_at}` | The daemon at dispatch; the worker at clean exit; `accept`/`resume` when they re-arm a role |

`handed_off_at` newer than `dispatched_at` marks a clean exit, so the next
worker starts fresh. Otherwise the worker died dirty: a oneshot resumes the
prior transcript while it is warm (written in the last 45 minutes), and starts
fresh past that, with its prompt naming the cut-off session.

## The pieces

- **The shuttle CLI** — a Go binary beside felt. It owns the Shuttle schema,
  configuration, lifecycle, and resolved fiber reads. `shuttle daemon` manages
  the local daemon release; `shuttle doctor` diagnoses the host and runtime.
- **The daemon** — an optional Elixir/OTP release that bundles its own Erlang
  runtime. The shuttle CLI starts and supervises it. One process, bound to
  `127.0.0.1:4000`, polls, dispatches, and serves an HTTP API.
- **tmux** — hosts the worker process and is the view onto it. Not optional.
  tmux owns the worker process; shuttle owns only the watcher. So restarting the
  daemon leaves live workers running — the daemon re-adopts them on boot. A
  worker's liveness is its process: when tmux reports a session absent, the
  daemon checks the process table before believing it (see
  [Operating](../dev/operating.md#a-worker-tmux-cannot-see)).
- **The board** — a TypeScript UI, served by the daemon at
  `http://127.0.0.1:4000/`. A kanban desk plus four more views (Day, Week,
  Chronicle, and a canvas of the files workers sent) over the same fibers, tmux
  liveness, and the activity, session and commit [ledgers](telemetry.md) for
  every host it can reach (the **fleet** — one or more daemons working
  together, aggregated at a hub).
  It holds no state of its own. Skip it if you like:
  the CLI covers every lifecycle operation. (Cycles are the one thing only the
  board draws — see [Cycles and eras](cycles.md).)
- **The agent registry** — maps an agent id (`claude-opus`, `codex-luna`,
  `pi-luna`, …) to a CLI invocation. `shuttle agents` prints it.

## Next

- [Constitutions](constitutions.md) — how to author one.
- [Lifecycle](lifecycle.md) — the worker loop, exit semantics, dispatch gates.
- [The board](board.md) — the three views, and what each gesture writes.
- [Cycles and eras](cycles.md) — naming a span of time.
- [Telemetry and the ledgers](telemetry.md) — what the time views read.
- [Installation](installation.md) — installing both CLIs, fetching or building
  the optional daemon, and operating it.
