/** Column identifier within the Now surface — also doubles as the API target. */
export type ColumnKind = 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted' | 'pinned'
export type HorizonKind = 'now' | 'stashed'

/** The three shapes a shuttle block can take — the values `shuttle
 *  reshape` accepts and the daemon's lifecycle controller allows. */
export type ShuttleKind = 'oneshot' | 'standing' | 'pinned'

/** A `shuttle.project_dir` read off an ancestor fiber: the directory and the
 *  ancestor it came from. */
export interface InheritedProjectDir {
  path: string
  from: string
}

export interface KanbanCard {
  id: string
  /** Intrinsic frontmatter ULID when present. */
  uid?: string
  name: string
  path: string
  /**
   * Origin that contributed this fiber — the composite row's `origin`: the
   * serving daemon's own host id, or the name of the remote it came from.
   * Routes owner-addressed writes and drives the "waiting on `<hostname>`"
   * stale badge and the drag-disable when that origin is disconnected.
   */
  originId: string
  /**
   * The owning host's felt store path (the feed row's `felt_store`, e.g.
   * `/home/user/store` for a remote-host card). Threaded into owner-routed
   * fiber reads so the detail view reads the OWNER's copy, not the
   * git-synced local one.
   */
  feltStore?: string
  /**
   * Absolute path to the fiber's own directory on the owning host
   * (`dirname(felt.path)`). The base the detail panel resolves a relative
   * `:::{embed}` / markdown image against before handing it to the `/file`
   * route. Absent for remote-origin fibers served by an older daemon and for
   * fibers felt carries no path for; the panel then falls back to a placeholder.
   */
  fiberDir?: string
  status: string
  outcome?: string
  due?: string
  tags?: string[]
  createdAt: string
  closedAt?: string
  /** File mtime the owning daemon reports (`modified_at`). Tracks last activity
   * — a launch/accept/edit rewrites the frontmatter — so it orders the Pinned
   * strip by most-recently-used. */
  modifiedAt?: string
  tempered?: boolean
  dependsOn?: string[]
  /** How `depends_on:` was written — `scalar` (one bare id) or `list`. The
   *  drag gestures author and clear scalars only. */
  dependsOnShape?: 'scalar' | 'list'
  /** Dep ids nothing in the feed answers to. They hold nothing back; the card
   *  wears a warning badge so a chain that silently is not one is visible. */
  dependsOnUnresolved?: string[]
  /**
   * The card this one is FOLDED UNDER — the head of its chain, wherever that
   * head is drawn (a desk column, the pinned strip, Resting). Set only on the
   * cards in `KanbanResponse.folded`, which no surface draws directly: they are
   * reached through the head's "+N queued" chip. Derived fresh on every poll
   * (`foldHeadId`), never stored — clear the edge and the card is simply drawn
   * in its own column again.
   */
  foldedUnder?: string
  /**
   * The owning daemon's worker for this fiber: `running`, or `blocked` (an app
   * launch or conversation that failed and waits on a human, explained by
   * `launchError`). Absent when the daemon holds no worker for the fiber. This
   * is the card's liveness — ask it through `hasLiveWorker`, never through
   * `tmuxSession`, which only CLI workers have.
   */
  workerState?: 'running' | 'blocked'
  /**
   * The live CLI worker's tmux session name — the terminal handle that attach,
   * open-in-terminal and the join to session ledgers key on. Absent for an app
   * worker, which is reached through `desktopLink` / `sessionUuid` instead.
   */
  tmuxSession?: string
  /**
   * What the live worker is doing, for the chips and the In-flight sort:
   * `working` (busy mid-tool — sinks to the bottom, no chip), `waiting`
   * (paused at a stop — "waiting for you" once idle ≥60s), `attention` (raised
   * its hand — "needs you", sorts top), or `blocked` (the worker is
   * `workerState: 'blocked'` — sorts top with `launchError`). Absent when there
   * is no worker, or before a live worker's first activity event.
   */
  runtimePhase?: string
  /** Durable explanation for a blocked app launch. */
  launchError?: string
  /**
   * Real ms timestamp of the live worker's most-recent hook event (any type).
   * Present only for a live worker (paired with `workerState`);
   * drives the In-flight idle-descending sort (`now - lastActivityAt`, longest-
   * stopped first) and the 60s waiting-chip gate. Absent for worker-less cards.
   */
  lastActivityAt?: number
  /**
   * True when the owning daemon is holding this fiber under boot quarantine — a
   * genuinely-fresh launch parked in `pending_launch`, awaiting
   * `shuttle daemon release`. Distinct from `workerState` (a live worker) and from
   * an idle-active card: it reads as "held, awaiting release", not "running" or
   * "idle between workers". Served per-fiber by the owning host.
   */
  held?: boolean
  /** Ms timestamp the boot-quarantine hold began (`parked_at`), for a tooltip. */
  heldSince?: number
  /**
   * `shuttle.runtime.dispatched_at` — the INSTANT the owning daemon launched
   * the most recent worker. Rides the composite feed inside felt's `shuttle`
   * map (felt serializes the whole block), so no daemon change was needed to
   * surface it. Opens the detail panel's session-window line.
   */
  dispatchedAt?: string
  /**
   * `shuttle.runtime.handed_off_at` — the INSTANT the worker stamped on a clean
   * exit. A stamp OLDER than `dispatchedAt` belongs to the previous run, not
   * this one; the session-window line treats that as "no clean handoff" rather
   * than computing a negative span.
   */
  handedOffAt?: string
  /**
   * Where a phone opens the live worker: the claude.ai bridge URL its session
   * wrote into its own transcript, stamped by the owning daemon on the feed
   * row's `runtime` (see `Shuttle.SessionLink`). Present only for a live CLI
   * worker (`tmuxSession`), and only for a session that was bridged.
   */
  sessionLink?: string
  /** Native desktop app route; never treated as a phone universal link. */
  desktopLink?: string
  /**
   * `shuttle.runtime.session_uuid` — the harness session the daemon most
   * recently launched for this fiber, and the key that says WHICH session
   * `sessionLink` points at. The tmux session name (`tmuxSession`) is keyed
   * on the fiber's uid and so is byte-for-byte identical across dispatches;
   * this is not. Absent for a codex/pi worker until the scrape backfills it.
   */
  sessionUuid?: string
  /**
   * `shuttle.agent` — the agent to dispatch with. Present when the fiber
   * has a shuttle block and the block specifies an agent.
   */
  shuttleAgent?: string
  /**
   * `shuttle.effort` — reasoning-effort axis (a harness-native token, e.g.
   * `high`, `xhigh`, `max`). Absent resolves to the agent registry's concrete
   * default. Drives the effort select in the fiber-detail agent picker.
   */
  shuttleEffort?: string
  /**
   * `shuttle.chrome` — browser-automation axis (claude harness only). Present
   * (true) when the block enables `--chrome`; drives the chrome toggle in the
   * fiber-detail agent picker.
   */
  shuttleChrome?: boolean

