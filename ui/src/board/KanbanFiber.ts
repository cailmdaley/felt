// Browser-safe fiber model for the kanban frontend.
//
// This is the frontend twin of the pure half of `server/src/FiberReader.ts`:
// the `Fiber` type and `mapFeltJsonToFiber`, which turn one entry of felt's
// `felt ls -j` JSON (the shape carried per-row by Shuttle's
// `/api/v1/fibers/composite` feed) into a typed object. The node-only
// collection half of FiberReader (`getAllFibers`, `felt` shell-outs) does NOT
// belong here — the daemon now owns collection and the frontend only parses
// the rows it serves.
//
// Kept deliberately faithful to the backend parser so cross-host rows classify
// identically whoever reads them. Once the kanban reads Shuttle directly, this
// is the sole fiber-parsing path the board depends on.

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
  dependsOn?: string[]; // fiber IDs this depends on
  /**
   * How `depends_on:` was WRITTEN, not what it means — `scalar` for the bare
   * `depends_on: some-fiber` the drag-to-stack gesture writes, `list` for any
   * sequence form (`[a, b]`, `- {id: a}`, …).
   *
   * The gesture is a one-dep affordance: it can author and it can clear a
   * scalar it (or a human) wrote, but it must never rewrite a LIST. A fan-in
   * someone assembled by hand carries intent no drag can reconstruct, so the
   * gesture declines it out loud instead of quietly collapsing it to one edge.
   */
  dependsOnShape?: 'scalar' | 'list';
  tempered?: boolean;   // human-acceptance signal — agent never sets this itself
  /** True when the fiber has a `shuttle:` frontmatter block. A fiber is
   * shuttle-managed iff it carries this block; `status` alone decides whether
   * it dispatches (the felt-native cutover — no `shuttle.enabled`). */
  hasShuttleBlock?: boolean;
  /** `shuttle.kind` — `oneshot` (default), `standing`, or `pinned` (a
   * schedule-less umbrella role the poller never auto-dispatches; only the
   * explicit force-dispatch verb launches it). */
  shuttleKind?: 'oneshot' | 'standing' | 'pinned';
  /** `shuttle.session.id` — the most recently dispatched worker's session UUID
   * when frontmatter still carries one. Display-only hint data. */
  shuttleSessionId?: string;
  /** `shuttle.runtime.dispatched_at` — RFC3339 INSTANT the daemon stamped when
   * it launched the most recent worker. Machine-managed; read-only here. */
  shuttleDispatchedAt?: string;
  /** `shuttle.runtime.handed_off_at` — RFC3339 INSTANT the WORKER stamped on a
   * clean exit (`felt shuttle handoff`). Compare against `shuttleDispatchedAt`
   * to tell this run's handoff from a leftover stamp of the previous one: only
   * `handed_off_at >= dispatched_at` concluded the run in hand. */
  shuttleHandedOffAt?: string;
  /** `shuttle.runtime.session_uuid` — the harness transcript UUID of the most
   * recent worker. With `shuttleHost` it names the transcript the daemon reads
   * for `/api/v1/session-link`, the phone's way of opening the session. */
  shuttleSessionUuid?: string;
  /** `shuttle.agent` — the agent identifier to dispatch with (e.g. `claude-opus`). */
  shuttleAgent?: string;
  /** `shuttle.effort` — reasoning-effort axis (harness-native token, e.g.
   * `high`, `xhigh`, `max`). Absent resolves to the agent registry default. */
  shuttleEffort?: string;
  /** `shuttle.chrome` — declares the worker should run with `--chrome`. Only
   * surfaced when explicitly true. */
  shuttleChrome?: boolean;
  /** `shuttle.schedule` — cron expression + IANA timezone for standing roles. */
  shuttleSchedule?: { expr: string; tz: string };
  /** `shuttle.project_dir` — the worker's cwd on the owning host. Echoed back
   * on kind/schedule reshapes (uninstall + reinstall) so the block survives
   * the round trip. */
  shuttleProjectDir?: string;
  /** `shuttle.host` — the daemon that owns this fiber's dispatch. Drives strict
   * daemon affinity and owner-routed writes (`Shuttle.OriginRouter` on the
   * daemon). */
  shuttleHost?: string;
  parentId?: string | null; // parent fiber id (derived from slug path); null for top-level
  /** Canonical absolute path to a sibling `report.html`, set from a feed row's
   * `report_path` when the owning daemon resolved it. */
  reportPath?: string;
  /** Path relative to the owning `.felt/` wire root, carried on a feed row so
   * owner-routed mutations can echo it back. */
  remotePath?: string;
  /** Owner-served tmux session name, set when the owning daemon reports a live
   * worker for this fiber (the feed row's `runtime.tmux_session`). This is how
   * a card resolves `runningWorker` → `▸ aloft` from one reconciled observer. */
  remoteRunningSession?: string;
  isRoot?: boolean;  // entry-point fiber: bare `.felt/<slug>.md`
}

