// The kanban's read model, in the view.
//
// `buildKanbanResponseFromComposite` is the frontend mirror of the backend
// `server/src/KanbanReadModel.ts` `buildResponse()` — MINUS collection. The
// daemon's `GET /api/v1/fibers/composite` now owns collection (the local owner
// feed concatenated with each remote daemon's cached owner feed), so the only
// thing left for the view is the read model that was always view logic:
// classify → assemble surfaces → build cards → compute staleness. The output is
// the exact `KanbanResponse` shape `KanbanSurfaces` (the renderer) already
// consumes, so the renderer is untouched.
//
// The single most important property lives in `toCard`: a card's
// `runningWorker` comes from the feed row's owner-served `runtime`, never from a
// second tmux read. Every fiber's liveness was resolved once, by its owning
// host. There is no second local observer to disagree with the daemon's
// reconciled `status` — which is what structurally dissolves the
// drag-to-drafts bounce (the symptom this whole constitution exists to kill).

import type {
  CompositeEntry,
  CompositeFeed,
  CompositeOrigin,
} from './KanbanComposite.js';
import type { Fiber } from './KanbanFiber.js';
import {
  classifyFiber,
  effectiveHorizon,
  KANBAN_TIMELINE_WINDOW,
  nextStandingLaunch,
  parseDueMs,
  STANDING_TIMELINE_HORIZON_MS,
  type KanbanColumn,
} from './KanbanRules.js';
import type {
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js';

/**
 * Resolve the pinned local city + project-relative slug for a composite entry,
 * for the click-to-open-in-vellum flow. Injected by the modal at fetch time —
 * city pinning is a Portolan-local concept the daemon feed doesn't carry.
 *
 * The resolver matches the row's felt FILE path (`<entry.feltStore>/.felt/<entry.path>`)
 * against each pinned city's `.felt` realpath, longest prefix wins — a verbatim
 * browser port of the backend's `resolveCityForCanonicalPath`. It does NOT match
 * `entry.feltStore` alone: on a loom-canonical host `feltStore` is uniformly the
 * loom for every loom-served row and so can't discriminate `portolan` from
 * `ai-futures`, while a symlinked substore (the iCloud `wedding` store) reports
 * its own `feltStore` and must match its own city. See `KanbanCityResolver.ts`
 * (`buildCityResolver`) for the implementation and its real-row equivalence tests.
 *
 * A resolver that returns `undefined` (or no resolver at all) leaves the card
 * city-less; `onOpenFiber` then falls back to in-place `navigate(/${card.id})`.
 * Keeping it injectable is what holds `buildKanbanResponseFromComposite` pure
 * and unit-testable.
 */
export type CityResolver = (
  entry: CompositeEntry,
) => { cityId: string; projectSlug: string; shuttleFiberId?: string } | undefined;

export interface BuildKanbanResponseOptions {
  /** Reference instant for due-drift, standing-role placement, and the response
   * `generatedAt`. Defaults to `Date.now()`. Thread it in tests for
   * determinism. */
  nowMs?: number;
  resolveCity?: CityResolver;
  /**
   * City-scoped board: when set, only cards whose `resolveCity` attributes them
   * to this `cityId` are classified onto surfaces (the composite feed is
   * loom-wide; a board opened from a city vellum shows just that city). Omit for
   * the global loom-wide board. Dependency resolution still spans the whole feed
   * — only the eligible/classified set is narrowed. Unattributed rows (remote /
   * unpinned) are excluded from a scoped view, matching the backend
   * `?cityId=`-scoped board.
   */
  scopeCityId?: string;
}

/**
 * Faithful to the backend predicate: a `shuttle:` row is always admitted; a
 * non-shuttle row is admitted iff it's an open/active human `due:` card. The
 * daemon's `/api/v1/fibers/composite` now carries those local human due-date
 * rows too (Shuttle serves them into the LOCAL portion via a `--has-field due`
 * walk; remotes have no human-due analog), so this branch is live once
 * `KanbanModal` reads the composite feed and the `:4000` daemon restarts.
 */
export function shouldIncludeInKanban(fiber: Fiber): boolean {
  if (fiber.hasShuttleBlock === true) return true;
  return (
    (fiber.status === 'open' || fiber.status === 'active') &&
    parseDueMs(fiber.due) !== undefined
  );
}

/**
 * Build the full kanban board from one composite feed. Pure: same feed +
 * options → same response. No I/O, no tmux, no filesystem.
 */
export function buildKanbanResponseFromComposite(
  feed: CompositeFeed,
  opts: BuildKanbanResponseOptions = {},
): KanbanResponse {
  const nowMs = opts.nowMs ?? Date.now();
  const staleness = buildStaleness(feed);

  // Dependency resolution reads across origins, so `byId` spans the WHOLE feed
  // (a local fiber may depend on a remote-owned one and vice versa), while only
  // the kanban-eligible subset is actually classified onto surfaces.
  const byId = new Map<string, Fiber>(feed.entries.map((e) => [e.fiber.id, e.fiber]));
  const tagIndex = collectTagIndex(feed.entries);

  if (feed.entries.length === 0) {
    return emptyResponse(feed, nowMs, staleness, tagIndex);
  }

  const eligible = feed.entries
    .filter((e) => shouldIncludeInKanban(e.fiber))
    .filter((e) =>
      opts.scopeCityId === undefined
        ? true
        : opts.resolveCity?.(e)?.cityId === opts.scopeCityId,
    );
  const surfaces = assembleSurfaces(eligible, byId, nowMs, opts.resolveCity);

  return {
    feltHost: feed.host,
    now: surfaces.now,
    timeline: surfaces.timeline,
    stash: surfaces.stash,
    pinned: surfaces.pinned,
    totals: surfaceTotals(surfaces),
    temperedTotal: surfaces.temperedTotal,
    timelineWindow: KANBAN_TIMELINE_WINDOW,
    staleness,
    tagIndex,
    generatedAt: nowMs,
  };
}

type AssembledSurfaces = {
  now: KanbanResponse['now'];
  timeline: KanbanResponse['timeline'];
  stash: KanbanCard[];
  pinned: KanbanCard[];
  temperedTotal: number;
};

/**
 * The classify-and-route pass: run `classifyFiber` (the SINGLE source of truth)
 * over each eligible entry, sort each column, and route the open/scheduled
 * buckets onto the three response surfaces (now / timeline / stash). Verbatim
 * port of the backend `assembleSurfaces`, with `toCard` reading owner-served
 * liveness off the feed row instead of a local tmux index.
 */
function assembleSurfaces(
  entries: CompositeEntry[],
  byId: Map<string, Fiber>,
  nowMs: number,
  resolveCity?: CityResolver,
): AssembledSurfaces {
  const drafts: KanbanCard[] = [];
  const scheduled: KanbanCard[] = [];
  const pinned: KanbanCard[] = [];
  const inFlight: KanbanCard[] = [];
  const awaitingReview: KanbanCard[] = [];
  const tempered: KanbanCard[] = [];
  const composted: KanbanCard[] = [];

  const buckets: Record<KanbanColumn, KanbanCard[]> = {
    drafts, scheduled, pinned, inFlight, awaitingReview, tempered, composted,
  };
  for (const entry of entries) {
    const card = toCard(entry, byId, nowMs, resolveCity);
    buckets[classifyFiber(entry.fiber, {
      runningWorker: !!card.runningWorker,
      dependsOnSatisfied: card.dependsOnSatisfied,
    })].push(card);
  }

  scheduled.sort(byCreatedAtDesc);
  // Pinned strip: most-recently-used first. A running role leaves the strip and
  // returns (re-armed) when accepted, freshly touched, so recent activity floats
  // the roles you actually use to the reachable left edge. Tie-break by name for
  // stability among never-run roles.
  pinned.sort(byRecentActivityThenName);
  drafts.sort(byCreatedAtDesc);
  // In-flight order surfaces the workers most likely to need Cail at the TOP and
  // sinks the busy ones to the bottom — the inverse of a newest-first list.
  //   tier 0  attention   — the worker raised its hand (last hook event is a
  //                         Notification). Pinned to the very top.
  //   tier 1  waiting     — the worker is STOPPED (last event stop/subagent_
  //                         stop). Ranked CONTINUOUSLY by idle = nowMs −
  //                         lastActivityAt, longest-stopped first: a review
  //                         abandoned 24h ago beats one stopped 30s ago.
  //   tier 2  working +   — a worker mid-tool (last event pre/post_tool_use /
  //           everything    prompt / session_start) is BUSY, not idle, so it
  //           else          sinks here regardless of how long its long-running
  //                         tool has been going — the CATEGORY, not raw wall-
  //                         clock, is what guards against a mid-tool worker
  //                         being mistaken for idle. Worker-less lifecycle
  //                         phases land here too and fall through to the
  //                         existing active / createdAt tiebreaks.
  // 60s is ONLY the chip threshold (KanbanSurfaces); the sort is continuous, so
  // a worker stopped 30s still ranks above a working one — just without a chip.
  const inFlightActivityRank = (card: KanbanCard): { tier: number; idle: number } => {
    if (card.runtimePhase === 'attention') return { tier: 0, idle: 0 };
    if (card.runtimePhase === 'waiting') {
      const idle = card.lastActivityAt !== undefined ? nowMs - card.lastActivityAt : 0;
      return { tier: 1, idle };
    }
    return { tier: 2, idle: 0 };
  };
  inFlight.sort((a, b) => {
    const aRank = inFlightActivityRank(a);
    const bRank = inFlightActivityRank(b);
    if (aRank.tier !== bRank.tier) return aRank.tier - bRank.tier;
    if (aRank.tier === 1 && aRank.idle !== bRank.idle) return bRank.idle - aRank.idle; // longest-stopped first
    const aActive = a.runningWorker || a.status === 'active' ? 0 : 1;
    const bActive = b.runningWorker || b.status === 'active' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return byCreatedAtDesc(a, b);
  });
  awaitingReview.sort(byClosedAtDesc);
  tempered.sort(byClosedAtDesc);
  composted.sort(byClosedAtDesc);

  const stash: KanbanCard[] = [];
  const futureDated: KanbanCard[] = [];
  const anytimeSoon: KanbanCard[] = [];
  const nowDrafts: KanbanCard[] = [];
  for (const card of scheduled) {
    const launchMs = card.nextLaunchAt ? Date.parse(card.nextLaunchAt) : NaN;
    const withinStrip =
      Number.isFinite(launchMs) && launchMs - nowMs <= STANDING_TIMELINE_HORIZON_MS;
    if (withinStrip) futureDated.push(card);
    else anytimeSoon.push(card);
  }
  for (const card of drafts) routeOpenCardByPlanningSurface(card, nowDrafts, futureDated, stash);

  // Awaiting-review cards are closed and pending a human verdict — unconditionally
  // actionable, so they stay in the Now awaitingReview column. They must NOT be
  // routed through the open-card planning router: a stale `horizon` left over from
  // when the card was an active stashed draft (planning horizon is an open-card
  // concept) would otherwise re-route a just-closed card onto the stash surface,
  // hiding it from the desk. That's exactly how a closed-with-horizon:stashed card
  // "disappeared from everywhere." See gotcha-awaiting-review-stale-horizon.
  const nowAwaitingReview = awaitingReview;

  const past = mergeByClosedAtDesc(tempered, composted);
  futureDated.sort(byDueAtAsc);
  anytimeSoon.sort(byDueAtAsc);

  return {
    now: { drafts: nowDrafts, inFlight, awaitingReview: nowAwaitingReview },
    timeline: { past, futureDated, anytimeSoon },
    stash,
    pinned,
    temperedTotal: tempered.length,
  };
}

/**
 * One composite row → one card. The frontend twin of the backend `toCard`, with
 * collection-era machinery dropped:
 *   - `runningWorker` is the feed row's owner-served `runtime.tmuxSession` —
 *     uniform for local and remote, ONE observer per fiber. No `resolveRunningWorker`,
 *     no local tmux index, no per-origin branch. This is the bounce-kill.
 *   - `cityId`/`projectSlug`/`shuttleFiberId` come from the injected resolver,
 *     not a `realpath` + pinned-city walk (browser can't realpath).
 * Dependency satisfaction still reads `byId` across the whole feed.
 */
function toCard(
  entry: CompositeEntry,
  byId: Map<string, Fiber>,
  nowMs: number,
  resolveCity?: CityResolver,
): KanbanCard {
  const f = entry.fiber;
  const dependsOn = f.dependsOn ?? [];
  const dependsOnSatisfied =
    dependsOn.length === 0 || dependsOn.every((d) => byId.get(d)?.tempered === true);
  const runningWorker = entry.runtime?.tmuxSession;
  const runtimePhase = entry.runtime?.phase;
  const lastActivityAt = entry.runtime?.lastActivityAt;
  const held = entry.held === true;
  const heldSince = entry.heldSince;
  const horizon = effectiveHorizon(f, nowMs);
  const city = resolveCity?.(entry);

  return {
    id: f.id,
    uid: f.uid,
    name: f.name,
    path: entry.path,
    originId: entry.origin,
    feltStore: entry.feltStore,
    // Prefer the fiber's own dir; fall back to the report.html sibling's dir
    // for rows from an older daemon that emits `report_path` but not `dir`.
    fiberDir:
      entry.dir ??
      (entry.reportPath ? entry.reportPath.replace(/\/[^/]*$/, '') : undefined),
    status: f.status,
    outcome: f.outcome,
    due: f.due,
    tags: f.tags,
    createdAt: f.createdAt,
    closedAt: f.closedAt,
    modifiedAt: f.modifiedAt,
    tempered: f.tempered,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    dependsOnSatisfied,
    runningWorker,
    runtimePhase,
    lastActivityAt,
    held,
    heldSince,
    cityId: city?.cityId,
    projectSlug: city?.projectSlug,
    shuttleFiberId: city?.shuttleFiberId,
    sessionId: f.shuttleSessionId,
    shuttleAgent: f.shuttleAgent,
    shuttleEffort: f.shuttleEffort,
    shuttleChrome: f.shuttleChrome,
    shuttleHost: f.shuttleHost,
    shuttleKind: f.shuttleKind,
    shuttleSchedule: f.shuttleSchedule?.expr,
    shuttleTz: f.shuttleSchedule?.tz,
    shuttleProjectDir: f.shuttleProjectDir,
    nextLaunchAt: nextStandingLaunch(f, nowMs),
    storedHorizon: horizon.storedHorizon,
    effectiveHorizon: horizon.effectiveHorizon,
    drifted: horizon.drifted,
    cold: typeof f.cold === 'boolean' ? f.cold : undefined,
  };
}

function routeOpenCardByPlanningSurface(
  card: KanbanCard,
  now: KanbanCard[],
  futureDated: KanbanCard[],
  stash: KanbanCard[],
): void {
  if (card.effectiveHorizon === 'now') {
    now.push(card);
  } else if (card.effectiveHorizon === 'soon' && card.due) {
    futureDated.push(card);
  } else {
    stash.push(card);
  }
}

/** Per-bucket counts for a response, derived from the assembled surfaces. */
function surfaceTotals(s: AssembledSurfaces): KanbanResponse['totals'] {
  return {
    drafts: s.now.drafts.length,
    inFlight: s.now.inFlight.length,
    awaitingReview: s.now.awaitingReview.length,
    past: s.timeline.past.length,
    futureDated: s.timeline.futureDated.length,
    anytimeSoon: s.timeline.anytimeSoon.length,
    stash: s.stash.length,
    pinned: s.pinned.length,
  };
}

function collectTagIndex(entries: CompositeEntry[]): string[] {
  const seen = new Set<string>();
  for (const { fiber } of entries) {
    if (!Array.isArray(fiber.tags)) continue;
    for (const t of fiber.tags) {
      if (typeof t !== 'string') continue;
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      seen.add(trimmed);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/**
 * Per-origin freshness from the composite feed's `origins` map. The daemon's
 * federated registry marks an unreachable remote `stale` (keeping its
 * last-known rows, not dropping them); a local or reachable-remote origin is
 * `fresh`. The backend's soft-deadline `loading` state has no analog here — the
 * daemon owns the fan-out and reports a binary stale/fresh — so this maps to two
 * statuses, keyed by origin (host) name. The card's `originId` is that same
 * name, so `staleness[card.originId]` resolves directly.
 */
function buildStaleness(feed: CompositeFeed): Record<string, KanbanOriginStaleness> {
  const out: Record<string, KanbanOriginStaleness> = {};
  for (const [name, origin] of Object.entries(feed.origins)) {
    out[name] = originStaleness(name, origin);
  }
  // Guarantee a local entry even if the feed omitted its origins map, so the
  // renderer's `staleness[card.originId]` is never undefined for a local card.
  if (!out[feed.host]) out[feed.host] = { status: 'fresh', hostname: feed.host };
  return out;
}

function originStaleness(name: string, origin: CompositeOrigin): KanbanOriginStaleness {
  const status: KanbanOriginStaleness['status'] =
    origin.kind === 'local' ? 'fresh' : origin.stale ? 'stale' : 'fresh';
  return status === 'stale'
    ? { status, hostname: name, staleSince: origin.lastPolledAt }
    : { status, hostname: name };
}

function emptyResponse(
  feed: CompositeFeed,
  nowMs: number,
  staleness: Record<string, KanbanOriginStaleness>,
  tagIndex: string[],
): KanbanResponse {
  return {
    feltHost: feed.host,
    now: { drafts: [], inFlight: [], awaitingReview: [] },
    timeline: { past: [], futureDated: [], anytimeSoon: [] },
    stash: [],
    pinned: [],
    totals: {
      drafts: 0, inFlight: 0, awaitingReview: 0,
      past: 0, futureDated: 0, anytimeSoon: 0, stash: 0, pinned: 0,
    },
    temperedTotal: 0,
    timelineWindow: KANBAN_TIMELINE_WINDOW,
    staleness,
    tagIndex,
    generatedAt: nowMs,
  };
}

function byCreatedAtDesc(a: KanbanCard, b: KanbanCard): number {
  return (b.createdAt || '').localeCompare(a.createdAt || '');
}

function byRecentActivityThenName(a: KanbanCard, b: KanbanCard): number {
  const aT = a.modifiedAt || a.createdAt || '';
  const bT = b.modifiedAt || b.createdAt || '';
  if (aT !== bT) return bT.localeCompare(aT);
  return (a.name || '').localeCompare(b.name || '');
}

function byClosedAtDesc(a: KanbanCard, b: KanbanCard): number {
  const aT = a.closedAt || a.createdAt || '';
  const bT = b.closedAt || b.createdAt || '';
  return bT.localeCompare(aT);
}

function byDueAtAsc(a: KanbanCard, b: KanbanCard): number {
  const aT = a.nextLaunchAt ?? a.due ?? '';
  const bT = b.nextLaunchAt ?? b.due ?? '';
  if (aT === bT) return 0;
  if (!aT) return 1;
  if (!bT) return -1;
  return aT.localeCompare(bT);
}

function mergeByClosedAtDesc(a: KanbanCard[], b: KanbanCard[]): KanbanCard[] {
  const out: KanbanCard[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (byClosedAtDesc(a[i], b[j]) <= 0) out.push(a[i++]);
    else out.push(b[j++]);
  }
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}