  /** `shuttle.surface` — app for a ChatGPT-backed Codex run; absent and cli
   * both retain the established terminal execution. */
  shuttleSurface?: 'cli' | 'app'
  /** Observed worker identity, independent of next-launch configuration. */
  workerSurface?: 'cli' | 'app'
  workerAgent?: string
  /**
   * `shuttle.host` — the daemon that owns this fiber's dispatch (e.g.
   * `cluster-a`, `my-laptop`). Routes a force-dispatch to the owning daemon and
   * tells the human where a worker will run.
   */
  shuttleHost?: string
  /**
   * `shuttle.kind` — `oneshot` (default), `standing`, or `pinned`. Present
   * iff the fiber has a shuttle block. Drives the kind segmented control in
   * the fiber-detail modal and reveals the schedule/tz row when standing. A
   * resting (`status:active`, not running) pinned fiber classifies onto the
   * Pinned strip; a running one shows live in Now via the worker override.
   */
  shuttleKind?: ShuttleKind
  /**
   * `shuttle.schedule.expr` — 5-field cron expression for standing roles.
   * Absent on one-shot fibers and on fibers without a shuttle block.
   */
  shuttleSchedule?: string
  /**
   * `shuttle.schedule.tz` — IANA timezone name paired with `shuttleSchedule`.
   * Absent when `shuttleSchedule` is absent.
   */
  shuttleTz?: string
  /**
   * `shuttle.project_dir` — the worker's cwd on the owning host. Echoed back
   * on kind/schedule reshapes (uninstall + reinstall via `:4000/lifecycle`)
   * so the block survives the round trip; falls back to the owning city's
   * project path when absent.
   */
  shuttleProjectDir?: string
  /**
   * The nearest ancestor's `shuttle.project_dir` on this card's owning host,
   * for a card whose block names none. A suggestion only: the board offers it
   * when a start is refused for want of a directory, and a human confirms it.
   */
  inheritedProjectDir?: InheritedProjectDir
  /**
   * ISO timestamp of the next cron occurrence, server-computed from
   * `shuttleSchedule` + `shuttleTz`. Present only for armed standing roles
   * (kind=standing, `status: active`, not awaiting); absent in every other
   * case.
   *
   * The backend routing layer uses this to lift dormant standing roles
   * onto the timeline surface. The strip placement reads
   * `card.nextLaunchAt ?? card.due` for day-column lookup. A standing
   * role is a commitment with a date, not a draft.
   */
  nextLaunchAt?: string
  /** Raw legacy top-level `horizon:` value from fiber frontmatter, if present. */
  storedHorizon?: HorizonKind
  /** Planning surface derived from due date plus legacy stash storage. */
  effectiveHorizon: HorizonKind
  /** True when imminent `due:` promotes legacy deferred storage into Now. */
  drifted: boolean
  /** Top-level `cold:` flag; held-open cluster marker on stashed cards. */
  cold?: boolean
  /**
   * Other hosts that also serve this fiber (a git-synced store mirrored across
   * daemons). The board renders ONE card — the locally-owned or freshest row,
   * per `dedupeMirroredRows` — and names the rest here, so a mirrored fiber
   * reads as one thing living in several places rather than as duplicate work.
   * Absent for the ordinary single-origin fiber.
   */
  mirroredOrigins?: string[]
  /**
   * True when the fiber carries the `cycle` tag — a named span of time drawn as
   * a band by the temporal views, not a piece of work. A cycle card appears
   * ONLY in `KanbanResponse.cycles`; `classifyFiber` keeps it out of every
   * lifecycle column, so no desk surface and no column count ever sees one.
   */
  isCycle: boolean
  /**
   * The cycle's opening edge as a BARE CIVIL DAY (`YYYY-MM-DD`), already
   * normalized from frontmatter `start:` — do NOT re-parse it with `new Date`,
   * which reads a civil day as UTC midnight and labels it a day early west of
   * Greenwich (see civilDay.ts). Null on a non-cycle card, and on a cycle whose
   * `start:` is absent or unreadable — `cycleSpan` in KanbanRules resolves that
   * case (and the open-ended one) into two concrete days for drawing.
   *
   * The closing edge is plain `due`, which is already on this card.
   */
  cycleStart: string | null
}

