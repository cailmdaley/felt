# Writing a constitution

A constitution is a fiber that specifies a **desired state**, not a plan. The
worker decides the steps. You decide what "done" looks like.

Three moves: create the fiber, write the spec, install the dispatch contract.

## 1. Create the fiber

```bash
felt add pipeline/covariance-loader "Rewrite the covariance loader" -t constitution
```

The `constitution` tag is a browsing convention (`felt ls -t constitution`). It
gates nothing — the daemon reads the `shuttle:` block, never tags.

Path the slug under the right parent so containment carries the relationship.
See [Organizing](../concepts/organizing.md).

## 2. Write the spec

The body has one fixed shape.

**Open with a lede** — a heading-less paragraph that orients both readers: the
human skimming a kanban card, and the worker landing cold at 3 a.m. What this
is, why now, where it sits. Weave in `[[wikilinks]]` to related fibers.

**Then `## Desired State`** — the contract, and the one required heading. Write
done-conditions in checkable terms where the work allows. Include the quality
bar if it earns naming, and anything you are specifically *not* asking for.

**Then only sections the fiber has earned**, named for what they hold: "Touch
points", "Why sharded", "Considered alternatives". Resist a generic "Context"
section — a section named for nothing in particular fills up like a junk drawer.

```markdown
The loader rebuilds the full covariance on every call, which dominates runtime
in the [[pipeline/mcmc-driver]] inner loop. Caching was tried and reverted
because the cache key ignored the binning scheme.

## Desired State

`load_covariance()` returns in under 50 ms for a warm call on the fiducial
binning. The cache key includes the binning scheme and the survey mask hash.
`pytest tests/test_covariance.py` passes, including the two currently-skipped
cache tests.

Not in scope: the Gaussian-approximation path. That is [[pipeline/gauss-cov]].
```

Keep the body small and the network rich. Depth belongs in linked sub-fibers.

Do not write worker mechanics into the spec — verification cadence, exit
discipline, when to spawn subagents. The agent-side skill carries those for
every worker, and instructions dated to one model generation age badly.

### The `## Status` handoff

`## Status` is a section the *worker* owns. You do not write it when authoring;
the first worker creates it.

It is the landing pad. Each session rewrites it — never appends. It holds the
now: what landed, where the worker got stuck, what the next reader needs on
arrival. Multi-paragraph prose is fine. It is not a session log; chronology that
matters goes into commits.

### Outcome is the kanban headline

`outcome:` is one or two sentences, rewritten every session: where the work is,
and what the reader does next. It is what a human sees on the board without
opening anything.

When the work is blocked, the outcome leads with `Blocked: …` so the card reads
as "answer me," not "review me."

### Optional: `report.html`

If the product is something a human *reads* — findings, figures, comparisons —
say so in the constitution. The worker will maintain a `report.html` companion
file in the fiber directory and embed it in the body:

```markdown
:::{embed} report.html
:::
```

Code-shaped work whose story is commits plus an outcome line needs none.

## 3. Install the dispatch contract

```bash
felt shuttle install pipeline/covariance-loader \
  --project-dir "$PWD" \
  --model claude-opus
```

This writes the `shuttle:` block, validates the agent against the registry, and
sets felt `status: active` so the daemon picks the fiber up on the next poll.

Add `--disabled` to stash it as a draft (`status: open`). It lands in the board's
Drafts column and waits. `felt shuttle resume <fiber>` arms it later.

`install` is idempotent. Run it against a fiber that already has a block and it
prints the block's state plus the daemon's dispatch assessment, then exits 0 —
unless a flag you passed conflicts with what is there. Then it exits non-zero and
names the verb you actually wanted (`pause`, `resume`, `set-model`,
`uninstall`).

You can also write the block by hand while drafting. `install` adds schema
validation, which is why it is the canonical path. A hand-written block with no
`status` is reported as undispatchable; install will not auto-arm it.

## The three kinds

`shuttle.kind` is validated by felt (`internal/shuttle/schema.go`).

### `oneshot`

The default, and the one most work wants. Dispatches on the next poll while
`status: active`. Redispatches after every clean handoff until a human closes it.

```bash
felt shuttle install <fiber> --project-dir "$PWD"
```

### `standing`

Recurring, driven by a cron expression. Installed with the `repeat` verb:

```bash
felt shuttle repeat <fiber> \
  --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
```

Due-ness is computed from the cron expression against now. Nothing is stored, so
no dispatch can silently consume a slot. The `active → closed → active` document
transition is what records "this occurrence already ran."

