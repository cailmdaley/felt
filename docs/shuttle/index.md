# Shuttle

Shuttle is an optional dispatch layer over felt. Felt is a directory of markdown
fibers. Shuttle adds one optional frontmatter block and a daemon that acts on it.

Nothing else about felt changes. A fiber without the block is a plain note. A
fiber with the block is a **constitution** — a spec the daemon can hand to a
coding agent.

!!! note "You can skip this whole section"
    Felt is complete without Shuttle. The CLI is a Go binary over a markdown
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

That is the whole interface. Felt validates the block's shape and otherwise
treats it as opaque frontmatter. Remove the daemon and the fiber is still a
readable, greppable, version-controlled markdown file.

## The loop

1. **Author.** You write a fiber whose body describes a *desired state*, then
   run `felt shuttle install` to attach the block and arm the fiber.
2. **Dispatch.** The daemon polls the fiber tree (30 s by default). For each
   eligible fiber it starts exactly one tmux session — named
   `<slug-leaf>-<uid>-shuttle`, which `felt shuttle session-name <fiber>` prints
   — running an agent CLI in `project_dir`.
3. **Work.** The worker reads the constitution fresh from disk, reads the
   previous session's `## Status` handoff, and drives toward the desired state.
   It picks its own slice. Sequencing is emergent, not scripted.
4. **Hand off.** Before exiting the worker rewrites `outcome:` (the kanban
   headline) and the body's `## Status` block (the next worker's landing pad),
   then runs `felt shuttle handoff <fiber>`. That stamps a clean-exit marker and
   ends its own tmux session in one move.
5. **Redispatch or review.** If the fiber is still `active`, the daemon starts a
   fresh worker on the next tick. It lands warm on `## Status`. If the worker set
   `status: closed`, the card waits for a human verdict.

## Why it is shaped this way

Realization spans sessions by design. A context window is finite; a piece of
work often is not. So the durable state lives in the fiber, not in a transcript:
each worker starts fresh, reads the spec and the handoff, and adds what it can.

That also means realization is asymptotic. The constitution is amended as the
world changes, not emptied like a checklist. Work is done when a human says it
is done.

Two state channels carry across sessions, and they are worth keeping apart:

| Channel | Fields | Who writes it |
|---|---|---|
| Handoff prose | `outcome:`, the body's `## Status` | The worker, rewritten every session |
| Machine continuation | `shuttle.runtime.{session_uuid, dispatched_at, run_id, handed_off_at}` | The daemon at dispatch; the worker at clean exit |

`handed_off_at` newer than `dispatched_at` means the worker exited cleanly, so
the next one starts fresh. Otherwise the death was dirty, and a oneshot resumes
the prior transcript instead.

## The pieces

- **The daemon** — an Elixir/OTP escript at `bin/shuttle`. One process, bound to
  `127.0.0.1:4000`. It polls, dispatches, and serves an HTTP API.
- **tmux** — the worker process substrate and the source of truth for liveness.
  Not optional. tmux owns the worker process; Shuttle only owns the watcher. So
  restarting the daemon does not kill live workers — they are re-adopted on boot.
- **The board** — a TypeScript kanban UI served by the daemon at
  `http://127.0.0.1:4000/`. A pure view over the same fibers plus tmux liveness.
  It has no state of its own, and it is optional: the CLI is a complete
  operating surface.
- **The agent registry** — a table mapping an agent id (`claude-opus`, `codex`,
  `pi-sonnet`, …) to a CLI invocation. `felt shuttle agents` lists it.

## Honest scoping

Shuttle runs the maintainer's machines every day, and parts of it still show
that. This section is the full list; the other pages point here.

- The **agent registry is compiled into the felt binary**
  (`internal/shuttle/agents.json`). Adding an agent means editing that file and
  rebuilding. There is no user-level registry file yet.
- **Multi-host support hardcodes hostnames in two places.**
  `cmd/shuttle_tunnels.go` maps four fixed hostnames to ports 4001–4004, and
  `config/dev.exs` carries the daemon's remote registry, gated on one specific
  hostname. Single-machine use needs neither, but a different fleet means
  editing both and rebuilding.
- The optional **hook event stream** expects a script that lives outside this
  repo, in the maintainer's private `~/loom` store. Without it the board still
  works; you lose per-session activity ranking.
- **The daemon is not a release artifact.** You build it from a checkout and you
  keep the checkout. See [Installation](installation.md).

None of this blocks a single-machine adopter. It does mean "currently
fleet-oriented" is the honest label, not "general-purpose orchestrator."

## Next

- [Constitutions](constitutions.md) — how to author one.
- [Lifecycle](lifecycle.md) — the worker loop, exit semantics, and the board.
- [Installation](installation.md) — building the daemon from source.
