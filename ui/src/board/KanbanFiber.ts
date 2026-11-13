// Browser-safe fiber model for the kanban.
//
// The `Fiber` type and `mapFeltJsonToFiber`, which turn one entry of felt's
// `felt ls -j` JSON (the shape carried per-row by Shuttle's
// `/api/v1/fibers/composite` feed) into a typed object. The daemon owns
// collection; the board only parses the rows it serves, and this is the one
// fiber parser it depends on, so every row — local or remote — classifies the
// same way.

export interface Fiber {
  id: string;        // slug path under .felt/ — bare for top-level (`foo`) or
                     // slash-joined for nested (`foo/bar`). Matches what
                     // `felt ls --json` emits for nested fibers.
  uid?: string;      // intrinsic frontmatter ULID, emitted by felt as `uid`.
                     // Federation/runtime joins use this; felt addressing
                     // remains slug-shaped via `id`.
  name: string;      // frontmatter `name:`
  status: string;    // open, active, closed
  createdAt: string; // ISO date from frontmatter
  body?: string;     // markdown body after frontmatter
  outcome?: string;  // outcome from frontmatter
  theme?: string;    // bundled workspace theme from frontmatter
  closedAt?: string; // ISO date from frontmatter
  modifiedAt?: string; // file mtime felt reports as `modified_at`.
  due?: string;       // project-owned frontmatter `due:` for human-facing deadlines
  /**
   * Project-owned frontmatter `start:` — the opening edge of a CYCLE's span
   * (`due:` is its closing edge). A CIVIL DAY, and felt round-trips it exactly
   * as it does `due:`: authored `start: 2026-09-01`, it comes back
   * `2026-09-01T00:00:00Z` (verified against a real store). So it must be read
   * with `dueCivilDay`, never `new Date` — see civilDay.ts, where reading a
   * civil day as an instant loses a day in every negative-offset zone.
   */
  start?: string;
  horizon?: string;   // legacy project-owned planning field. New Kanban writes
                      // only persist `stashed`; `now`/`soon` are read for
                      // compatibility and normalized by KanbanRules.
  cold?: boolean;     // project-owned frontmatter `cold:` — when true, stash
                      // cluster renders dimmer and below warm clusters.
  tags?: string[];
  tempered?: boolean;   // human-acceptance signal — agent never sets this itself
  /** True when the fiber has a `shuttle:` frontmatter block. A fiber is
   * shuttle-managed iff it carries this block; `status` alone decides whether
   * it dispatches (the felt-native cutover — no `shuttle.enabled`). */
  hasShuttleBlock?: boolean;
  /** `shuttle.kind` — `oneshot` (default) or `standing`. */
  shuttleKind?: 'oneshot' | 'standing';
  /** `shuttle.role` — the office's slug, its charter's (`roles/<slug>`). */
  shuttleRole?: string;
  /** `shuttle.person` — who is responsible under the role. */
  shuttlePerson?: string;
  /** `shuttle.seat` — an office seat, drawn among the Roles when at rest. */
  shuttleSeat?: boolean;
  /** `shuttle.blocked_on` — what a resting constitution waits for: a fiber uid, or text. */
  shuttleBlockedOn?: string;
  /** `shuttle.runtime.session_uuid` — the harness session UUID of the worker the
   * daemon most recently launched for this fiber. Machine-managed, and the ONLY
   * value on the row that changes when a fresh dispatch replaces one session with
   * another: the tmux session name is keyed on the fiber's uid and is identical
   * across dispatches. Absent for a codex/pi worker until the scrape backfills it. */
  shuttleSessionUuid?: string;
  /** `shuttle.runtime.dispatched_at` — RFC3339 INSTANT the daemon stamped when
   * it launched the most recent worker. Machine-managed; read-only here. */
  shuttleDispatchedAt?: string;
  /** `shuttle.runtime.handed_off_at` — RFC3339 INSTANT the WORKER stamped on a
   * clean exit (`shuttle handoff`). Compare against `shuttleDispatchedAt`
   * to tell this run's handoff from a leftover stamp of the previous one: only
   * `handed_off_at >= dispatched_at` concluded the run in hand. */
  shuttleHandedOffAt?: string;
  /** Non-blocking question raised by the worker for the human. */
  shuttleAsk?: { text: string; at: string };
  /** A thread's mark for the human's review (`shuttle close --review`). */
  shuttleReview?: { note: string; at: string };
  /** `shuttle.agent` — the agent identifier to dispatch with (e.g. `claude-opus`). */
  shuttleAgent?: string;
  /** `shuttle.effort` — reasoning-effort axis (harness-native token, e.g.
   * `high`, `xhigh`, `max`). Absent resolves to the agent registry default. */
  shuttleEffort?: string;
  /** `shuttle.chrome` — declares the worker should run with `--chrome`. Only
   * surfaced when explicitly true. */
  shuttleChrome?: boolean;
  /** `shuttle.schedule` — cron expression + IANA timezone for standing constitutions. */
  shuttleSchedule?: { expr: string; tz: string };
  /** `shuttle.resolved.next_due` — Shuttle's next occurrence of the schedule, an instant. */
  shuttleNextDue?: string;
  /** `shuttle.resolved.schedule_text` — the schedule as a person says it, when it can be said. */
  shuttleScheduleText?: string;
  /** `shuttle.pulse` cadence and optional local-time window for a oneshot seat. */
  shuttlePulse?: { every: string; window?: { start: string; end: string; tz: string } };
  /** `shuttle.project_dir` — the worker's cwd on the owning host. Echoed back
   * on kind/schedule reshapes (uninstall + reinstall) so the block survives
   * the round trip. */
  shuttleProjectDir?: string;
  /** `shuttle.host` — the daemon that owns this fiber's dispatch. Drives strict
   * daemon affinity and owner-routed writes (`Shuttle.OriginRouter` on the
   * daemon). */
  shuttleHost?: string;
  parentId?: string | null; // parent fiber id (derived from slug path); null for top-level
  /** Canonical absolute path to the artifact or legacy report sibling, set
   * from a feed row's `report_path` when the owning daemon resolved it. */
  reportPath?: string;
  /** Path relative to the owning `.felt/` wire root, carried on a feed row so
   * owner-routed mutations can echo it back. */
  remotePath?: string;
  isRoot?: boolean;  // entry-point fiber: bare `.felt/<slug>.md`
}

