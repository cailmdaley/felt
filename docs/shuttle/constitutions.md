# Writing a constitution

A constitution specifies a **desired state**, not a plan. The worker decides the
steps. You decide what "done" looks like.

Three moves: create the fiber, write the spec, install the dispatch contract.

## 1. Create the fiber

```bash
felt add pipeline/covariance-loader "Rewrite the covariance loader" -t constitution
```

The `constitution` tag serves browsing only (`felt ls -t constitution`). It
gates nothing — the daemon reads the `shuttle:` block, never tags.

Path the slug under the right parent so containment carries the relationship.
See [Organizing](../concepts/organizing.md).

## 2. Write the spec

The body follows one fixed shape.

**Open with a lede** — a heading-less paragraph that orients both readers: the
human skimming a kanban card, and the worker landing cold at 3 a.m. Say what
this is, why now, where it sits. Weave in `[[wikilinks]]` to related fibers.

**Then `## Desired State`** — the contract, and the one required heading. Write
done-conditions in checkable terms where the work allows. Name the quality bar
if it earns naming. Name anything you are specifically *not* asking for.

**Then only sections the fiber has earned**, named for what they hold: "Touch
points", "Sharding rationale", "Considered alternatives". Resist a generic "Context"
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

The *worker* owns `## Status`. You do not write it when authoring; the first
worker creates it.

It gives the next reader a landing pad. Each session rewrites it — never
appends. It holds the now: what landed, where the worker got stuck, what the
next reader needs on arrival. Multi-paragraph prose is fine. Chronology that
matters goes into commits, not here.

### The kanban headline

Write `outcome:` as one or two sentences, rewritten every session: where the
work stands, and what the reader does next. A human reads it on the board
without opening anything.

When the work is blocked, lead the outcome with `Blocked: …` so the card reads
as "answer me," not "review me."

### Optional: `report.html`

If the product is something a human *reads* — findings, figures, comparisons —
say so in the constitution. The worker then rewrites a `report.html` companion
file in the fiber directory each session, and embeds it in the body:

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
sets felt `status: active`. The daemon picks the fiber up on the next poll.

Add `--disabled` to stash it as a draft (`status: open`). It lands in the
board's Drafts column and waits. `felt shuttle resume <fiber>` arms it later.

`install` is create-only. Run it against a fiber that already has a block and
it refuses, naming the verb you actually wanted — `felt shuttle status <fiber>`
to inspect the block's state and the daemon's dispatch assessment, `reshape`
to change kind or schedule, `set-model`/`set-agent` to change the agent, or
`uninstall` to start over.

You can also write the block by hand while drafting. `install` adds schema
validation, which makes it the canonical path. Felt reports a hand-written block
with no `status` as undispatchable, and install will not auto-arm it.

## The three kinds

Felt validates `shuttle.kind` (`internal/shuttle/schema.go`).

### `oneshot`

The default, and the kind most work wants. Dispatches on the next poll while
`status: active`. Redispatches after every clean handoff until a human closes
it.

```bash
felt shuttle install <fiber> --project-dir "$PWD"
```

### `standing`

Recurring, driven by a cron expression. Installed with the `repeat` verb:

```bash
felt shuttle repeat <fiber> \
  --schedule "0 9 * * 1-5" --tz Europe/Paris --project-dir "$PWD"
```

Shuttle computes due-ness from the cron expression against now, and stores
nothing. So no dispatch can silently consume a slot. The
`active → closed → active` document transition records that an occurrence ran.

A standing role carries at most one unaccepted work product. While a run waits
for review, scheduled runs do not fire and ad-hoc dispatch refuses. Accepting it
(`felt shuttle accept`) re-arms the role and clears the outcome.

### `pinned`

A schedule-less perennial interface — a status hub, a debug intake. A `schedule`
on a pinned block fails validation.

```bash
felt shuttle pin <fiber> --project-dir "$PWD"
```

It rests on the board's pinned strip until a human starts it. Once running it
joins the ordinary lifecycle: a deliberate handoff relaunches a fresh successor,
a dirty death or idle exit parks it back to the strip, a close-out lands in
Awaiting review.

Oneshots alone make a coherent system. Ignore standing and pinned until you want
them.

### Changing kind