/**
 * Whether the owning daemon holds a worker for this card — a running one of
 * either surface, or a blocked app launch awaiting a human. A card with one is
 * in flight whatever its document says between workers.
 */
export function hasLiveWorker(card: Pick<KanbanCard, 'workerState'>): boolean {
  return card.workerState !== undefined
}

/**
 * Whether lifecycle mutations must ask the owning daemon to stop a worker:
 * any live worker, and also an app card with a durable thread id — a Codex
 * app conversation outlives its turn and still represents owned work, so this
 * is wider than `hasLiveWorker`.
 */
export function hasWorkerToStop(
  card: Pick<KanbanCard, 'workerState' | 'shuttleSurface' | 'workerSurface' | 'sessionUuid'>,
): boolean {
  return hasLiveWorker(card) ||
    ((card.workerSurface ?? card.shuttleSurface) === 'app' && typeof card.sessionUuid === 'string' && card.sessionUuid.length > 0)
}

/**
 * Per-origin freshness signal returned in `/kanban` responses. Stage 3b
 * surfaces this on the cards: stale-origin cards show a "waiting on
 * `<hostname>`" badge and refuse drag, since the remote agent or document
 * feed is unavailable and any mutation would have nowhere reliable to land.
 *
 * Local origin is always 'fresh'. Remote origins are:
 *   • 'fresh'   — agent connected, last fetch landed promptly.
 *   • 'stale'   — agent disconnected or the document fetch failed; cards may
 *     be last-known-good until the feed recovers.
 */