/**
 * Map one entry from felt's JSON output onto the kanban Fiber interface.
 * Tool-owned namespaces (`shuttle:`, `tempered:`, `depends_on:`) arrive as
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
  // depends_on ships as `[{id: "..."}]` (common), bare-string arrays (legacy),
  // or a BARE STRING — the one-dep form `felt edit --set depends_on=<id>`
  // writes, which is what the board's drag-to-stack gesture produces. Accept
  // all three, and remember which one it was: `dependsOnShape` is what keeps
  // the gesture from rewriting a hand-built list.
  const dependsOnRaw = f.depends_on ?? f['depends-on'];
  const dependsOn = fiberRefList(dependsOnRaw);
  const dependsOnShape: 'scalar' | 'list' | undefined =
    dependsOn === undefined ? undefined : typeof dependsOnRaw === 'string' ? 'scalar' : 'list';

  const tempered = typeof f.tempered === 'boolean' ? f.tempered : undefined;

  // shuttle: arrives as a native JSON map post felt v1.0.4. Anything else
  // (string, array, missing) means no shuttle block.
  const shuttleRaw = f.shuttle;
  const hasShuttleBlock =
    !!shuttleRaw && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);

  let shuttleKind: 'oneshot' | 'standing' | 'pinned' | undefined;
  let shuttleSessionId: string | undefined;
  let shuttleDispatchedAt: string | undefined;
  let shuttleHandedOffAt: string | undefined;
  let shuttleSessionUuid: string | undefined;
  let shuttleAgent: string | undefined;
  let shuttleEffort: string | undefined;
  let shuttleSchedule: { expr: string; tz: string } | undefined;
  let shuttleProjectDir: string | undefined;
  let shuttleChrome: boolean | undefined;
  let shuttleHost: string | undefined;

  if (hasShuttleBlock) {
    const s = shuttleRaw as Record<string, unknown>;
    shuttleKind =
      s.kind === 'standing' ? 'standing' : s.kind === 'pinned' ? 'pinned' : 'oneshot';
    if (typeof s.host === 'string' && s.host.trim()) shuttleHost = s.host.trim();

    const session = s.session;
    if (session && typeof session === 'object' && !Array.isArray(session)) {
      const sid = (session as Record<string, unknown>).id;
      if (typeof sid === 'string' && sid) shuttleSessionId = sid;
    }

    // shuttle.runtime — the machine-managed nested block (session_uuid,
    // dispatched_at, handed_off_at, run_id). Readers read ONLY the nested
    // form; nothing writes the retired flat keys. Two instants surface on the
    // board: they bound the session window the detail panel prints.
    const runtime = s.runtime;
    if (runtime && typeof runtime === 'object' && !Array.isArray(runtime)) {
      const r = runtime as Record<string, unknown>;
      shuttleDispatchedAt = pickIsoString(r, 'dispatched_at');
      shuttleHandedOffAt = pickIsoString(r, 'handed_off_at');
      if (typeof r.session_uuid === 'string' && r.session_uuid.trim()) {
        shuttleSessionUuid = r.session_uuid.trim();
      }
    }

    if (typeof s.agent === 'string' && s.agent) shuttleAgent = s.agent;
    if (typeof s.effort === 'string' && s.effort.trim()) shuttleEffort = s.effort.trim();
    if (typeof s.project_dir === 'string' && s.project_dir.trim()) {
      shuttleProjectDir = s.project_dir.trim();
    }

    // shuttle.chrome — only surface `true`, collapsing everything else to
    // undefined so consumers can do a single existence check.
    if (s.chrome === true) shuttleChrome = true;

    // shuttle.schedule = { expr, tz } for standing roles. Pre-CLI fibers may
    // carry the legacy `timezone` key; read either. Absent tz falls back to UTC.
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
    due,
    start,
    horizon,
    cold,
    tags,
    dependsOn,
    dependsOnShape,
    tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
    shuttleKind,
    shuttleSessionId,
    shuttleDispatchedAt,
    shuttleHandedOffAt,
    shuttleSessionUuid,
    shuttleAgent,
    shuttleEffort,
    shuttleSchedule,
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

/**
 * Like `stringList`, but also accepts items shaped as `{id: "..."}` so felt's
 * object-form depends_on round-trips correctly. Tolerates mixed arrays.
 */
function fiberRefList(v: unknown): string[] | undefined {
  // The scalar form: `depends_on: some-fiber`. felt stores what it is handed,
  // and `--set depends_on=<id>` hands it a string, so this is the shape the
  // board's own stack gesture round-trips through.
  if (typeof v === 'string') {
    const trimmed = v.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if (trimmed) out.push(trimmed);
    } else if (item && typeof item === 'object' && !Array.isArray(item)) {
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string') {
        const trimmed = id.trim();
        if (trimmed) out.push(trimmed);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}
