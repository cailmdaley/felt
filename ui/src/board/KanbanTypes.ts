/** Column identifier within the Now surface — also doubles as the API target. */
export type ColumnKind = 'drafts' | 'inFlight' | 'awaitingReview' | 'tempered' | 'composted' | 'pinned'
export type HorizonKind = 'now' | 'soon' | 'stashed'

export interface KanbanCard {
  id: string
  /** Intrinsic frontmatter ULID when present. */
  uid?: string
  name: string
  path: string
  /**
   * Origin that contributed this fiber — `local` for filesystem-walk sources,
   * `remote-<hostname>` for fibers sourced from an agent's fiber-tree
   * snapshot. Drives the "waiting on `<hostname>`" stale badge and the
   * drag-disable when the originating agent is disconnected (Stage 3b).
   */
  originId: string
  /**
   * The owning host's felt store path (the feed row's `felt_store`, e.g.
   * `/home/cdaley/loom` for a candide card). Threaded into owner-routed
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
  dependsOnSatisfied: boolean
  /** When set, a Shuttle worker is currently running for this fiber. */
  runningWorker?: string
  /**
   * The owning daemon's phase at request time. Two disjoint vocabularies share
   * this field, discriminated by `runningWorker` presence:
   *   • LIVE-worker activity category (when `runningWorker` is set):
   *     `working` (busy mid-tool — sinks to the bottom, no chip), `waiting`
   *     (paused at a stop — "waiting for you" once idle ≥60s), `attention`
   *     (raised its hand via the Notification hook — "needs you now", sorts
   *     top). Computed at serve time from the activity tracker's last hook
   *     event for the session.
   *   • Worker-LESS lifecycle phase (when `runningWorker` is absent):
   *     `running` (rare unmatched), `retrying` (failed dispatch in backoff),
   *     `due` (standing role past its tick), `dispatched`, plus the
   *     column-driving `scheduled`/`awaiting`/`accepted`/`dormant`. Stamped by
   *     the dispatch state machine, NOT the activity tracker.
   * `KanbanSurfaces` renders a phase chip from this so the In-flight card
   * explains itself instead of reading as an anomaly. Undefined when the daemon
   * reports no runtime for the fiber.
   */
  runtimePhase?: string
  /**
   * Real ms timestamp of the live worker's most-recent hook event (any type).
   * Present only for a tracked running worker (paired with `runningWorker`);
   * drives the In-flight idle-descending sort (`now - lastActivityAt`, longest-
   * stopped first) and the 60s waiting-chip gate. Absent for worker-less cards.
   */
  lastActivityAt?: number
  /**
   * True when the owning daemon is holding this fiber under boot quarantine — a
   * genuinely-fresh launch parked in `pending_launch`, awaiting
   * `bin/shuttle release`. Distinct from `runningWorker` (a live worker) and from
   * an idle-active card: it reads as "held, awaiting release", not "running" or
   * "idle between workers". Served per-fiber by the owning host.
   */
  held?: boolean
  /** Ms timestamp the boot-quarantine hold began (`parked_at`), for a tooltip. */
  heldSince?: number
  /**
   * Pinned local city whose `.felt/` physically owns this fiber, when the
   * server can resolve it (loom-deduped to the deepest project root).
   * Pairs with `projectSlug` to drive the click-to-open flow: the frontend
   * pivots vellum to this city and navigates to `projectSlug` instead of
   * the loom-relative `id`. Undefined for remote-origin fibers and for
   * paths that don't fall under any pinned city.
   */
  cityId?: string
  /**
   * Slug relative to the owning city's `.felt/` root. The vellum collection's
   * fiber graph is keyed by these project-relative slugs, so this is what
   * the frontend hands to `navigate()` once it's pivoted to `cityId`.
   */
  projectSlug?: string
  /**
   * Fiber id in Shuttle's canonical felt store. City-scoped kanban cards may
   * use project-relative ids for navigation; dispatch must use this id.
   */
  shuttleFiberId?: string
  /**
   * Session UUID of the most recently dispatched worker, IFF the fiber's
   * frontmatter still carries `shuttle.session.id`. Effectively always absent
   * now: shuttle retired that frontmatter write (slice 6) — felt history is the
   * session id's only durable home, resolved by the daemon at dispatch time.
   * Display-only hint data; must NOT gate Resume (which always tries). Kept
   * because a stray legacy frontmatter id still enriches the sent-files query.
   */
  sessionId?: string
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
  /**
   * `shuttle.host` — the daemon that owns this fiber's dispatch (e.g.
   * `cineca`, `dapmcw68`). Routes a force-dispatch to the owning daemon and
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
  shuttleKind?: 'oneshot' | 'standing' | 'pinned'
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
}

/**
 * Per-origin freshness signal returned in `/kanban` responses. Stage 3b
 * surfaces this on the cards: stale-origin cards show a "waiting on
 * `<hostname>`" badge and refuse drag, since the remote agent or document
 * feed is unavailable and any mutation would have nowhere reliable to land.
 *
 * Local origin is always 'fresh'. Remote origins are:
 *   • 'fresh'   — agent connected, last fetch landed promptly.
 *   • 'loading' — agent connected but this build's fetch crossed the soft
 *     deadline and may still land. Reachable, just behind.
 *   • 'stale'   — agent disconnected or the document fetch failed; cards may
 *     be last-known-good until the feed recovers.
 */
export interface KanbanOriginStaleness {
  status: 'fresh' | 'loading' | 'stale'
  /** Hostname for human-readable badging (e.g. "waiting on cineca"). */
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
  /** Timeline surface — past and future-dated, with a legacy standing-role pool. */
  timeline: {
    past: KanbanCard[]
    futureDated: KanbanCard[]
    anytimeSoon: KanbanCard[]
  }
  /** Stash surface — dateless deferred work; frontend clusters by containment path. */
  stash: KanbanCard[]
  /** Pinned strip — at-rest (`status:active`, not running) `kind:pinned`
   * umbrella roles. Dispatchable on demand; the poller never auto-fires them.
   * A *running* pinned role shows live in `now.inFlight` instead. */
  pinned: KanbanCard[]
  totals: {
    drafts: number
    inFlight: number
    awaitingReview: number
    past: number
    futureDated: number
    anytimeSoon: number
    stash: number
    pinned: number
  }
  /** Historical: total tempered count. Equals
   *  `timeline.past.filter(c => c.tempered === true).length`. */
  temperedTotal: number
  /** Server-owned timeline day window; keeps the strip in sync with backend routing. */
  timelineWindow: {
    pastDays: number
    futureDays: number
  }
  /**
   * Per-origin freshness, keyed by `originId`. Always includes `local`
   * and an entry for every remote origin with a snapshot in the store.
   * The frontend reads this to render the "waiting on `<hostname>`"
   * stale badge and to disable drag for stale-origin cards.
   */
  staleness: Record<string, KanbanOriginStaleness>
  shuttleDiagnostics?: {
    remoteSnapshots: RemoteShuttleSnapshotDiagnostic[]
  }
  remoteScope?: {
    originId: string
    hostname: string
  }
  tagIndex?: string[]
  generatedAt: number
}

export interface RemoteShuttleSnapshotDiagnostic {
  originId: string
  receivedAt: string
  eligibleCount: number | null
  blockedCount: number | null
  orphanCount: number | null
}
