# Operating shuttle

Lifecycle verbs, kanban semantics, and the triage paths for "why isn't my card doing what I expect."

## Dispatch eligibility

The daemon dispatches a fiber when all of these hold:

1. The fiber lives in a felt store the daemon polls. Configured stores come from `FELT_STORES` → the persisted registry at `~/.config/felt/stores.json` (no implicit default); a cross-project store (the running example in these docs is `~/loom`; see the felt skill's cross-project reference) also exposes the project substores symlinked under its `.felt/`.
2. **The fiber carries a `shuttle:` block.** A fiber is shuttle-managed iff it has this block — installed via `felt shuttle install` (oneshot) or `felt shuttle repeat` (standing). The daemon reads the block directly; no tag predicate, no CLI spawn during the poll.
3. **Felt-native `status:` is `active`** — the sole dispatch gate (`eligible?/2` in `lib/shuttle/poller.ex`). `active` is armed, `open` is a draft, `closed` is a terminus / awaiting review.
4. Dependencies are satisfied: each `depends_on` target exists and has `tempered: true`.

Agent comes from `shuttle.agent`, resolved against felt's registry — the built-in set embedded into the CLI (`internal/shuttle/agents.builtin.json`) with the operator's `~/.config/felt/agents.json` layered on top; `felt shuttle agents` lists the effective registry, and the daemon consumes the resolved record off `felt show -j`. The bare fallback when a fiber carries no `shuttle.agent` is `claude-sonnet`; the recommended default for real work is `claude-opus` (see authoring.md, Agent selection).

**Tags never gate dispatch — or the view.** Three layers feed the system: the `shuttle:` block (`kind`, `schedule`, `agent`, `host`, `project_dir`) declares shuttle-management; universal lifecycle scalars (`status`, `tempered`, `depends_on`) drive dispatch and view; tags are free-form noticings read by neither the daemon nor the kanban classifier.

## What the board admits

Two kinds of row, and nothing else (`shouldIncludeInKanban` in `ui/src/board/KanbanReadModel.ts`): a fiber with a `shuttle:` block, and a **cycle** fiber. Everything the human means to do carries a block — a bare `due:` is a date the Desk cannot act on, so such a fiber is promoted, not shown. The daemon's feed is deliberately wider (one of its three admission walks is `--has-field due`, `lib/shuttle/fiber_documents.ex`); the board is where the narrowing happens. Cycles are the exception because they are not work: admitted on the tag alone, routed straight to the `cycles` surface, never in a Desk column.

## Board tabs

The board at `:4000` is five hotkey-switchable tabs — four windows over the same fibers and sessions, plus the Board, which is a different kind of surface. **Desk** is the kanban (below). **Day** lays fibers as lanes over a 6am→6am axis, with the rail zoomed to first-action→now rather than the full 24 hours. **Week** rows past days as ink rasters, today's row carries a gold seam, future rows are hollow. **Chronicle** draws fibers as multi-day lifelines across calendar days, under a strip of cycle bands.

**Board** (hotkey `5`; `shelf` internally — the id, the storage keys and the module names all say shelf, and `?view=shelf` deep-links it) is not a window over time at all. It is the fleet's sent work on a canvas: everything a worker pushed with `SendUserFile` in the last month (`/api/v1/sent-files/all/composite`), each file a card that renders its own contents. A card is two layers — the FACE (name, fiber, age, kind) is synchronous and is the card's resting state, never a skeleton; the BODY (iframe, image, page) mounts when the card nears the viewport and is evicted when the board carries more live bodies than it can afford (`shelfLoad`, 16 live with hysteretic cutback). CARDS ARE HANDLES, NEVER FACTORIES: every gesture rearranges the canvas, nothing on a card makes another card. Nothing overlaps except a pile, which is one fiber's work gathered by the fiber lens. Reading happens in the Reader — the ↗ sends a file to one overlay window with its own tab strip, because shuttle runs as a Safari dock web-app where every `window.open` would otherwise become a separate window.

**Two-state activity grammar.** Every raster spends exactly two pigments: solid for human steering, wash for agent work. There is no third "attention called" state — an idle nudge is not a state of the work, and an agent blocked on you reads as the **gap** on a live lane, which no pigment improves on. Effort is counted in the unit each side actually spends: human effort in messages sent and received (`you 14 · 9 back`), agent effort in minutes. Hover any mark for the actual words — transcript excerpts fetched from `/api/v1/moment`.

The temporal tabs read from the same substrate the daemon already tracks, not a separate store: activity from `events.jsonl`, session identity from the session ledger `sessions.jsonl`, and the prose ("what this fiber did today") from the commit ledger `commits.jsonl`, which a hook writes at commit time. **Everything on these pages is joined by those two ledgers**: a minute or a commit that does not resolve to a fiber the board carries is not drawn at all, so work started outside shuttle is invisible here — and nothing is ever attributed by reading a commit's `slug:` prefix or a working directory's name. **Cross-host:** the hub caches each remote's activity, sessions, commits, and spend, so one board shows the whole fleet's time; an origin that goes unreachable grays out and says "waiting on `<host>`" rather than silently drawing an empty day.

## Cycles and eras

A **cycle** is a fiber tagged `cycle` with `start:` and `due:` as civil days, and a body whose first paragraph is the *intention* — what this stretch of time is for. The Chronicle draws it as a named band over the day grid.

- **Make one** by dragging across days in the cycle strip and naming the span, or press `+` to *speak* an era: dictate the intention, which starts today and runs open-ended (a start with no end runs to the horizon; an end with no start is a single day).
- **Membership is always derived**, never a list: a fiber belongs to an era if it was worked during the span or is due inside it. Nothing to maintain, nothing to fall out of sync.
- **Click the band** for the era face — span, intention, derived figures, and "the look back", a memoir composed from the commit trail. **Inscribe this review** writes that memoir back into the cycle fiber. **Double-click the name** to rename; **drag an edge** to respan.

## Snooze

Dragging a card reveals the **drag horizon** — a slim row of upcoming days under the tab strip, plus a chip per upcoming cycle.

- **Onto a day**: a desk or resting card gets `due:` + `horizon: stashed` — it leaves the Now board for **Resting** and returns on its due day. A card that already lives elsewhere just gets the `due:`.
- **Onto a cycle chip**: due lands on that cycle's start day, clamped to tomorrow when the cycle is already running ("rest until tomorrow, later this cycle").
- **Onto today** puts it back on the desk (due cleared); **into Resting** stashes it dateless; **back up to the now-board** clears horizon and cold.

## Token spend

`GET /api/v1/spend?since_ms=…` folds transcript usage into per-session and per-fiber token rollups, joining the session ledger (which fiber a session belonged to) to the transcript record (what it cost). Neither join estimates: a session whose transcript this host cannot read is reported `found: false` with zeroed counters and still counts in its fiber's session tally. `/api/v1/spend/composite` merges every host's spend into one view.

## Kanban columns

Column membership derives from felt `status` + `tempered` + `shuttle.kind` + tmux liveness (`classifyFiber` in `ui/src/board/KanbanRules.ts` — the single source of truth):

- **Drafts**: `status: open` — a stash awaiting refinement, dispatching nothing until launched (`felt shuttle pause` lands a card here). A fiber with no block at all is not a draft; it is not on the board.
- **Scheduled**: an armed standing role between firings (`status: active`, no live worker) — it fires on its own cron, so it sits on the timeline at its next launch rather than in the Now lane.
- **Pinned**: a resting `kind: pinned` role — the strip of perennial interfaces. A human starts it (Resume / strip → In-flight); once running it joins the unified lifecycle: a worker that deliberately hands off is relaunched fresh next tick (a long autonomous arc), a dirty death or idle exit parks it back to the strip, and a close-out lands in Awaiting review.
- **In flight**: a live tmux worker (any kind), or an armed oneshot (`status: active` — even when blocked by deps; it flies when the dep clears).
- **Awaiting review**: `status: closed`, `tempered` absent. Worker exited; shuttle ignores it pending human verdict.
- **Tempered**: `status: closed`, `tempered: true`. Human-accepted (oneshot terminus).
- **Composted**: `status: closed`, `tempered: false`. Human-rejected (mooted, superseded). The block is preserved as historical record.

The drag-to-tempered gesture is **kind-aware**: on a standing role awaiting review it invokes `felt shuttle accept` (re-arms the role, `next_due` recomputed from cron); on a pinned role awaiting review it also invokes accept, which **re-parks it to the strip** (`status: open`, verdict cleared) — dragging the card back to the strip/drafts is the same accept; on a oneshot it sets `tempered: true` (terminus). Same gesture, kind-aware semantics — the classifier reads `shuttle.kind`.

## Gestures by card state

**Two interaction modes** route to different verbs even for the same card. **Drag-and-drop** is "advance the card's state" intent: drag-to-tempered = "I'm done, accept"; drag-to-drafts = "park it"; drag-to-inFlight on a dormant role = "fire it now." **Modal buttons** (Resume, New session) are "I'm NOT done — give me another worker on this same run": they preserve outcome and don't advance the cycle.

| Card state | Interaction | Verb fired | Effect |
|---|---|---|---|
| standing, **awaiting** (status:closed + untempered) | drag → tempered or inFlight | `felt shuttle accept` | Re-arms (`status: active`; next occurrence computed `cron.next(now)`). Outcome cleared. |
| standing, **awaiting** | modal **Resume** | `felt shuttle resume` + dispatch (resume_mode=previous) | Re-arms; continues the prior session with the user's directive (session id from `shuttle.runtime.session_uuid`). Outcome preserved. |
| standing, **awaiting** | modal **New session** | `felt shuttle resume` + dispatch (resume_mode=fresh) | Re-arms; brand-new session on the same fiber. Outcome preserved. |
| standing, **armed** (status:active) | drag → inFlight | `felt shuttle dispatch --ad-hoc` | Manual ad-hoc run, synthetic `adhoc-*` id; schedule untouched. |
| standing, **draft** (status:open) | drag → inFlight | `felt shuttle reopen` | Arms it; daemon picks up the schedule next poll. |
| any, **running worker** | (any) | dispatch returns `already_running` | Card promotes to inFlight; attach via tmux. |
| any | drag → drafts | `felt shuttle pause` | `status: open` + kills the live worker. Schedule preserved. |
| oneshot, **awaiting** | drag → tempered / composted | `felt shuttle close --tempered=true/false` | Terminus / discarded. |

**Outcome-clearing rule.** Only `felt shuttle accept` clears the outcome — the cycle-advance verb, and a fresh outcome is the right precondition for the next run. Resume and New session preserve it because the run is *not* finalized.

**Ghost workers.** If `state.running` shows a fiber with no live tmux session, eligibility blocks re-dispatch; `felt shuttle dispatch <fiber>` triggers a `reconcile_running_fiber` pass that clears stale entries. And **daemon restarts never end worker sessions** — tmux owns the worker process, the daemon only watches it; bouncing the daemon cycles the watcher and re-adopts live sessions on boot.

## Lifecycle verbs

The daemon picks up any of these on its next poll:

```bash
felt shuttle install <fiber>                # fresh oneshot, armed (status: active)
felt shuttle install <fiber> --disabled     # land in drafts (status: open)
felt shuttle repeat  <fiber> --schedule "0 9 * * 1-5" --tz Europe/Paris
felt shuttle pin     <fiber>                # pinned, schedule-less perennial role
felt shuttle reshape <fiber> [kind]         # change kind/schedule on an existing block, in place
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
felt shuttle status <fiber>                 # detailed report on one block + dispatch assessment
felt shuttle ps                             # live tmux workers only
felt shuttle snapshot                       # daemon's view (:4000)
curl -s http://127.0.0.1:4000/api/v1/agents | jq    # agent registry over HTTP
```

## Claiming a fiber into your session

An interactive session can become a fiber's worker — first-class, via `POST /api/v1/claim`. The daemon registers the claiming tmux session exactly as if it had dispatched it: liveness watcher, kanban in-flight, and normal exit semantics (`felt shuttle handoff` → clean-exit stamp → fresh dispatch while `active`, or Awaiting review when `closed`). This is how capture sessions adopt the fiber they just authored, and it generalizes to any fiber a human wants to drive from a session shuttle didn't spawn: a draft they want to start on now, an Awaiting-review card being reopened interactively, or a running worker whose cache has gone cold and isn't worth reheating just to continue.

```bash
# 1. only if a worker is live: kill it and park safely (no dispatch gap)
felt shuttle pause <fiber>

# 2. claim — from inside the claiming session (requires tmux; renames the
#    session to the canonical <leaf>-<uid>-shuttle worker name — expected)
curl -s -X POST http://localhost:4000/api/v1/claim -H 'Content-Type: application/json' \
  -d '{"fiber_id": "<fiber>", "tmux_session": "'"$(tmux display-message -p '#S')"'",
       "session_uuid": "<your transcript uuid>", "agent": "<registry id>"}'

# 3. arm — AFTER the claim, never before
felt edit <fiber> --status active
```

The order is load-bearing: activating before the claim makes the fiber dispatch-eligible while the daemon can't yet see your session, and the poll loop spawns a duplicate worker in the gap. `session_uuid` is optional but wire it when you can — it writes the dispatch marker, so Resume-previous and transcript lineage work on claimed sessions too. The claim is idempotent; if the response is lost, retry with the same body. Errors are precise: `already_running` means kill/pause the live worker first, `closed` means `felt shuttle reopen` first, `session_not_found` means the tmux session name didn't resolve.

From the claim on, you are the worker: the whole worker loop in SKILL.md applies, including handoff-then-exit. Killing a live worker to claim loses whatever was typed in its input buffer — capture anything visible in the pane first (`tmux capture-pane`); the transcript itself survives and stays resumable.

## Card missing?

First check where the fiber was filed (a local repo `.felt/` that's not a pinned city is invisible to the global kanban), then confirm `felt shuttle status` shows the block. Most "card missing" symptoms reduce to "no block installed yet."

**Remote-host fibers reach the kanban over an SSH tunnel, NOT via store git-sync.** This confusion recurs: a constitution authored on a remote host — where the cross-project store (e.g. `~/loom`) is a *different* checkout than the local one — does **not** need `git commit` + `git push` of the store to show up. The fleet lives in `~/.config/felt/remotes.json`; each entry names a host, its SSH target, and the local port its tunnel binds. Run `felt shuttle remotes list` to see the effective map (`felt shuttle remotes add|rm` edits it, `felt shuttle remotes path` prints the file). The local daemon reads each remote's *live* view over that tunnel with owner-routed reads, so a fresh `shuttle:` block on the remote surfaces directly. **Do not push the store just to make a remote card appear** — store git-sync moves fiber content across machines; the SSH tunnel is the kanban's live view. If a remote card is missing, debug the tunnel / store registration, not the git state.

## When to uninstall — and when not to

The shuttle block is the dispatch contract: agent, kind, schedule, host. Closing a fiber doesn't remove it; the daemon ignores closed fibers via felt status and the block stays as historical record. **Closing and uninstalling are separate decisions.**

`felt shuttle uninstall` earns its keep in four cases:

1. **Mistake recovery** — wrong slug, immediate undo.
2. **Full rebuild** — converting oneshot ↔ standing is normally `felt shuttle reshape`; reach for `uninstall` + `install`/`repeat` only when you actually want project_dir/host re-resolved and status re-settled from scratch.
3. **Archive from kanban** — a closed fiber's place is the tempered or composted column; uninstall makes it *leave the board entirely* (lesson captured elsewhere, kanban noise costs more than the record).
4. **Tool boundary** — a different dispatcher takes ownership. (Theoretical today.)

What uninstall is **not** for: closing your own session. A worker exiting sets `status: closed` and leaves the block alone.