export interface KanbanOriginStaleness {
  status: 'fresh' | 'stale'
  /** Hostname for human-readable badging (e.g. "waiting on cluster-a"). */
  hostname?: string
  /** ISO timestamp; only set when status === 'stale'. */
  staleSince?: string
}

export interface KanbanResponse {
  feltHost: string
  /** Now surface — the desk (3 columns). */
  now: {
    drafts: KanbanCard[]
    inFlight: KanbanCard[]
    awaitingReview: KanbanCard[]
  }
  /** Timeline surface — closed work in `past`, and every armed standing role
   *  between runs in `futureDated`, ordered by next launch. One list: how far
   *  off a role's next firing is changes nothing about how it is drawn. */
  timeline: {
    past: KanbanCard[]
    futureDated: KanbanCard[]
  }
  /** Stash surface — dateless deferred work; frontend clusters by containment path. */
  stash: KanbanCard[]
  /** Pinned strip — at-rest (`status:active`, not running) `kind:pinned`
   * umbrella roles. Dispatchable on demand; the poller never auto-fires them.
   * A *running* pinned role shows live in `now.inFlight` instead. */
  pinned: KanbanCard[]
  /**
   * Cards FOLDED under the head of their chain — queued behind a card that is
   * drawn somewhere on this board, so they are drawn there and not in a column
   * of their own. No surface iterates this list; it exists so a folded card is
   * still RESOLVABLE (`findCardById`, the peek list's rows, every drag that
   * starts from one) rather than vanishing from the response entirely.
   *
   * A card with a live worker or `status: active` is never here — work that is
   * happening must be seen — and neither is one whose head the board is not
   * drawing at all.
   */
  folded: KanbanCard[]
  /**
   * Cycles — `cycle`-tagged fibers, each a named span of time. Read ONLY by the
   * temporal views, which draw them as bands behind the work; the Desk never
   * renders this surface and `totals` deliberately omits it, so a cycle can
   * never inflate a column count or land in a Resting cluster.
   *
   * Use `cycleSpan` (KanbanRules) to turn a card into two civil days rather
   * than reading `cycleStart`/`due` directly — it owns the single-day and
   * open-ended cases.
   */
  cycles: KanbanCard[]
  totals: {
    drafts: number
    inFlight: number
    awaitingReview: number
    past: number
    futureDated: number
    stash: number
    pinned: number
  }
  /**
   * Per-origin freshness, keyed by `originId`. Always includes `local`
   * and an entry for every remote origin with a snapshot in the store.
   * The frontend reads this to render the "waiting on `<hostname>`"
   * stale badge and to disable drag for stale-origin cards.
   */
  staleness: Record<string, KanbanOriginStaleness>
  generatedAt: number
}
