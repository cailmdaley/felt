# Operating Shuttle

Lifecycle verbs, kanban semantics, and the triage paths for "why isn't my card doing what I expect."

## Dispatch eligibility

The daemon dispatches a fiber when all of these hold:

1. The fiber lives in a felt store the daemon polls. Configured stores come from `FELT_STORES` → the persisted registry at `~/.config/felt/stores.json` (no implicit default); a store like `~/loom` also exposes the project substores symlinked under its `.felt/`.
2. **The fiber carries a `shuttle:` block.** A fiber is shuttle-managed iff it has this block — installed via `felt shuttle install` (oneshot) or `felt shuttle repeat` (standing). The daemon reads the block directly; no tag predicate, no CLI spawn during the poll.
3. **Felt-native `status:` is `active`** — the sole dispatch gate (`eligible?/2` in `lib/shuttle/poller.ex`). `active` is armed, `open` is a draft, `closed` is a terminus / awaiting review.
4. Dependencies are satisfied: each `depends_on` target exists and has `tempered: true`.

Agent comes from `shuttle.agent`, resolved against felt's registry (`internal/shuttle/agents.json`, embedded into the CLI; the daemon consumes the resolved record off `felt show -j`). The bare fallback when a fiber carries no `shuttle.agent` is `claude-sonnet`; the recommended default for real work is `claude-opus` (see authoring.md, Agent selection).

**Tags never gate dispatch — or the view.** Three layers feed the system: the `shuttle:` block (`kind`, `schedule`, `agent`, `host`, `project_dir`) declares shuttle-management; universal lifecycle scalars (`status`, `tempered`, `depends_on`) drive dispatch and view; tags are free-form noticings read by neither the daemon nor the kanban classifier.

## Kanban columns

Column membership derives from felt `status` + `tempered` + `shuttle.kind` + tmux liveness (`classifyFiber` in `ui/src/board/KanbanRules.ts` — the single source of truth):

- **Drafts**: `status: open`, or no `shuttle:` block at all (a stash awaiting refinement; `felt shuttle pause` lands a card here).
- **Scheduled**: an armed standing role between firings (`status: active`, no live worker) — it fires on its own cron, so it sits on the timeline at its next launch rather than in the Now lane.
- **Pinned**: a resting `kind: pinned` role — the strip of perennial interfaces. A human starts it (Resume / strip → In-flight); once running it joins the unified lifecycle: a worker that deliberately hands off is relaunched fresh next tick (a long autonomous arc), a dirty death or idle exit parks it back to the strip, and a close-out lands in Awaiting review.
- **In flight**: a live tmux worker (any kind), or an armed oneshot (`status: active` — even when blocked by deps; it flies when the dep clears).
- **Awaiting review**: `status: closed`, `tempered` absent. Worker exited; Shuttle ignores it pending human verdict.
- **Tempered**: `status: closed`, `tempered: true`. Human-accepted (oneshot terminus).
- **Composted**: `status: closed`, `tempered: false`. Human-rejected (mooted, superseded). The block is preserved as historical record.

The drag-to-tempered gesture is **kind-aware**: on a standing role awaiting review it invokes `felt shuttle accept` (re-arms the role, `next_due` recomputed from cron); on a pinned role awaiting review it also invokes accept, which **re-parks it to the strip** (`status: open`, verdict cleared) — dragging the card back to the strip/drafts is the same accept; on a oneshot it sets `tempered: true` (terminus). Same gesture, kind-aware semantics — the classifier reads `shuttle.kind`.

## Lifecycle verbs

The daemon picks up any of these on its next poll:

```bash
felt shuttle install <fiber>                # fresh oneshot, armed (status: active)
felt shuttle install <fiber> --disabled     # land in drafts (status: open)
felt shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris
felt shuttle pin     <fiber>                # pinned, schedule-less perennial role
felt shuttle pause   <fiber>                # status: open; kills live worker unless --no-kill
felt shuttle resume  <fiber>                # status: active
felt shuttle accept  <fiber>                # standing roles only: accept pending run, re-arm
felt shuttle close   <fiber> [--tempered=…] # status: closed; verdict via --tempered
felt shuttle reopen  <fiber>                # requeue a closed/reviewed fiber into active work
felt shuttle set-agent <fiber> <agent-id>   # change shuttle.agent (axes: --effort, --chrome)
felt shuttle uninstall <fiber>              # archive from kanban — see below
```

Read-side checks:

```bash
felt shuttle status                         # one line per fiber with a block
felt shuttle ps                             # live tmux workers only
felt shuttle snapshot                       # daemon's view (:4000)
curl -s http://127.0.0.1:4000/api/v1/agents | jq    # agent registry over HTTP
```

## Card missing?

First check where the fiber was filed (a local repo `.felt/` that's not a pinned city is invisible to the global kanban), then confirm `felt shuttle status` shows the block. Most "card missing" symptoms reduce to "no block installed yet."

**Remote-host fibers reach the kanban over an SSH tunnel, NOT via loom git-sync.** This confusion recurs: a constitution authored on a remote host (e.g. cineca, where `~/loom` is a *different* checkout than the Mac's) does **not** need `git commit` + `git push` of loom to show up. The local daemon reads each remote host's *live* view over the tunnel (candide→:4001, cineca→:4002, amundsen→:4003; owner-routed reads), so a fresh `shuttle:` block on the remote surfaces directly. **Do not push loom just to make a remote card appear** — loom git-sync moves fiber content across machines; the SSH tunnel is the kanban's live view. If a remote card is missing, debug the tunnel / store registration, not the git state.

## When to uninstall — and when not to

The shuttle block is the dispatch contract: agent, kind, schedule, host. Closing a fiber doesn't remove it; the daemon ignores closed fibers via felt status and the block stays as historical record. **Closing and uninstalling are separate decisions.**

`felt shuttle uninstall` earns its keep in four cases:

1. **Mistake recovery** — wrong slug, immediate undo.
2. **Reshape the contract** — converting oneshot ↔ standing requires `uninstall` + `install`/`repeat`; both writers refuse to clobber an existing block.
3. **Archive from kanban** — a closed fiber's place is the tempered or composted column; uninstall makes it *leave the board entirely* (lesson captured elsewhere, kanban noise costs more than the record).
4. **Tool boundary** — a different dispatcher takes ownership. (Theoretical today.)

What uninstall is **not** for: closing your own session. A worker exiting sets `status: closed` and leaves the block alone.