`install`, `pin`, and `repeat` refuse to clobber an existing block. To convert,
use `felt shuttle reshape`:

```bash
felt shuttle reshape <fiber> standing --schedule "0 9 * * 1" --tz UTC
```

`kind` is optional — omit it to leave the current kind alone and edit only the
schedule (`felt shuttle reshape <fiber> --schedule "0 7 * * *"`). Reshape
rewrites `agent`, `host`, and `project_dir` when passed, and leaves the rest of
the block — including the daemon-owned `runtime:` keys — untouched. It never
touches felt's lifecycle fields (`status`, `tempered`, `outcome`), so a role
sitting in Awaiting review can be reshaped in place without being requeued. A
`standing` target needs a schedule, from `--schedule` or echoed from the
existing block; a `oneshot` or `pinned` target drops the schedule, and passing
`--schedule`/`--tz` against one is an error.

## Agent selection

`felt shuttle agents` prints the effective registry — run it for your current
list. The maintained fleet ships built in:

| Family | Built-in ids | Notes |
|---|---|---|
| Claude | `claude-sonnet` (registry default), `claude-opus`, `claude-fable`, `claude-haiku` | Chrome is an explicit axis on Claude agents, not a separate agent. |
| Codex | `codex-sol`, `codex-terra`, `codex-luna`, `codex`, `codex-spark` | |
| Pi | `pi-sonnet`, `pi-gpt-5.4`, `pi-gpt-5.4-mini`, `pi-gpt-5-mini`, `pi-kimi`, `pi-deepseek-pro`, `pi-deepseek-flash` | |

Two orthogonal axes layer on the base id: `effort` (validated against the
resolved agent's allowed levels) and `chrome` (Claude only, for browser work).

```bash
felt shuttle set-agent <fiber> claude-opus --effort high
felt shuttle set-agent <fiber> claude-opus --chrome
felt shuttle set-model <fiber> codex          # agent-only shorthand
```

!!! note "Add your own agents"
    Your registry file layers over the built-ins by default. Set
    `builtins: "restrict"` when it should be the complete registry for one
    host. Run `felt shuttle agents init` to seed
    `~/.config/felt/agents.json` (or `$FELT_AGENTS_FILE`), then edit it — new
    ids, aliases, or replacements for built-in ones. See
    [Configuring agents](installation.md#configuring-agents).

## Required gates

You set these three gates by hand. Install refuses, or the daemon ignores the
fiber, unless all three hold. Check them first, but expect more — see
[Dispatch eligibility](lifecycle.md#dispatch-eligibility) for the full ordered
list the daemon evaluates.

- **`project_dir`** — the worker's working directory on the target host.
  `install` and `repeat` require it (install allows omitting it only with
  `--disabled`). The daemon also checks that the directory exists. It runs that
  gate last, because that gate alone touches the filesystem. On macOS a stat
  inside a synced folder can raise a permission prompt nobody can grant.
- **`host`** — the owning daemon's host id. A daemon dispatches a block if and
  only if `block.host` equals its own id (`SHUTTLE_HOST`, else the file
  `~/.shuttle/host`, else the system hostname). Shuttle offers no `"local"`
  default and no wildcard. An absent host leaves the fiber unowned and
  ineligible on every daemon. `install`, `repeat`, and `pin` stamp it by
  default.
- **`status: active`** — the sole dispatch gate. `open` marks a draft or a
  pause. `closed` marks awaiting review or a terminus.

Two more conditions live outside the block: the fiber must sit in a felt store
the daemon polls, and its `depends_on` targets must all be `tempered: true`.

## Human in the loop

Every dispatch runs autonomously; Shuttle offers no interactive mode. When work
needs a human, that expectation rides one of two channels.

**Per-dispatch.** The board's requeue/resume dialog carries a free-text "From
User" directive, plus a one-click affordance that prepends a talk-first line.
The worker reads the directive at the top of its context. The directive applies
to that moment only — the next dispatch starts clean.

**Structural.** Some work simply cannot one-shot: a 2FA step, a final send in
your own voice, a draft-and-stage shape where the human commits. Write the gate
into the constitution text: *"I will be present; drive to the send and wait."*
The worker reads the spec as its contract and stays alive at that gate.

If a flow has a human-gated step, write the gate into the spec. No flag does
this.