/**
 * Map one entry from felt's JSON output onto the kanban Fiber interface.
 * Tool-owned namespaces (`shuttle:`, `tempered:`) arrive as
 * native JSON values (felt v1.0.4+) so we read them directly rather than
 * re-parsing YAML.
 *
 * `kind` and `priority` are not part of felt's serialized model — they're
 * UI-side conventions felt does not interpret. We default them so downstream
 * consumers see a uniform shape regardless of source.
 */
export function mapFeltJsonToFiber(item: unknown): Fiber | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const f = item as Record<string, unknown>;

  const wireId = typeof f.id === 'string' ? f.id : '';
  const slug = typeof f.slug === 'string' && f.slug ? f.slug : undefined;
  const id = slug ?? wireId;
  if (!id) return null;
  const uid = typeof f.uid === 'string' && f.uid
    ? f.uid
    : isUlid(wireId)
      ? wireId
      : undefined;

  const status = typeof f.status === 'string' ? f.status : '';
  const name = typeof f.name === 'string' && f.name ? f.name : id;
  const outcome = typeof f.outcome === 'string' ? f.outcome : undefined;
  const body = typeof f.body === 'string' ? f.body : undefined;
  const due = typeof f.due === 'string' && f.due.trim() ? f.due.trim() : undefined;
  // `start:` is not one of felt's native fields — it is opaque extra
  // frontmatter felt preserves and re-emits. It only reaches the browser when
  // the daemon's kanban projection asks for it; see the gap noted on
  // `Fiber.start`.
  const start = typeof f.start === 'string' && f.start.trim() ? f.start.trim() : undefined;
  const horizon = typeof f.horizon === 'string' && f.horizon.trim() ? f.horizon.trim() : undefined;
  const cold = typeof f.cold === 'boolean' ? f.cold : undefined;

  const createdAt = pickIsoString(f, 'created_at') ?? '';
  const closedAt = pickIsoString(f, 'closed_at');
  const modifiedAt = pickIsoString(f, 'modified_at');

  const tags = stringList(f.tags);
  const tempered = typeof f.tempered === 'boolean' ? f.tempered : undefined;

  // shuttle: arrives as a native JSON map post felt v1.0.4. Anything else
  // (string, array, missing) means no shuttle block.
  const shuttleRaw = f.shuttle;
  const hasShuttleBlock =
    !!shuttleRaw && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);

  let shuttleKind: 'oneshot' | 'standing' | undefined;
  let shuttleRole: string | undefined;
  let shuttlePerson: string | undefined;
  let shuttleSeat: boolean | undefined;
  let shuttleBlockedOn: string | undefined;
  let shuttleSessionUuid: string | undefined;
  let shuttleDispatchedAt: string | undefined;
  let shuttleHandedOffAt: string | undefined;
  let shuttleAsk: Fiber['shuttleAsk'];
  let shuttleReview: Fiber['shuttleReview'];
  let shuttleAgent: string | undefined;
  let shuttleEffort: string | undefined;
  let shuttleSchedule: { expr: string; tz: string } | undefined;
  let shuttleNextDue: string | undefined;
  let shuttleScheduleText: string | undefined;
  let shuttlePulse: Fiber['shuttlePulse'];
  let shuttleProjectDir: string | undefined;
  let shuttleChrome: boolean | undefined;
  let shuttleHost: string | undefined;

  if (hasShuttleBlock) {
    const s = shuttleRaw as Record<string, unknown>;
    if (s.ask && typeof s.ask === 'object' && !Array.isArray(s.ask)) {
      const ask = s.ask as Record<string, unknown>;
      if (typeof ask.text === 'string' && ask.text.trim() && typeof ask.at === 'string') {
        shuttleAsk = { text: ask.text, at: ask.at };
      }
    }
    if (s.review && typeof s.review === 'object' && !Array.isArray(s.review)) {
      const review = s.review as Record<string, unknown>;
      if (typeof review.note === 'string' && review.note.trim() && typeof review.at === 'string') {
        shuttleReview = { note: review.note.trim(), at: review.at };
      }
    }
    shuttleKind = s.kind === 'standing' ? 'standing' : 'oneshot';
    if (typeof s.host === 'string' && s.host.trim()) shuttleHost = s.host.trim();
    if (typeof s.role === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.role)) shuttleRole = s.role;
    if (shuttleRole && typeof s.person === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s.person)) shuttlePerson = s.person;
    if (typeof s.seat === 'boolean') shuttleSeat = s.seat;
    if (typeof s.blocked_on === 'string' && s.blocked_on.trim()) shuttleBlockedOn = s.blocked_on.trim();


    // shuttle.runtime — the machine-managed nested block (session_uuid,
    // dispatched_at, handed_off_at, run_id). Readers read ONLY the nested
    // form; nothing writes the retired flat keys. Two instants surface on the
    // board: they bound the session window the fiber page prints.
    const runtime = s.runtime;
    if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
      const r = runtime as Record<string, unknown>;
      shuttleDispatchedAt = pickIsoString(r, 'dispatched_at');
      shuttleHandedOffAt = pickIsoString(r, 'handed_off_at');
      const uuid = r.session_uuid;
      if (typeof uuid === 'string' && uuid.trim()) shuttleSessionUuid = uuid.trim();
    }

    if (typeof s.agent === 'string' && s.agent) shuttleAgent = s.agent;
    if (typeof s.effort === 'string' && s.effort.trim()) shuttleEffort = s.effort.trim();
    if (typeof s.project_dir === 'string' && s.project_dir.trim()) {
      shuttleProjectDir = s.project_dir.trim();
    }

    // shuttle.chrome — only surface `true`, collapsing everything else to
    // undefined so consumers can do a single existence check.
    if (s.chrome === true) shuttleChrome = true;

    // Shuttle resolves the schedule; the board never parses cron.
    const resolved = s.resolved;
    if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
      const r = resolved as Record<string, unknown>;
      shuttleNextDue = pickIsoString(r, 'next_due');
      if (typeof r.schedule_text === 'string' && r.schedule_text) shuttleScheduleText = r.schedule_text;
    }

    // shuttle.schedule = { expr, tz } for standing constitutions, its zone
    // under `tz` or `timezone`. Absent tz reads as UTC.
    const sched = s.schedule;
    if (sched && typeof sched === 'object' && !Array.isArray(sched)) {
      const m = sched as Record<string, unknown>;
      const expr = typeof m.expr === 'string' ? m.expr.trim() : '';
      const tzRaw = typeof m.tz === 'string'
        ? m.tz
        : typeof m.timezone === 'string'
          ? m.timezone
          : '';
      const tz = tzRaw.trim() || 'UTC';
      if (expr) shuttleSchedule = { expr, tz };
    }

    const pulse = s.pulse;
    if (typeof pulse === 'string' && pulse.trim()) {
      shuttlePulse = { every: pulse.trim() };
    } else if (pulse && typeof pulse === 'object' && !Array.isArray(pulse)) {
      const p = pulse as Record<string, unknown>;
      const every = typeof p.every === 'string' ? p.every.trim() : '';
      const rawWindow = p.window;
      if (every && rawWindow && typeof rawWindow === 'object' && !Array.isArray(rawWindow)) {
        const w = rawWindow as Record<string, unknown>;
        if (typeof w.start === 'string' && typeof w.end === 'string' && typeof w.tz === 'string') {
          shuttlePulse = { every, window: { start: w.start, end: w.end, tz: w.tz } };
        }
      } else if (every) shuttlePulse = { every };
    }
  }

  // entry_point (felt) → isRoot (this client's Fiber type). Felt only emits
  // this when true.
  const isRoot = !!f.entry_point;
  const parentId = isRoot
    ? null
    : id.includes('/')
      ? id.slice(0, id.lastIndexOf('/'))
      : null;

  return {
    id,
    uid,
    name,
    status,
    createdAt,
    closedAt,
    modifiedAt,
    outcome,
    body,
    theme: typeof f.theme === 'string' && f.theme.trim() ? f.theme.trim() : undefined,
    due,
    start,
    horizon,
    cold,
    tags,
    tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
    shuttleKind,
    shuttleRole,
    shuttlePerson,
    shuttleSeat,
    shuttleBlockedOn,
    shuttleSessionUuid,
    shuttleDispatchedAt,
    shuttleHandedOffAt,
    shuttleAsk,
    shuttleReview,
    shuttleAgent,
    shuttleEffort,
    shuttleSchedule,
    shuttleNextDue,
    shuttleScheduleText,
    shuttlePulse,
    shuttleProjectDir,
    shuttleChrome,
    shuttleHost,
    parentId,
    isRoot,
  };
}

function pickIsoString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  // 0001-01-01 is Go's zero-value time.Time when the field was absent in
  // source — treat as missing.
  if (typeof v === 'string' && v && !v.startsWith('0001-')) return v;
  return undefined;
}

function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out.length > 0 ? out : undefined;
}
