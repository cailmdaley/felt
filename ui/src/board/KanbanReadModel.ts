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
  cycleMembership,
  cycleSpan,
  effectiveHorizon,
  isCycleFiber,
  nextStandingLaunch,
  type KanbanColumn,
} from './KanbanRules.js';
import type {
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js';
import { ascByKey, descByKey, dueCivilDay, dueSortMs, instantMs } from './civilDay.js';

export interface BuildKanbanResponseOptions {
  /** Reference instant for due-drift, standing-role placement, and the response
   * `generatedAt`. Defaults to `Date.now()`. Thread it in tests for
   * determinism. */
  nowMs?: number;
}

/**
 * WHAT THE BOARD ADMITS — two kinds of row, and nothing else.
 *
 * A `shuttle:` row is work, and every piece of work on the Desk carries a
 * shuttle block: if it is a to-do, it becomes a shuttled thing. A bare `due:`
 * on a fiber is a date, not a commitment the board can act on — there is no
 * constitution to dispatch, no lifecycle verb that will take it (shuttle-ctl
 * refuses without a block), and a card the Desk cannot move is a card that
 * teaches you to distrust the column. Such a fiber is promoted, not shown.
 *
 * A CYCLE is the exception, and it is not work: admitted on its tag alone —
 * no shuttle block, no `due:`, no lifecycle status required, because an
 * open-ended cycle (a `start:` and nothing else) is a legitimate band the
 * Chronicle must draw. `classifyFiber` sends it straight to the `cycles`
 * surface, so it never reaches a Desk column.
 *
 * The daemon's feed is WIDER than this on purpose (`--has-field due` is one of
 * its three admission walks, see lib/shuttle/fiber_documents.ex): it serves
 * every row the board might want, and this predicate is where the board says
 * which of them it draws. A due-only row arriving on the wire is expected and
 * simply not admitted here.
 */
export function shouldIncludeInKanban(fiber: Fiber): boolean {
  if (fiber.hasShuttleBlock === true) return true;
  return isCycleFiber(fiber);
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

  if (feed.entries.length === 0) {
    return emptyResponse(feed, nowMs, staleness);
  }

  const eligible = dedupeMirroredRows(
    feed.entries.filter((e) => shouldIncludeInKanban(e.fiber)),
    feed,
  );
  const surfaces = assembleSurfaces(eligible, byId, nowMs);

  return {
    feltHost: feed.host,
    now: surfaces.now,
    timeline: surfaces.timeline,
    stash: surfaces.stash,
    pinned: surfaces.pinned,
    cycles: surfaces.cycles,
    totals: surfaceTotals(surfaces),
    temperedTotal: surfaces.temperedTotal,
    staleness,
    generatedAt: nowMs,
  };
}

/**
 * One fiber, one card — collapse the rows a mirrored fiber contributes.
 *
 * A fiber that lives in a git-synced store is served by EVERY daemon that has
 * it on disk, one row per origin. On the real board that is 245 rows for 240
 * fibers: five fibers under `science/unions` arrive from both the laptop and
 * `kelvin`, and each rendered twice in Drafts. Worse than cosmetic — the twins
 * disagree. Under a stale remote one copy dims and refuses drag while the other
 * looks fine, so which card you happened to grab decided whether the gesture
 * worked.
 *
 * Identity is `uid` (felt's intrinsic ULID, stable across stores) falling back
 * to the slug id for the handful of rows that predate uids. The survivor is
 * chosen by a fixed precedence, because "whichever the feed listed first" is
 * how you get a board that reshuffles between polls:
 *
 *   1. the LOCALLY-OWNED row — this host can actually write to it, and its
 *      liveness is first-hand rather than a cached remote snapshot;
 *   2. failing that, a row from a FRESH origin over a stale one — a stale
 *      origin's rows are last-known-good, which is exactly what you don't want
 *      to show when a live copy exists;
 *   3. failing that, the newest `modified_at`.
 *
 * The losing origin is not discarded silently: it rides on `mirroredOrigins` so
 * the card can say where else this fiber lives.
 *
 * The precedence above is for fibers with NO owner — plain `due:` cards and
 * cycles, which every store roots equally and no daemon can claim. A fiber that
 * names a `shuttle.host` is not one of those: exactly one daemon owns it, and
 * since `5669fc7` (`kanban_aux_admissible?` no longer waves through an
 * elsewhere-owned fiber that happens to carry a `due:`) no other daemon serves
 * it at all. So an owner row, when present, wins outright — ahead of local,
 * ahead of fresh. Not a tiebreak: writes route by `originId`, and the local
 * git mirror of an owned fiber is a copy the human cannot edit through the
 * board (`/transition`, `/felt-edit`, `/lifecycle` are all owner-routed, so
 * edits land on the owner's disk and arrive here only when git syncs) and
 * cannot observe (only the owner runs the tmux session). An owner row that is
 * STALE still wins — last-known-good plus `⌛ waiting on basalt-login-02` is the honest
 * reading; falling back to the mirror shows a disconnected host's work as
 * though it were fresh.
 *
 * That single rule replaces the liveness reconciliation this function used to
 * do: when the owner's row is the card, its worker arrives with it. What
 * survives is the negative half — a non-owner row that reaches us carrying a
 * `runtime` (a pre-`5669fc7` daemon still leaking foreign rows, a renamed host)
 * has its liveness dropped rather than believed, because the board would
 * otherwise offer to open and to kill a session that host does not run. Once
 * the fleet is current this whole function is a no-op for owned fibers: the
 * feed hands us exactly one row each and there is nothing to reconcile.
 */
export function dedupeMirroredRows(
  entries: CompositeEntry[],
  feed: CompositeFeed,
): CompositeEntry[] {
  const isStale = (origin: string): boolean => feed.origins[origin]?.stale === true;
  const isLocal = (origin: string): boolean =>
    origin === feed.host || feed.origins[origin]?.kind === 'local';

  const isOwner = (e: CompositeEntry): boolean =>
    !!e.fiber.shuttleHost && e.origin === e.fiber.shuttleHost;

  // Lower rank wins. Ownership outranks locality outranks freshness.
  const rank = (e: CompositeEntry): number =>
    isOwner(e) ? 0 : isLocal(e.origin) ? 1 : isStale(e.origin) ? 3 : 2;

  const winners = new Map<string, CompositeEntry>();
  const alsoOn = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.fiber.uid ?? entry.fiber.id;
    const held = winners.get(key);
    if (!held) {
      winners.set(key, entry);
      continue;
    }
    alsoOn.set(key, [...(alsoOn.get(key) ?? []), entry.origin]);
    const heldRank = rank(held);
    const mineRank = rank(entry);
    const better =
      mineRank !== heldRank
        ? mineRank < heldRank
        : (instantMs(entry.fiber.modifiedAt) ?? 0) > (instantMs(held.fiber.modifiedAt) ?? 0);
    if (better) {
      winners.set(key, entry);
      alsoOn.set(key, [...(alsoOn.get(key) ?? []).filter((o) => o !== entry.origin), held.origin]);
    }
  }

  return [...winners.entries()].map(([key, entry]) => {
    const others = alsoOn.get(key);
    // A row that is not the owner's cannot speak for an owned fiber's liveness
    // in either direction: it has no tmux session to report, and a `runtime` on
    // it (an old leaky daemon, a renamed host) would invent a worker that this
    // board would then offer to open and to kill.
    const withLiveness =
      entry.fiber.shuttleHost && !isOwner(entry)
        ? { ...entry, runtime: undefined, held: undefined, heldSince: undefined }
        : entry;
    return others && others.length > 0
      ? { ...withLiveness, mirroredOrigins: others }
      : withLiveness;
  });
}

