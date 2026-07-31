# Shuttle

Shuttle dispatches coding agents against felt fibers. Felt keeps those fibers as
markdown files in a directory. Shuttle adds one optional frontmatter block, plus
a daemon that acts on it.

Nothing else about felt changes. Leave the block out and the fiber stays a plain
note. Add the block and the daemon can hand the fiber to a coding agent as a
**constitution**.

!!! note "You can skip this whole section"
    Felt works without Shuttle. The CLI runs as a Go binary over a markdown
    tree. If you want a notes-and-tasks store, stop at
    [Concepts](../concepts/fibers.md) — you lose nothing.

## The block

```yaml
---
name: Rewrite the covariance loader
status: active
shuttle:
  kind: oneshot
  host: my-laptop
  project_dir: /Users/me/dev/pipeline
  agent: claude-opus
---
```

Those keys cover the whole interface. Felt validates the block's shape and
otherwise treats it as opaque frontmatter. Remove the daemon and you still have
a readable, greppable, version-controlled markdown file.

## The loop

1. **Author.** Write a fiber body that describes a *desired state*. Then run
   `felt shuttle install` to attach the block and arm the fiber.
2. **Dispatch.** The daemon polls the fiber tree every 30 s by default. For each
   eligible fiber it starts exactly one tmux session, running an agent CLI in
   `project_dir`. `felt shuttle session-name <fiber>` prints the session name,
   `<slug-leaf>-<uid>-shuttle`.
3. **Work.** The worker reads the constitution fresh from disk. It reads the
   previous session's `## Status` handoff. Then it drives toward the desired
   state and picks its own slice. Sequencing emerges; nobody scripts it.
4. **Hand off.** Before exiting, the worker rewrites `outcome:` (the kanban
   headline) and the body's `## Status` block (the next worker's landing pad).
   It then runs `felt shuttle handoff <fiber>`. That stamps a clean-exit marker
   and ends its own tmux session in one move.
5. **Redispatch or review.** A fiber still marked `active` gets a fresh worker
   on the next tick, and that worker lands warm on `## Status`. A fiber the
   worker set to `status: closed` waits for a human verdict.

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
| Machine continuation | `shuttle.runtime.{session_uuid, dispatched_at, run_id, handed_off_at}` | The daemon at dispatch; the worker at clean exit |

`handed_off_at` newer than `dispatched_at` marks a clean exit, so the next
worker starts fresh. Otherwise the worker died dirty, and a oneshot resumes the
prior transcript.

## The pieces

- **The daemon** — an Elixir/OTP escript at `bin/shuttle`. One process, bound to
  `127.0.0.1:4000`. It polls, dispatches, and serves an HTTP API.
- **tmux** — hosts the worker process and reports its liveness. Not optional.
  tmux owns the worker process; Shuttle owns only the watcher. So restarting the
  daemon leaves live workers running — the daemon re-adopts them on boot.
- **The board** — a TypeScript kanban UI, served by the daemon at
  `http://127.0.0.1:4000/`. It views the same fibers plus tmux liveness, and
  holds no state of its own. Skip it if you like: the CLI covers every
  operation.
- **The agent registry** — maps an agent id (`claude-opus`, `codex`,
  `pi-sonnet`, …) to a CLI invocation. `felt shuttle agents` prints it.

## Honest scoping

Shuttle runs the maintainer's machines every day, and parts of it still show
that. This section lists them all; the other pages point here.

- **`bin/shuttle-deploy` serves the maintainer's fleet.** It rsyncs a checkout
  to named hosts and restarts their daemons. The general name oversells it.
  Ignore it unless you run the same layout.
- **macOS gets the most use.** The launchd keep-alive, the tunnel plists, and
  the TCC workarounds are all macOS-first. Linux runs on a thinner path: a tmux
  respawn loop, no systemd unit.
- **Several examples name a private store.** Docs and Makefile defaults point at
  `~/loom`, the maintainer's [cross-project
  store](../concepts/cross-project.md). Substitute your own store path
  everywhere it appears.
- **The daemon ships no release artifact.** You build it from a checkout and you
  keep the checkout. See [Installation](installation.md).

None of this blocks a single-machine adopter. It does earn Shuttle the label
"currently fleet-oriented" rather than "general-purpose orchestrator."

## Next

- [Constitutions](constitutions.md) — how to author one.
- [Lifecycle](lifecycle.md) — the worker loop, exit semantics, and the board.
- [Installation](installation.md) — building the daemon from source.
