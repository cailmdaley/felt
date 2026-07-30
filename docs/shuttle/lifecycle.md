# Lifecycle

What happens between "the daemon sees an armed fiber" and "a human accepts the
result."

## The worker loop

The daemon starts one tmux session per eligible fiber, named
`<slug-leaf>-<uid>-shuttle` (legacy `<slug-leaf>-shuttle` for a fiber with no
ULID), running the agent CLI in `shuttle.project_dir`. `felt shuttle
session-name <fiber>` prints the canonical name. The prompt
it composes is deliberately thin: the fiber id, the felt store path, an exit
contract, and an optional per-dispatch "From User" directive.

It does **not** paste the constitution into the prompt. The worker reads the
fiber fresh from disk, so an edit you make mid-session is picked up rather than
frozen into a stale snapshot.

From there the worker:

1. **Surveys** — reads the constitution, the previous `## Status` handoff, the
   `git log` in and around the project directory, and any sub-fibers.
2. **Works** — picks the highest-value slice itself. The constitution describes
   what "done" looks like; sequencing is the worker's call.
3. **Writes back** — rewrites `outcome:`, rewrites `## Status`, corrects the spec
   if the session sharpened it, files findings as sub-fibers, commits.
4. **Hands off** — runs `felt shuttle handoff <fiber>` as its final action.

Workers are expected to exit earlier than feels natural. A clean handoff at half
a context window beats pushing through a compaction, because `## Status` plus the
constitution recovers most of a warm world-model on the next dispatch.

## Exit semantics

The worker asks three questions, in order. The answer sets `status`, and `status`
decides what happens next.

**1. Is the desired state realized?** Set `status: closed` and exit. The card
lands in Awaiting review. A human accepts it or flips it back to `active`.

Substantive work should get independent fresh-eyes review before the session that
produced it closes — a subagent reviewer in-session, or leave the fiber `active`
and let the next dispatch review it cold. Editing the fiber's own surfaces
(spec, `## Status`, `outcome`, `report.html`) is handoff, not work product, and
never blocks a close.

**2. Blocked on something only a human can supply?** Set `status: closed`, and
lead the outcome with `Blocked: …` so the card reads as a question.

**3. More work, not blocked?** Leave `status: active` and just hand off. The
daemon starts a fresh worker next tick, and it lands on your `## Status`.

### Close is not "complete"

The vocabulary is obeyed literally, and it is worth knowing which word does what.

| You say | The worker does | Next |
|---|---|---|
| "hand off" | case 3 — `status` stays `active` | Daemon redispatches |
| "close it out" | `status: closed`, then handoff | Card waits for you; no new worker |

Closing is a human parking the work. It is not a claim of completion, and a
worker should not upgrade a close-out into a continuation because the work looks
unfinished — unfinished is often exactly why you want it back on your desk.

### Tempered is human-only

`tempered` is the verdict axis, and a worker never sets it to `true`.

| `tempered` | Meaning |
|---|---|
| absent | Awaiting review |
| `true` | Accepted |
| `false` | Composted — mooted or superseded |

Workers also never uninstall their own `shuttle:` block. Closing and
uninstalling are separate decisions, and the block stays as historical record.

### Resume vs fresh

A fresh worker is the default. Resuming a transcript happens in exactly two
cases: you press Resume on the board, or a oneshot died dirty. A death is dirty
when `handed_off_at` is missing or older than `dispatched_at` — that is the whole
test, and it is why the handoff verb matters.

Scheduled runs, ad-hoc standing runs, daemon recovery, and orphan adoption are
all fresh.

## The board

The daemon serves a kanban board at `http://127.0.0.1:4000/`. It is a pure view:
the same fibers, plus live tmux liveness. Column membership is computed in the
browser by `classifyFiber` (`ui/src/board/KanbanRules.ts`), which is the single
source of truth.

Evaluated in order:

| Column | Condition |
|---|---|
| Tempered | `closed` + `tempered: true` |
| Composted | `closed` + `tempered: false` |
| Awaiting review | `closed`, `tempered` absent |
| In flight | live tmux worker with a shuttle block — liveness wins over everything below |
| Pinned | resting `kind: pinned` (`open` or `active`) |
| Drafts | no shuttle block |
| Scheduled | `active` + `kind: standing` — placed on the timeline at next launch |
| In flight | `active`, other kinds |
| Drafts | `open` |

The classifier reads only `status`, `tempered`, `kind`, and tmux liveness. Tags
are read by neither the daemon nor the board.

