# shuttle

shuttle dispatches coding agents against felt fibers. felt keeps those fibers as
markdown files in a directory. shuttle adds one optional frontmatter block, plus
a daemon that acts on it.

Nothing else about felt changes. Leave the block out and the fiber stays a plain
note. Add the block and the daemon can hand the fiber to a coding agent as a
**constitution**.

!!! note "You can skip this whole section"
    felt works without shuttle. The CLI runs as a Go binary over a markdown
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
  project_dir: /home/me/dev/pipeline
  agent: claude-opus
---
```

Those keys cover the whole dispatch interface. felt validates the block's shape
and otherwise treats it as opaque frontmatter. Remove the daemon and you still
have a readable, greppable, version-controlled markdown file.

(The board reads a small calendar vocabulary outside the block — `start:`,
`horizon:`, and the `cycle` tag. See [Cycles and eras](cycles.md).)

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

- **The daemon** — an Elixir/OTP release that bundles its own Erlang runtime,
  started through the `bin/shuttle` shim. One process, bound to
  `127.0.0.1:4000`. It polls, dispatches, and serves an HTTP API.
- **tmux** — hosts the worker process and reports its liveness. Not optional.
  tmux owns the worker process; shuttle owns only the watcher. So restarting the
  daemon leaves live workers running — the daemon re-adopts them on boot.
- **The board** — a TypeScript UI, served by the daemon at
  `http://127.0.0.1:4000/`. A kanban desk plus four more views (Day, Week,
  Chronicle, and a canvas of the files workers sent) over the same fibers, tmux
  liveness, and the activity, session and commit [ledgers](telemetry.md) for
  every host it can reach (the **fleet** — one or more daemons working
  together, aggregated at a hub; see [Honest scoping](#honest-scoping) below).
  It holds no state of its own. Skip it if you like:
  the CLI covers every lifecycle operation. (Cycles are the one thing only the
  board draws — see [Cycles and eras](cycles.md).)
- **The agent registry** — maps an agent id (`claude-opus`, `codex`,
  `pi-sonnet`, …) to a CLI invocation. `felt shuttle agents` prints it.

## Honest scoping

One thing is still rough, and the other pages point here for it. It is about
operating a fleet rather than running the daemon.

**Deploy assumes a hub that builds the board.** `bin/shuttle-deploy` pulls and
rebuilds on every host in the fleet file, and rsyncs `ui/dist` out from the
machine you run it on, because a cluster login node is not expected to have
Node. Each of those hosts is a checkout.

Everything else that used to sit in this list is closed. The release pipeline
builds a daemon tarball per platform — Linux and macOS, x86_64 and arm64 — each
carrying its own Erlang runtime and the board bundle, so running the daemon
needs no Erlang, Elixir or Node. That tarball also carries its own keep-alive:
`shuttle install-agent` renders the launchd plist or the systemd user unit from
templates inside the release, so a fetched daemon supervises itself with no
checkout and no `make` (see [Installation](installation.md#keep-alive)). A Linux
machine can be a hub as well as a remote — `felt shuttle tunnels install` writes
systemd user units there and launchd jobs on macOS. The commit ledger has a
shipped writer, so the Chronicle narrates without a hand-installed hook. The
examples name no particular store.

## Next

- [Constitutions](constitutions.md) — how to author one.
- [Lifecycle](lifecycle.md) — the worker loop, exit semantics, dispatch gates.
- [The board](board.md) — the five views, and what each gesture writes.
- [Cycles and eras](cycles.md) — naming a span of time.
- [Telemetry and the ledgers](telemetry.md) — what the time views read.
- [Installation](installation.md) — fetching or building the daemon, and
  operating it.
