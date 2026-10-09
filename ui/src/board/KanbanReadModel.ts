// The kanban's read model, in the view.
//
// The daemon's `GET /api/v1/fibers/composite` owns collection (the local owner
// feed concatenated with each remote daemon's cached owner feed).
// `buildKanbanResponseFromComposite` is the view logic over it: classify →
// assemble surfaces → build cards → compute staleness, producing the
// `KanbanResponse` shape `KanbanSurfaces` (the renderer) consumes.
//
// The single most important property lives in `toCard`: a card's liveness
// (`workerState`) comes from the feed row's owner-served `runtime`, never from a
// second tmux read. Every fiber's liveness is resolved once, by its owning
// host, so there is no second local observer to disagree with the daemon's
// reconciled `status` — and no drag-to-drafts bounce between the two.

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
  foldHeadId,
  isCycleFiber,
  nextStandingLaunch,
  unresolvedDependencies,
  type FoldNode,
  type KanbanColumn,
} from './KanbanRules.js';
import type {
  InheritedProjectDir,
  KanbanCard,
  KanbanOriginStaleness,
  KanbanResponse,
} from './KanbanTypes.js';
import { hasLiveWorker } from './KanbanTypes.js';
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
 * its three admission walks, see daemon/lib/shuttle/fiber_documents.ex): it serves
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

  // Edge resolution reads across origins, so `byId` spans the WHOLE feed (a
  // local fiber may depend on a remote-owned one and vice versa), while only
  // the kanban-eligible subset is actually classified onto surfaces.
  // Keyed by BOTH names a dependency can call a fiber by: its path id/slug and
  // its intrinsic ULID `uid`. felt's own object-form `depends_on: [{id: <ulid>}]`
  // writes a uid, so without the uid key a perfectly good chain would draw as a
  // pile of loose cards each wearing a spurious "unresolved dep" warning.
  const byId = new Map<string, Fiber>();
  for (const e of feed.entries) {
    byId.set(e.fiber.id, e.fiber);
    // Both cases, because a uid is a ULID and a human retyping one does not
    // hold the shift key. `felt check` case-folds for the same reason.
    if (e.fiber.uid) {
      byId.set(e.fiber.uid, e.fiber);
      byId.set(e.fiber.uid.toLowerCase(), e.fiber);
    }
  }

  const eligible = dedupeMirroredRows(
    feed.entries.filter((e) => shouldIncludeInKanban(e.fiber)),
    feed,
  );
  const surfaces = assembleSurfaces(eligible, byId, projectDirIndex(eligible), nowMs);

  return {
    feltHost: feed.host,
    now: surfaces.now,
    timeline: surfaces.timeline,
    stash: surfaces.stash,
    roles: surfaces.roles,
    folded: surfaces.folded,
    cycles: surfaces.cycles,
    totals: surfaceTotals(surfaces),
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
 * Identity is `uid` (felt's intrinsic ULID, stable across stores). Without a
 * uid, only rows from the same origin with the same id can be identified as
 * one fiber: unrelated host-local paths must not collapse. The survivor is
 * chosen by a fixed precedence, because "whichever the feed listed first" is
 * how you get a board that reshuffles between polls:
 *
 *   1. the LOCALLY-OWNED row — this host can actually write to it, and its
 *      liveness is first-hand rather than a cached remote snapshot;
 *   2. failing that, a row from a FRESH origin over a stale one — a stale
 *      origin's rows are last-known-good, which is exactly what you don't want
 *      to show when a live copy exists;
 *   3. failing that, the newest valid `modified_at`, then origin and id.
 *
 * The losing origin is not discarded silently: it rides on `mirroredOrigins` so
 * the card can say where else this fiber lives.
 *
 * The precedence above is for fibers with NO owner — plain `due:` cards and
 * cycles, which every store roots equally and no daemon can claim. A fiber that
 * names a `shuttle.host` is not one of those: exactly one daemon owns it, and
 * no other daemon serves it (`kanban_aux_admissible?` refuses an
 * elsewhere-owned fiber even when it carries a `due:`). So an owner row, when present, wins outright — ahead of local,
 * ahead of fresh. Not a tiebreak: writes route by `originId`, and the local
 * git mirror of an owned fiber is a copy the human cannot edit through the
 * board (`/transition`, `/felt-edit`, `/lifecycle` are all owner-routed, so
 * edits land on the owner's disk and arrive here only when git syncs) and
 * cannot observe (only the owner runs the tmux session). An owner row that is
 * STALE still wins — last-known-good plus `⌛ waiting on basalt-login-02` is the honest
 * reading; falling back to the mirror shows a disconnected host's work as
 * though it were fresh.
 *
 * That single rule is the liveness reconciliation: when the owner's row is the
 * card, its worker arrives with it. The negative half remains — a non-owner
 * row that reaches us carrying a `runtime` (an older remote daemon leaking
 * foreign rows, a renamed host) has its liveness dropped rather than believed,
 * because the board would otherwise offer to open and to kill a session that
 * host does not run. On a current fleet this function is a no-op for owned
 * fibers: the feed hands us exactly one row each and there is nothing to
 * reconcile.
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
  const alsoOn = new Map<string, Set<string>>();
  for (const entry of entries) {
    const key = entry.fiber.uid
      ? `uid:${entry.fiber.uid}`
      : JSON.stringify([entry.origin, entry.fiber.id]);
    const held = winners.get(key);
    if (!held) {
      winners.set(key, entry);
      continue;
    }
    const origins = alsoOn.get(key) ?? new Set<string>();
    origins.add(held.origin);
    origins.add(entry.origin);
    alsoOn.set(key, origins);
    const precedence = rank(entry) - rank(held)
      || descByKey(instantMs(entry.fiber.modifiedAt), instantMs(held.fiber.modifiedAt))
      || compareText(entry.origin, held.origin)
      || compareText(entry.fiber.id, held.fiber.id);
    if (precedence < 0) winners.set(key, entry);
  }

  return [...winners.entries()].map(([key, entry]) => {
    const others = [...(alsoOn.get(key) ?? [])]
      .filter((origin) => origin !== entry.origin)
      .sort(compareText);
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
  roles: KanbanCard[];
  folded: KanbanCard[];
  cycles: KanbanCard[];
};

/**
 * The columns whose cards are DRAWN with their queue — the three desk columns
 * plus the scheduled/Resting surfaces. A head on one of these can
 * hold a fold; a head in the past lane (tempered, composted) or a cycle cannot,
 * so work queued behind finished work stands in its own column rather than
 * being tucked under something nobody is looking at.
 */
export const FOLDABLE_HEAD_COLUMNS: ReadonlySet<KanbanColumn> = new Set<KanbanColumn>([
  'drafts',
  'scheduled',
  'inFlight',
  'awaitingReview',
]);

/**
 * The classify-and-route pass: run `classifyFiber` (the SINGLE source of truth)
 * over each eligible entry, sort each column, and route the open/scheduled
 * buckets onto the three response surfaces (now / timeline / stash), with
 * `toCard` reading owner-served liveness off the feed row.
 */
function assembleSurfaces(
  entries: CompositeEntry[],
  byId: Map<string, Fiber>,
  dirs: ProjectDirIndex,
  nowMs: number,
): AssembledSurfaces {
  const drafts: KanbanCard[] = [];
  const scheduled: KanbanCard[] = [];
  const inFlight: KanbanCard[] = [];
  const awaitingReview: KanbanCard[] = [];
  const tempered: KanbanCard[] = [];
  const composted: KanbanCard[] = [];
  const cycles: KanbanCard[] = [];
  const roles: KanbanCard[] = [];

  const buckets: Record<KanbanColumn, KanbanCard[]> = {
    drafts, scheduled, inFlight, awaitingReview, tempered, composted, cycles, roles,
  };
  // THE FOLD. A card queued behind another is not a card of its own on this
  // board: it is drawn under its head, wherever the head is drawn, reachable
  // through that head's "+N queued" chip. So classification happens first, for
  // everyone (a card's column is always its own status), and the fold then
  // decides only which of them are DRAWN in their column.
  //
  // Two cards never fold, because both would be the board hiding something it
  // must show: one with a LIVE WORKER or `status: active` (work is happening
  // right now), and one whose head this board is not drawing at all — not in
  // the feed, or settled into the past lane. Nothing is ever hidden behind a
  // card that is not there.
  const classified = entries.map((entry) => {
    const card = toCard(entry, byId, dirs, nowMs);
    return {
      card,
      column: classifyFiber(entry.fiber, { liveWorker: hasLiveWorker(card) }),
    };
  });
  // Keyed by BOTH names an edge can call a fiber by — the slug id and the
  // intrinsic ULID — for the same reason `byId` is: felt's own object form
  // writes a uid, and a chain the board could not resolve would draw as a pile
  // of loose cards.
  const nodes = new Map<string, FoldNode>();
  for (const { card, column } of classified) {
    const node: FoldNode = {
      id: card.id,
      dependsOn: card.dependsOn,
      foldable: FOLDABLE_HEAD_COLUMNS.has(column),
    };
    nodes.set(card.id, node);
    if (card.uid) {
      nodes.set(card.uid, node);
      nodes.set(card.uid.toLowerCase(), node);
    }
  }
  const folded: KanbanCard[] = [];
  for (const { card, column } of classified) {
    const standsAlone = hasLiveWorker(card) || card.status === 'active';
    const head = standsAlone
      ? undefined
      : foldHeadId(nodes.get(card.id) ?? { id: card.id, dependsOn: card.dependsOn, foldable: false },
          (id) => nodes.get(id));
    if (head !== undefined) {
      folded.push({ ...card, foldedUnder: head });
      continue;
    }
    buckets[column].push(card);
  }
  folded.sort(byCreatedAtDesc);

  scheduled.sort(byCreatedAtDesc);
  // Desk has no persisted human arrangement; drafts use creation order.
  // Neither activity nor a renamed path moves them.
  drafts.sort(byCreatedAtDesc);
  // Seats read like a shelf of offices: alphabetical, so a launcher stays
  // where the hand expects it whatever was used last.
  roles.sort(byNameAsc);
  // A card moves only when it crosses a Question / Working seam.
  // Activity age and phase changes within a band do not change its position.
  inFlight.sort(byInFlightBand);
  awaitingReview.sort(byClosedAtDesc);
  tempered.sort(byClosedAtDesc);
  composted.sort(byClosedAtDesc);

  const stash: KanbanCard[] = [];
  const futureDated: KanbanCard[] = [...scheduled];
  const nowDrafts: KanbanCard[] = [];
  for (const card of drafts) routeOpenCardByPlanningSurface(card, nowDrafts, stash);

  // Awaiting-review cards are closed and pending a human verdict — actionable,
  // so they stay in the Now awaitingReview column. They must NOT be
  // routed through the open-card planning router: a stale `horizon` left over from
  // when the card was an active stashed draft (planning horizon is an open-card
  // concept) would otherwise re-route a just-closed card onto the stash surface,
  // hiding it from the desk. That's exactly how a closed-with-horizon:stashed card
  // "disappeared from everywhere." See gotcha-awaiting-review-stale-horizon.
  const nowAwaitingReview = awaitingReview;

  const past = mergeByClosedAtDesc(tempered, composted);
  futureDated.sort(byDueAtAsc);

  // Cycles are the calendar's backdrop, so they read left to right: earliest
  // band first, with identity ties and absent dates last.
  cycles.sort((a, b) => {
    const aStart = dueSortMs(a.cycleStart ?? a.due);
    const bStart = dueSortMs(b.cycleStart ?? b.due);
    return ascByKey(aStart, bStart) || byCardIdentity(a, b);
  });

  return {
    now: { drafts: nowDrafts, inFlight, awaitingReview: nowAwaitingReview },
    timeline: { past, futureDated },
    stash,
    roles,
    folded,
    cycles,
  };
}

function byNameAsc(a: KanbanCard, b: KanbanCard): number {
  return a.name.localeCompare(b.name) || byCardIdentity(a, b);
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
 *     at its next launch. The Desk draws no timeline cards (the timeline is
 *     only the drag horizon), so without this join an armed monthly role
 *     would be in the board's data and on no surface the human could see.
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
 *                            asleep in Resting. Accept re-arms it (`shuttle
 *                            accept` → `status:active`) and it lands back here.
 *   a running standing constitution → the liveness branch sends it to `inFlight`.
 */
export function restingCards(resp: KanbanResponse | null): KanbanCard[] {
  if (!resp) return [];
  return [...resp.stash, ...resp.timeline.futureDated];
}

/** True when this card is a standing constitution asleep between runs — armed, no live
 *  worker, waiting on its own cron. The Resting region says so differently from
 *  a snooze, and `nextLaunchAt` is the day it names. */
export function isSleepingOnSchedule(card: KanbanCard): boolean {
  return card.shuttleKind === 'standing' && card.status === 'active' && !hasLiveWorker(card);
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
 * Membership is `cycleMembership` — derived, never assigned: `due:` inside the
 * span, or "in flight right now".
 *
 * GHOSTS come from Resting and Roles. A resting card is off the desk by choice, but if it
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

  // Both resting bands contribute ghosts. A standing constitution joins a
  // cycle only if it carries a `due:` of its own — a cron is a cadence, not a
  // commitment to a chapter.
  const ghosts: CycleLensGhost[] = [];
  for (const card of [...restingCards(resp), ...resp.roles]) {
    // A resting card is never in flight — that is what resting means — so only
    // the `due:` rung can admit it.
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
  if (hasLiveWorker(card) || card.status === 'active') return 'inFlight';
  return 'drafts';
}

/**
 * One composite row → one card, outside the board's surface assembly.
 *
 * The board builds cards in bulk from the whole feed; a fiber reached by
 * [[wikilink]] arrives alone, from the single-fiber feed, and still needs the
 * same card the board would have made — same fields, same shuttle block, so
 * the panel that opens it is the same panel. What a lone row cannot know is
 * how its edges resolve (there is no feed to look siblings up in), so it says
 * nothing about them rather than reporting every one as dangling.
 */
export function cardFromCompositeEntry(entry: CompositeEntry, nowMs = Date.now()): KanbanCard {
  // `dependsOnUnresolved` is dropped: a lone row has no feed to resolve its
  // edges against, so every dep would read as dangling — a warning that every
  // single-fiber fetch would raise is noise, not information.
  return {
    ...toCard(entry, new Map(), new Map(), nowMs),
    dependsOnUnresolved: undefined,
  };
}

/**
 * One composite row → one card. Liveness (`workerState`) and the terminal
 * handle (`tmuxSession`) are the feed row's owner-served `runtime` — uniform
 * for local and remote, ONE observer per fiber,
 * no local tmux index and no per-origin branch. Edge resolution reads `byId`
 * across the whole feed.
 */
function toCard(
  entry: CompositeEntry,
  byId: Map<string, Fiber>,
  dirs: ProjectDirIndex,
  nowMs: number,
): KanbanCard {
  const f = entry.fiber;
  const dependsOn = f.dependsOn ?? [];
  // An id `byId` cannot answer for is REPORTED, never enforced: it lands on
  // `dependsOnUnresolved` (a badge on the card) and holds nothing back. A typo
  // must never be able to hide work.
  const unresolved = unresolvedDependencies(dependsOn, (id) => byId.has(id));
  const runtime = entry.runtime;
  const tmuxSession = runtime?.tmuxSession;
  // A blocked worker's phase is its block; otherwise the activity category.
  const runtimePhase = runtime?.state === 'blocked' ? 'blocked' : runtime?.phase;
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
    theme: f.theme,
    due: f.due,
    tags: f.tags,
    roles: f.roles,
    createdAt: f.createdAt,
    closedAt: f.closedAt,
    modifiedAt: f.modifiedAt,
    tempered: f.tempered,
    dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
    dependsOnShape: f.dependsOnShape,
    dependsOnUnresolved: unresolved.length > 0 ? unresolved : undefined,
    workerState: runtime?.state,
    tmuxSession,
    runtimePhase,
    launchError: entry.runtime?.launchError,
    sessionLink: entry.runtime?.sessionLink,
    desktopLink: entry.runtime?.desktopLink,
    sessionUuid: entry.runtime?.sessionUuid ?? f.shuttleSessionUuid,
    workerSurface: entry.runtime?.surface ?? (tmuxSession ? 'cli' : undefined),
    workerAgent: entry.runtime?.agent,
    lastActivityAt,
    workerStartedAt: runtime?.startedAt,
    held,
    heldSince,
    mirroredOrigins: entry.mirroredOrigins,
    ask: f.shuttleAsk,
    dispatchedAt: f.shuttleDispatchedAt,
    handedOffAt: f.shuttleHandedOffAt,
    shuttleAgent: f.shuttleAgent,
    shuttleEffort: f.shuttleEffort,
    shuttleChrome: f.shuttleChrome,
    shuttleSurface: f.shuttleSurface,
    shuttleHost: f.shuttleHost,
    shuttleKind: f.shuttleKind,
    shuttleSeat: f.shuttleSeat,
    shuttleSchedule: f.shuttleSchedule?.expr,
    shuttleTz: f.shuttleSchedule?.tz,
    shuttleProjectDir: f.shuttleProjectDir,
    inheritedProjectDir: inheritedProjectDir(entry, dirs),
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
 * Every declared `shuttle.project_dir` among the board's reconciled rows (one
 * per fiber, the authoritative owner's — see `dedupeMirroredRows`), keyed by
 * owning host, felt store and fiber id. A directory is a path on one machine,
 * and a suggestion should come from the fiber's own tree: neither another
 * host's copy of a slug nor a same-named fiber in another store on the same
 * host answers for it.
 */
export type ProjectDirIndex = Map<string, string>;

const dirKey = (host: string, store: string, id: string): string =>
  [host, store, id].join('\u0000');

export function projectDirIndex(entries: CompositeEntry[]): ProjectDirIndex {
  const dirs: ProjectDirIndex = new Map();
  for (const { fiber, feltStore } of entries) {
    if (fiber.shuttleHost && fiber.shuttleProjectDir) {
      dirs.set(dirKey(fiber.shuttleHost, feltStore, fiber.id), fiber.shuttleProjectDir);
    }
  }
  return dirs;
}

/**
 * The nearest ancestor's `shuttle.project_dir` for a fiber whose block names
 * none — the directory the board suggests when a start is refused for want of
 * one. Ancestors are the fiber's id prefixes (`a/b/c` → `a/b` → `a`) in the
 * same felt store, owned by the same host. `undefined` when the fiber declares
 * its own directory, names no host, or no ancestor qualifies.
 */
export function inheritedProjectDir(
  entry: CompositeEntry,
  dirs: ProjectDirIndex,
): InheritedProjectDir | undefined {
  const { fiber, feltStore } = entry;
  const host = fiber.shuttleHost;
  if (fiber.shuttleProjectDir || !host) return undefined;
  for (let id = fiber.id; id.includes('/'); ) {
    id = id.slice(0, id.lastIndexOf('/'));
    const path = dirs.get(dirKey(host, feltStore, id));
    if (path) return { path, from: id };
  }
  return undefined;
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
export function surfaceTotals(s: {
  now: KanbanResponse['now'];
  timeline: KanbanResponse['timeline'];
  stash: KanbanCard[];
  roles: KanbanCard[];
}): KanbanResponse['totals'] {
  return {
    drafts: s.now.drafts.length,
    inFlight: s.now.inFlight.length,
    awaitingReview: s.now.awaitingReview.length,
    past: s.timeline.past.length,
    futureDated: s.timeline.futureDated.length,
    stash: s.stash.length,
    roles: s.roles.length,
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

// `createdAt` / `closedAt` / `nextLaunchAt` are INSTANTS. Order
// them by epoch milliseconds, never by the RFC3339 string: the string carries
// an offset, so a lexicographic compare orders by LOCAL WALL CLOCK.
// `2026-07-27T09:00:00-07:00` sorts below `2026-07-27T18:00:00+02:00` although
// both name the same instant, which sank every Berkeley-created fiber below
// older Paris work in Drafts and the Past lane. See
// civilDay.ts. `due:` is the exception — a civil day, keyed by its local
// midnight, not by an instant.

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Locale-independent identity order, including distinct host-local ids. */
export function byCardIdentity(a: KanbanCard, b: KanbanCard): number {
  return compareText(a.uid ?? '', b.uid ?? '')
    || compareText(a.originId ?? '', b.originId ?? '')
    || compareText(a.id, b.id);
}

export function byCreatedAtDesc(a: KanbanCard, b: KanbanCard): number {
  return descByKey(instantMs(a.createdAt), instantMs(b.createdAt)) || byCardIdentity(a, b);
}

export type InFlightBand = 'question' | 'working';

/** In flight's bands in drawn order, with the caption each surface gives them. */
export const IN_FLIGHT_BANDS: ReadonlyArray<readonly [InFlightBand, string]> = [['question', 'Question'], ['working', 'Working']];

export function inFlightBand(card: KanbanCard): InFlightBand {
  if (card.ask) return 'question';
  return card.runtimePhase === 'waiting' || card.runtimePhase === 'blocked' || card.runtimePhase === 'attention'
    ? 'question'
    : 'working';
}

export function byInFlightBand(a: KanbanCard, b: KanbanCard): number {
  const order: Record<InFlightBand, number> = { question: 0, working: 1 };
  return order[inFlightBand(a)] - order[inFlightBand(b)] || byCreatedAtDesc(a, b);
}

export function byClosedAtDesc(a: KanbanCard, b: KanbanCard): number {
  const aT = instantMs(a.closedAt) ?? instantMs(a.createdAt);
  const bT = instantMs(b.closedAt) ?? instantMs(b.createdAt);
  return descByKey(aT, bT) || byCardIdentity(a, b);
}

export function byDueAtAsc(a: KanbanCard, b: KanbanCard): number {
  // Soonest first. A standing constitution sorts by its next launch (an instant); a
  // dated card by the civil day its `due:` names, keyed to local midnight so
  // the two are comparable on one axis.
  const aT = a.nextLaunchAt ? instantMs(a.nextLaunchAt) : dueSortMs(a.due);
  const bT = b.nextLaunchAt ? instantMs(b.nextLaunchAt) : dueSortMs(b.due);
  return ascByKey(aT, bT) || byCardIdentity(a, b);
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