Beyond the columns the board offers a pinned strip, a timeline for scheduled
roles, a fiber and file viewer, Stash and Capture dialogs, Attach (opens the
worker's tmux session in kitty specifically — a non-kitty user gets nothing),
and a requeue/resume dialog with a directive box.

Two gestures with different meanings: **drag-and-drop** advances the card's
state; **modal buttons** give you another worker on the same run. Drag-to-tempered
is kind-aware — on a standing role it accepts and re-arms, on a pinned role it
accepts and re-parks to the strip, on a oneshot it writes the terminus. Only
`accept` clears the outcome.

!!! note "The board is optional, and built separately"
    The bundle is not in the repo. Build it with `cd ui && npm ci && npx vite
    build`, which writes `ui/dist`. (`npm run build` adds a typecheck that fails
    on a fresh clone — see
    [Sharp edges](installation.md#sharp-edges).) `make all` rebuilds only the
    daemon escript. Without the
    bundle the root URL 404s with a hint and the API stays fully usable. If you
    change any `/api/v1/*` route, rebuild the bundle — a stale bundle against a
    changed route table fails silently as a 404.

## Dispatch eligibility

A fiber dispatches if and only if all of these hold. The daemon evaluates them in
this order (`eligible?/2` and `dispatch_gates_pass?/3` in `lib/shuttle/poller.ex`).

1. It lives in a felt store the daemon polls.
2. It carries a `shuttle:` block. This is the sole definition of
   "shuttle-managed" — there is no tag predicate.
3. Its agent is not `human`.
4. `shuttle.host` equals this daemon's own host id.
5. Felt-native `status` is `active`.
6. No worker is already running or claimed for it.
7. The resume-loop circuit breaker is closed.
8. The boot quarantine is released.
9. `shuttle.project_dir` exists on this host.
10. Every `depends_on` target exists and is `tempered: true`.

Configured stores come from `FELT_STORES` (comma-separated) or the persisted
registry at `~/.config/felt/stores.json`. There is no implicit default store.

**The circuit breaker** (7) exists because a worker that dies on startup will
otherwise be relaunched forever. Five consecutive worker deaths, each under 90
seconds, pause autonomous dispatch for that fiber for ten minutes and surface it
as `blocked`. A healthy run or a force-dispatch clears it.

## Boot quarantine

An overloaded machine once crashed the daemon repeatedly, and each restart's
first poll dispatched every armed, workerless fiber it could see. Eight
token-burning launches in four minutes, several of them redundant.

So: **a daemon restart is not dispatch authority.** On every start, the daemon
parks every candidate it has never observed running into `pending_launch` and
dispatches nothing fresh. Work it *did* observe alive under its own uptime —
adopted at boot, or dispatched since — resumes normally, because that is
continuation, not a fresh launch.

Release is manual. No timeout, no self-clearing.

```bash
bin/shuttle release
```

A human force-dispatch bypasses the quarantine without clearing it.

## CLI verbs

Two binaries, cleanly split. `felt shuttle` is the agent-facing surface: offline,
schema-validating, writes to disk. Every verb and flag is tabulated in the
[CLI reference](../reference/cli.md#felt-shuttle-dispatch-layer).

`bin/shuttle` is daemon lifecycle, and lives only in the checkout:

```bash
bin/shuttle status
bin/shuttle snapshot
bin/shuttle dispatch <fiber>
bin/shuttle release           # clear the boot quarantine
bin/shuttle reset <remote>    # reset a remote's circuit breaker
bin/shuttle version
```

The daemon also exposes everything the board uses over HTTP under
`/api/v1` — `state`, `fibers`, `dispatch`, `claim`, `capture`, `transition`,
`kill`, `attach`, `agents`, `version`, and the manual gate releases.

```bash
curl -s http://127.0.0.1:4000/api/v1/agents | jq
```

## When to uninstall

Closing a fiber does not remove its block, and that is deliberate. Uninstall
earns its keep in four cases:

1. **Mistake recovery** — wrong slug, immediate undo.
2. **Reshaping the contract** — though `--reshape` now covers most of this.
3. **Archiving** — a closed fiber's card leaves the board entirely.
4. **Handing ownership** to a different dispatcher.

Uninstall is not how a worker ends its session.

## Card missing?

Most "my card isn't showing" reduces to "no block installed yet." Check in this
order: is the fiber in a store the daemon polls, does `felt shuttle status` show
a block, is `status: active`, does `shuttle.host` match, and is the quarantine
released?

For multi-host setups, remote fibers reach the board over an SSH tunnel from the
owning daemon — never via git sync. A git mirror that happens to replicate a
remote fiber's files locally is incidental, and any behaviour that depends on it
is a bug. If a remote card is missing, debug the tunnel, not the git state.

!!! warning "Remote hosts are hardcoded"
    The remote registry lives in `config/dev.exs` and the tunnel port map in
    `cmd/shuttle_tunnels.go`. Both name the maintainer's machines. A
    single-machine setup needs neither — see
    [Honest scoping](index.md#honest-scoping).