A standing role has at most one unaccepted work product. While a run waits for
review, scheduled runs do not fire and ad-hoc dispatch refuses. Accepting it
(`felt shuttle accept`) re-arms the role and clears the outcome.

### `pinned`

A schedule-less perennial interface — a status hub, a debug intake. A `schedule`
on a pinned block is a validation error.

```bash
felt shuttle pin <fiber> --project-dir "$PWD"
```

It rests on the board's pinned strip until a human starts it. Once running it
joins the ordinary lifecycle: a deliberate handoff relaunches a fresh successor,
a dirty death or idle exit parks it back to the strip, a close-out lands in
Awaiting review.

Oneshots alone are a coherent system. Standing and pinned are additions you can
ignore until you want them.

### Changing kind

The three writers refuse to clobber an existing block. To convert, either
`felt shuttle uninstall` and reinstall, or pass `--reshape` for a single guarded
in-place rewrite:

```bash
felt shuttle repeat <fiber> --reshape --schedule "0 9 * * 1" --tz UTC
```

On a reshape, omitted `--project-dir`, `--host`, and `--model` echo from the old
block.

## Agent selection

`felt shuttle agents` prints the registry — run it for the current list. Today
it spans four CLI harnesses:

| Family | Examples | Notes |
|---|---|---|
| Claude | `claude-sonnet` (registry default), `claude-opus`, `claude-fable`, `claude-haiku` | Plus `-headless` variants and `claude-opus-chrome` |
| Codex | `codex-sol`, `codex-terra`, `codex-luna`, `codex-spark` | `codex` is an alias of `codex-sol` |
| Pi | `pi-sonnet`, `pi-gpt-5.4`, `pi-gpt-5.4-mini`, `pi-gpt-5-mini`, `pi-kimi`, `pi-deepseek-*` | GitHub Copilot and OpenRouter billing |
| `human` | `human` | A pseudo-agent. The card shows as in-flight; Shuttle never spawns anything. |

Two orthogonal axes layer on the base id: `effort` (validated against the
resolved agent's allowed levels) and `chrome` (Claude only, for browser work).

```bash
felt shuttle set-agent <fiber> claude-opus --effort high
felt shuttle set-model <fiber> codex          # agent-only shorthand
```

!!! warning "The registry is compiled in"
    `internal/shuttle/agents.json` is embedded into the Go binary at build time.
    Adding or renaming an agent requires editing that file and running
    `make cli-install` — on every host. A user-level registry file does not
    exist yet. See [Honest scoping](index.md#honest-scoping).

## Required gates

These are the three gates you set by hand. Install refuses, or the daemon
ignores the fiber, unless all three hold. They are the first thing to check, not
the whole test — see
[Dispatch eligibility](lifecycle.md#dispatch-eligibility) for the full ordered
list the daemon evaluates.

- **`project_dir`** — the worker's working directory on the target host.
  `install` and `repeat` require it (install allows omitting it only with
  `--disabled`). The daemon also checks that the directory exists, and checks it
  last of all the gates: it is the only filesystem-touching predicate, and on
  macOS a stat inside a synced folder can raise a permission prompt nobody can
  grant.
- **`host`** — the owning daemon's host id. A daemon dispatches a block if and
  only if `block.host` equals its own id (`SHUTTLE_HOST`, else the file
  `~/.shuttle/host`, else the system hostname). There is no `"local"` default
  and no wildcard. An absent host is
  unowned and ineligible everywhere. `install`, `repeat`, and `pin` stamp it by
  default.
- **`status: active`** — the sole dispatch gate. `open` is a draft or a pause,
  `closed` is awaiting review or a terminus. There is no separate `enabled` flag.

Two more conditions live outside the block: the fiber must sit in a felt store
the daemon polls, and its `depends_on` targets must all be `tempered: true`.

## Human in the loop

There is no "interactive" dispatch mode. Every dispatch is autonomous. When work
needs a human, that expectation rides one of two channels.

**Per-dispatch.** The board's requeue/resume dialog has a free-text "From User"
directive, plus a one-click affordance that prepends a talk-first line. The
worker reads the directive at the top of its context. This is a property of the
*moment* — the next dispatch starts clean.

**Structural.** When the work simply cannot one-shot — a 2FA step, a final send
in your own voice, a draft-and-stage shape where the human commits — write the
gate into the constitution text: *"I will be present; drive to the send and
wait."* The worker reads the spec as its contract and stays alive at that gate.

If a flow has a human-gated step, write the gate into the spec. Do not reach for
a flag; there isn't one.
