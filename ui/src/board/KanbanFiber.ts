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
  kind: string;      // task, decision, question, spec
  priority: number;  // default 2
  createdAt: string; // ISO date from frontmatter
  body?: string;     // markdown body after frontmatter
  outcome?: string;  // outcome from frontmatter
  closedAt?: string; // ISO date from frontmatter
  modifiedAt?: string; // file mtime felt reports as `modified_at`.
  due?: string;       // project-owned frontmatter `due:` for human-facing deadlines
  horizon?: string;   // legacy project-owned planning field. New Kanban writes
                      // only persist `stashed`; `now`/`soon` are read for
                      // compatibility and normalized by KanbanRules.
  cold?: boolean;     // project-owned frontmatter `cold:` — when true, stash
                      // cluster renders dimmer and below warm clusters.
  tags?: string[];
  dependsOn?: string[]; // fiber IDs this depends on
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
   * daemon affinity and Portolan's owner routing. */
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
 * Portolan conventions felt does not interpret. We default them so downstream
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
  const horizon = typeof f.horizon === 'string' && f.horizon.trim() ? f.horizon.trim() : undefined;
  const cold = typeof f.cold === 'boolean' ? f.cold : undefined;

  // Prefer canonical *_at fields; fall back to legacy `created`/`closed`.
  const createdAt = pickIsoString(f, ['created_at', 'created']) ?? '';
  const closedAt = pickIsoString(f, ['closed_at', 'closed']);
  const modifiedAt = pickIsoString(f, ['modified_at', 'modified']);

  const tags = stringList(f.tags);
  // depends_on ships as `[{id: "..."}]` (common) or bare-string arrays
  // (legacy). Accept both shapes.
  const dependsOn = fiberRefList(f.depends_on) ?? fiberRefList(f['depends-on']);

  const tempered = typeof f.tempered === 'boolean' ? f.tempered : undefined;

  // shuttle: arrives as a native JSON map post felt v1.0.4. Anything else
  // (string, array, missing) means no shuttle block.
  const shuttleRaw = f.shuttle;
  const hasShuttleBlock =
    !!shuttleRaw && typeof shuttleRaw === 'object' && !Array.isArray(shuttleRaw);

  let shuttleKind: 'oneshot' | 'standing' | 'pinned' | undefined;
  let shuttleSessionId: string | undefined;
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

  // entry_point (felt) → isRoot (Portolan). Felt only emits this when true.
  const isRoot = !!f.entry_point;
  const parentId = isRoot
    ? null
    : id.includes('/')
      ? id.slice(0, id.lastIndexOf('/'))
      : null;

  // kind / priority are Portolan conventions felt does not interpret.
  const kind = typeof f.kind === 'string' && f.kind ? f.kind : 'task';
  const priorityRaw = f.priority;
  const priority =
    typeof priorityRaw === 'number'
      ? priorityRaw
      : typeof priorityRaw === 'string'
        ? parseInt(priorityRaw, 10) || 2
        : 2;

  return {
    id,
    uid,
    name,
    status,
    kind,
    priority,
    createdAt,
    closedAt,
    modifiedAt,
    outcome,
    body,
    due,
    horizon,
    cold,
    tags,
    dependsOn,
    tempered,
    hasShuttleBlock: hasShuttleBlock || undefined,
    shuttleKind,
    shuttleSessionId,
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

function pickIsoString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'string' && v && !v.startsWith('0001-')) {
      // 0001-01-01 is Go's zero-value time.Time when the field was absent in
      // source — treat as missing.
      return v;
    }
  }
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