type AssembledSurfaces = {
  now: KanbanResponse['now'];
  timeline: KanbanResponse['timeline'];
  stash: KanbanCard[];
  pinned: KanbanCard[];
  cycles: KanbanCard[];
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
): AssembledSurfaces {
  const drafts: KanbanCard[] = [];
  const scheduled: KanbanCard[] = [];
  const pinned: KanbanCard[] = [];
  const inFlight: KanbanCard[] = [];
  const awaitingReview: KanbanCard[] = [];
  const tempered: KanbanCard[] = [];
  const composted: KanbanCard[] = [];
  const cycles: KanbanCard[] = [];

  const buckets: Record<KanbanColumn, KanbanCard[]> = {
    drafts, scheduled, pinned, inFlight, awaitingReview, tempered, composted, cycles,
  };
  for (const entry of entries) {
    const card = toCard(entry, byId, nowMs);
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
  // In-flight order surfaces the workers most likely to need the human at the TOP and
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
  const futureDated: KanbanCard[] = [...scheduled];
  const nowDrafts: KanbanCard[] = [];
  for (const card of drafts) routeOpenCardByPlanningSurface(card, nowDrafts, stash);

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

  // Cycles are the calendar's backdrop, so they read left to right: earliest
  // band first, ties broken by name so the order holds still across polls.
  cycles.sort((a, b) => {
    const aStart = a.cycleStart ?? dueCivilDay(a.due) ?? '';
    const bStart = b.cycleStart ?? dueCivilDay(b.due) ?? '';
    if (aStart !== bStart) return aStart < bStart ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return {
    now: { drafts: nowDrafts, inFlight, awaitingReview: nowAwaitingReview },
    timeline: { past, futureDated },
    stash,
    pinned,
    cycles,
    temperedTotal: tempered.length,
  };
}

/**
 * EVERYTHING AT REST, in one list — what the Resting region actually draws.
 *
 * Two kinds of waiting, joined here because the human sees one region:
 *
 *   • SNOOZED work — `horizon:stashed`, on `resp.stash`. Put down on purpose,
 *     returning on its `due:` day.
 *   • A STANDING ROLE BETWEEN RUNS — `status:active` + a cron. `classifyFiber`
 *     calls it `scheduled` and the read model files it on the timeline surface
 *     at its next launch. That was right when the Desk carried a permanent
 *     timeline ribbon. The ribbon is gone (it survives only as the drag
 *     horizon, which draws no cards), so `scheduled` meant INVISIBLE: an armed
 *     monthly role like `finances/cc-bills-monthly` was on the board's data and
 *     on no surface the human could see.
 *
 * A role asleep on its cron is resting in every sense that matters to a person
 * reading the desk — it is not gone, it is not waiting on them, it comes back
 * on a day. So it is drawn in Resting, wearing its next launch ("↻ returns
 * Aug 12") rather than a snooze's "wakes".
 *
 * The response shape is untouched: `timeline.futureDated` keeps carrying these
 * cards (drag resolution reads them through `findCardById`), and this is the
 * JOIN, done at render time, not a second home for the card.
 *
 * The three statuses that are NOT here, and why they need nothing:
 *   status:open standing   → paused/draft, classifies to `drafts` — on the desk.
 *   status:closed standing → an awaiting run needing a verdict; it classifies to
 *                            `awaitingReview` and belongs in that column, not
 *                            asleep in Resting. Accept re-arms it (`felt shuttle
 *                            accept` → `status:active`) and it lands back here.
 *   a running standing role → the liveness branch sends it to `inFlight`.
 */
export function restingCards(resp: KanbanResponse | null): KanbanCard[] {
  if (!resp) return [];
  return [...resp.stash, ...resp.timeline.futureDated];
}

/** True when this card is a standing role asleep between runs — armed, no live
 *  worker, waiting on its own cron. The Resting region says so differently from
 *  a snooze, and `nextLaunchAt` is the day it names. */
export function isSleepingOnSchedule(card: KanbanCard): boolean {
  return card.shuttleKind === 'standing' && card.status === 'active' && !card.runningWorker;
}

/** The Desk columns a lensed member can appear in. */
type LensColumn = 'drafts' | 'inFlight' | 'awaitingReview';

/** A member the lens has to CONJURE: it belongs to the cycle but is not on any
 *  Desk column right now (resting, or snoozed until a day inside the span). */
interface CycleLensGhost {
  card: KanbanCard;
  /** The column the card would sit in if it were on the desk. */
  column: LensColumn;
}

/** One cycle, resolved into what the Desk has to draw differently. */
export interface CycleLens {
  cycleId: string;
  name: string;
  /** Every member, on the desk or off it. Non-members are everything else. */
  memberIds: Set<string>;
  ghosts: CycleLensGhost[];
  /** What the chip says — members on the desk plus ghosts. */
  count: number;
}

/**
 * Resolve one cycle into a lens over a board response: who belongs, and which
 * of them the Desk is not currently showing.
 *
 * Membership is `cycleMembership` — derived, never assigned. The Desk supplies
 * two of its three rungs: `due:` inside the span, and "in flight right now".
 * The third (worked inside the span) needs activity days from the temporal
 * feeds, which the Desk does not fetch; when a caller can supply them, it puts
 * them on the candidate and the rung starts firing with no change here.
 *
 * GHOSTS come from Resting. A resting card is off the desk by choice, but if it
 * is due inside the cycle you are looking at, it is part of that chapter's
 * work and hiding it would make the lens lie about its own count.
 */
export function deriveCycleLens(
  resp: KanbanResponse | null,
  cycleId: string | null,
  nowMs: number = Date.now(),
): CycleLens | null {
  if (!resp || !cycleId) return null;
  const cycle = resp.cycles.find((c) => c.id === cycleId);
  if (!cycle) return null;
  const span = cycleSpan({ start: cycle.cycleStart ?? undefined, due: cycle.due }, nowMs);
  if (!span) return null;

  const memberIds = new Set<string>();
  const columns: LensColumn[] = ['drafts', 'inFlight', 'awaitingReview'];
  for (const column of columns) {
    for (const card of resp.now[column]) {
      const reason = cycleMembership({ due: card.due, inFlight: column === 'inFlight' }, span, nowMs);
      if (reason) memberIds.add(card.id);
    }
  }

  // Ghosts are drawn from the same set the Resting region draws, so the lens and
  // the region can never disagree about who is at rest. A standing role joins a
  // cycle only if it carries a `due:` of its own — a cron is a cadence, not a
  // commitment to a chapter.
  const ghosts: CycleLensGhost[] = [];
  for (const card of restingCards(resp)) {
    // A resting card is never in flight — that is what resting means — so only
    // the `due:` rung (and, later, `worked`) can admit it.
    if (!cycleMembership({ due: card.due }, span, nowMs)) continue;
    memberIds.add(card.id);
    ghosts.push({ card, column: ghostColumn(card) });
  }

  return { cycleId, name: cycle.name, memberIds, ghosts, count: memberIds.size };
}

/**
 * The column a resting card would surface in. Today every card on the Resting
 * surface is an open draft (`routeOpenCardByPlanningSurface` only ever routes
 * the drafts bucket there), so this is `drafts` in practice; the closed and
 * running branches are here so a future Resting inhabitant lands somewhere
 * truthful rather than silently in Drafts.
 */
function ghostColumn(card: KanbanCard): LensColumn {
  if (card.status === 'closed' && card.tempered === undefined) return 'awaitingReview';
  if (card.runningWorker || card.status === 'active') return 'inFlight';
  return 'drafts';
}

/**
 * One composite row → one card, outside the board's surface assembly.
 *
 * The board builds cards in bulk from the whole feed; a fiber reached by
 * [[wikilink]] arrives alone, from the single-fiber feed, and still needs the
 * same card the board would have made — same fields, same shuttle block, so
 * the panel that opens it is the same panel. Dependency satisfaction is the
 * one thing a lone row cannot know (there is no feed to look siblings up in),
 * so it answers the way a card with no dependencies does — UNSATISFIED is a
 * claim, and `blocked on: …` is what the panel prints from it, so ignorance
 * must not be able to make it. `toCard` resolves against an empty map, where
 * every dependency reads as unmet; this restores the "nothing known against
 * it" answer.
 */
export function cardFromCompositeEntry(entry: CompositeEntry, nowMs = Date.now()): KanbanCard {
  return { ...toCard(entry, new Map(), nowMs), dependsOnSatisfied: true };
}

/**
 * One composite row → one card. The frontend twin of the backend `toCard`, with
 * collection-era machinery dropped:
 *   - `runningWorker` is the feed row's owner-served `runtime.tmuxSession` —
 *     uniform for local and remote, ONE observer per fiber. No `resolveRunningWorker`,
 *     no local tmux index, no per-origin branch. This is the bounce-kill.
 * Dependency satisfaction still reads `byId` across the whole feed.
 */
function toCard(
  entry: CompositeEntry,
  byId: Map<string, Fiber>,
  nowMs: number,
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
  const isCycle = isCycleFiber(f);

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
    mirroredOrigins: entry.mirroredOrigins,
    sessionId: f.shuttleSessionId,
    dispatchedAt: f.shuttleDispatchedAt,
    handedOffAt: f.shuttleHandedOffAt,
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
    isCycle,
    // Normalized to a bare civil day here, once, so no view re-derives it (and
    // no view re-parses it as an instant and loses a day). `cycleSpan` fills in
    // the start for a cycle that only names its end.
    cycleStart: isCycle ? dueCivilDay(f.start) ?? null : null,
  };
}

/**
 * Route one open card onto its planning surface from `effectiveHorizon`:
 * `now` → the desk, `stashed` → Resting. A `due:` never routes: a future-dated
 * draft stays in Drafts and wears its date as a chip.
 *
 * A SNOOZED card — `horizon:stashed` plus a future `due:` — resolves to
 * `stashed` and lands here in Resting, keeping its `due:`. `effectiveHorizon`'s
 * drift branch returns it to the desk when the day arrives.
 */
function routeOpenCardByPlanningSurface(
  card: KanbanCard,
  now: KanbanCard[],
  stash: KanbanCard[],
): void {
  if (card.effectiveHorizon === 'now') now.push(card);
  else stash.push(card);
}

/** Per-bucket counts for a response, derived from the assembled surfaces. */
function surfaceTotals(s: AssembledSurfaces): KanbanResponse['totals'] {
  return {
    drafts: s.now.drafts.length,
    inFlight: s.now.inFlight.length,
    awaitingReview: s.now.awaitingReview.length,
    past: s.timeline.past.length,
    futureDated: s.timeline.futureDated.length,
    stash: s.stash.length,
    pinned: s.pinned.length,
  };
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
): KanbanResponse {
  return {
    feltHost: feed.host,
    now: { drafts: [], inFlight: [], awaitingReview: [] },
    timeline: { past: [], futureDated: [] },
    stash: [],
    pinned: [],
    cycles: [],
    totals: {
      drafts: 0, inFlight: 0, awaitingReview: 0,
      past: 0, futureDated: 0, stash: 0, pinned: 0,
    },
    temperedTotal: 0,
    staleness,
    generatedAt: nowMs,
  };
}

// `createdAt` / `modifiedAt` / `closedAt` / `nextLaunchAt` are INSTANTS. Order
// them by epoch milliseconds, never by the RFC3339 string: the string carries
// an offset, so a lexicographic compare orders by LOCAL WALL CLOCK.
// `2026-07-27T09:00:00-07:00` sorts below `2026-07-27T18:00:00+02:00` although
// both name the same instant, which sank every Berkeley-created fiber below
// older Paris work in Drafts, the Past lane and the Pinned strip. See
// civilDay.ts. `due:` is the exception — a civil day, keyed by its local
// midnight, not by an instant.

export function byCreatedAtDesc(a: KanbanCard, b: KanbanCard): number {
  return descByKey(instantMs(a.createdAt), instantMs(b.createdAt));
}

export function byRecentActivityThenName(a: KanbanCard, b: KanbanCard): number {
  const aT = instantMs(a.modifiedAt) ?? instantMs(a.createdAt);
  const bT = instantMs(b.modifiedAt) ?? instantMs(b.createdAt);
  if (aT !== bT) return descByKey(aT, bT);
  return (a.name || '').localeCompare(b.name || '');
}

export function byClosedAtDesc(a: KanbanCard, b: KanbanCard): number {
  const aT = instantMs(a.closedAt) ?? instantMs(a.createdAt);
  const bT = instantMs(b.closedAt) ?? instantMs(b.createdAt);
  return descByKey(aT, bT);
}

export function byDueAtAsc(a: KanbanCard, b: KanbanCard): number {
  // Soonest first. A standing role sorts by its next launch (an instant); a
  // dated card by the civil day its `due:` names, keyed to local midnight so
  // the two are comparable on one axis.
  const aT = a.nextLaunchAt ? instantMs(a.nextLaunchAt) : dueSortMs(a.due);
  const bT = b.nextLaunchAt ? instantMs(b.nextLaunchAt) : dueSortMs(b.due);
  return ascByKey(aT, bT);
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
