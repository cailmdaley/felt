/**
 * The Chronicle's row model: which fiber an activity bucket belongs to, which
 * civil day it lands on, the cycle bands above the rows, the look-back's
 * narration, and each fiber's row. Pure: no DOM, no fetch, no clock read — the
 * view hands in `now` and the zone.
 */

import {
  buildJoinIndex,
  joinBucket,
  type LedgerNarration,
} from './join.js'
import {
  cardState,
  sumDiff,
  type DiffTotal,
  type LifecycleState,
} from './vocabulary.js'
import {
  isOriginStale,
  type ActivityBucket,
  type SessionPairing,
  type TemporalOrigins,
} from './TemporalData.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import { hasLiveWorker } from '../KanbanTypes.js'
import type { TimelineDay } from '../KanbanSurfaces.js'
import {
  civilDayAt,
  dueCivilDay,
  dueSortMs,
  hostZone,
  instantMs,
  isoDayLocal,
  RAIL_START_HOUR,
  railBounds,
  railCivilDay,
  railDayReader,
  DAY_MS,
  type Zone,
} from '../civilDay.js'
import { cycleSpan } from '../KanbanRules.js'
import { restingCards } from '../KanbanReadModel.js'

/**
 * The page speaks in 6am RAILS, not midnights — the same day-boundary the rest
 * of the board uses, so no two surfaces disagree about which day it is.
 *
 * This matters for more than the seam. A rail is "work that runs past midnight
 * belongs to the day it started", so a 01:00 push is yesterday's — and if only
 * `isToday` moved to the rail while activity stayed on calendar days, then
 * every night between midnight and 6am the page would ink solid marks one
 * column PAST its own today line, on a page whose rule is that the future
 * carries no solid ink. Columns are still LABELLED by calendar date, because
 * that is what a rail is named by: the date it opened on. The boundary itself
 * is `RAIL_START_HOUR` in ../civilDay.js, which `railCivilDay` defaults to.
 */

/** Noon of the current rail's day — "now" for a cycle band, anchored at noon
 *  so it sits squarely inside the rail's column whatever the hour. */
export function railNoonMs(nowMs: number, z: Zone = hostZone()): number {
  return civilDayAt(railCivilDay(nowMs, RAIL_START_HOUR, z), 12, z) ?? nowMs
}

// ── Join + aggregation ───────────────────────────────────────────────────────

/**
 * Place each activity bucket on the fiber the session ledger recorded for it.
 *
 * The ladder and its refusals live in `./join.js`, one place that says whose
 * minute a minute was. Buckets
 * that join nothing are dropped here: the chronicle has no row to draw them on.
 */
export function attributeActivity(
  buckets: readonly ActivityBucket[],
  cards: readonly KanbanCard[],
  byTmux?: ReadonlyMap<string, SessionPairing>,
): Map<string, ActivityBucket[]> {
  const index = buildJoinIndex(cards, byTmux)
  const byCard = new Map<string, ActivityBucket[]>()
  for (const bucket of buckets) {
    const card = joinBucket(index, bucket)
    if (!card) continue
    const list = byCard.get(card.id)
    if (list) list.push(bucket)
    else byCard.set(card.id, [bucket])
  }
  return byCard
}

/** One civil day's worth of one row's activity. */
export interface DayCell {
  /** Summed `n` over the day's agent buckets — the density signal. */
  agent: number
  attention: number
}

/**
 * Fold buckets into civil days by their LOCAL day. Never by `m / 86_400_000`:
 * a fixed-ms floor is a UTC day, which is the wrong day for half of every
 * evening west of Greenwich and half of every morning east of it, and which
 * mis-slices the 23- and 25-hour days at a DST transition.
 */
export function aggregateByCivilDay(
  buckets: readonly ActivityBucket[],
  z: Zone = hostZone(),
): Map<string, DayCell> {
  const out = new Map<string, DayCell>()
  const railDay = railDayReader(z)
  for (const b of buckets) {
    if (!Number.isFinite(b.m)) continue
    const day = railDay(b.m)
    let cell = out.get(day)
    if (!cell) {
      cell = { agent: 0, attention: 0 }
      out.set(day, cell)
    }
    const n = Number.isFinite(b.n) ? Math.max(b.n, 1) : 1
    if (b.k === 'agent') cell.agent += n
    else if (b.k === 'attention') cell.attention += n
    // `notify` and `reply` fold into nothing: neither is a state of the work.
    // A reply's minute is already inked by its agent bucket, and a notify is
    // an idle nudge the board draws nowhere.
  }
  return out
}

/**
 * A contiguous run of worked minutes inside one rail day — the strip the
 * chronicle actually draws. Two buckets more than {@link SPELL_GAP_MS} apart
 * start separate spells, so a morning of steering and an evening agent run
 * read as two periods of use with air between them, not one day-long claim.
 * A spell does not ask who was at the keyboard — both kinds of minute are
 * one claim, "work happened here".
 */
export interface DaySpell {
  /** First active minute, epoch ms. */
  startMs: number
  /** One past the last active minute, epoch ms. */
  endMs: number
  /** Summed `n` across the spell's buckets — the height signal. */
  work: number
  /** Distinct active minutes — the tooltip's honest figure. */
  minutes: number
}

/** Two active minutes this far apart still belong to one period of use.
 *  45 minutes: a coffee, a meeting — the sitting resumes; anything longer
 *  reads as coming back to the work rather than staying at it. */
export const SPELL_GAP_MS = 45 * 60_000

const MINUTE_MS = 60_000

/**
 * Fold buckets into per-rail-day SPELLS — where inside the day the work sat,
 * not just that the day was worked. Same rail-day discipline as
 * {@link aggregateByCivilDay}, same two kinds folded into one claim.
 */
export function spellsByCivilDay(
  buckets: readonly ActivityBucket[],
  z: Zone = hostZone(),
): Map<string, DaySpell[]> {
  const byDay = new Map<string, ActivityBucket[]>()
  const railDay = railDayReader(z)
  for (const b of buckets) {
    if (!Number.isFinite(b.m)) continue
    if (b.k !== 'agent' && b.k !== 'attention') continue
    const day = railDay(b.m)
    const list = byDay.get(day)
    if (list) list.push(b)
    else byDay.set(day, [b])
  }
  const out = new Map<string, DaySpell[]>()
  for (const [day, list] of byDay) {
    list.sort((a, b) => a.m - b.m)
    const spells: DaySpell[] = []
    for (const b of list) {
      const n = Number.isFinite(b.n) ? Math.max(b.n, 1) : 1
      const last = spells[spells.length - 1]
      if (last && b.m - last.endMs <= SPELL_GAP_MS) {
        // Same minute twice (an agent bucket and an attention bucket share
        // `m`) grows the work but not the clock.
        if (b.m + MINUTE_MS > last.endMs) {
          last.minutes += 1
          last.endMs = b.m + MINUTE_MS
        }
        last.work += n
      } else {
        spells.push({ startMs: b.m, endMs: b.m + MINUTE_MS, work: n, minutes: 1 })
      }
    }
    out.set(day, spells)
  }
  return out
}

/** The strip's height floor and ceiling. The floor is thick enough that the
 *  faintest spell is still a mark, not a hairline; the ceiling stops short of
 *  `--chr-row-h` (32px) so the busiest spell still floats in the row's air
 *  rather than fencing it. */
export const SPELL_MIN_H = 4
export const SPELL_MAX_H = 24

/**
 * A spell's height in px: log-scaled between floor and ceiling, relative to
 * the busiest spell anywhere in the window. Log rather than linear because
 * spell work is heavy-tailed — one 400-minute fan-out afternoon would
 * otherwise flatten every ordinary sitting onto the floor. Relative rather
 * than absolute because "busy" is a property of the window you are looking at.
 */
export function spellHeight(work: number, peak: number): number {
  if (work <= 0 || peak <= 0) return SPELL_MIN_H
  const frac = Math.min(Math.log1p(work) / Math.log1p(peak), 1)
  return SPELL_MIN_H + (SPELL_MAX_H - SPELL_MIN_H) * frac
}

/**
 * Where inside its rail day an instant sits, 0..1. The rail opens at 6am of
 * the day it is named for ({@link RAIL_START_HOUR}), so 6am → 0 and the next
 * 6am → 1. A DST rail is 23 or 25 hours long, and the fraction is of that.
 */
export function railFrac(ms: number, day: string): number {
  const { startMs, endMs } = railBounds(day)
  if (endMs <= startMs) return 0
  return clamp((ms - startMs) / (endMs - startMs), 0, 1)
}

// ── Cycles ───────────────────────────────────────────────────────────────────
//
// A cycle is a fiber tagged `cycle` carrying a `start:` and a `due:`, both civil
// days. It is drawn as a named band across the days it spans — annotation over
// the record, not another row of data.

/**
 * What a band needs off a cycle card. Narrow on purpose: it lets an
 * optimistically drawn cycle — one that exists only in this session, between
 * the create and the poll that confirms it — be the same shape as a real one.
 */
export type CycleCard = Pick<KanbanCard, 'id' | 'name' | 'cycleStart' | 'due' | 'originId'>

/** A cycle placed on the day grid. */
export interface CycleBand {
  id: string
  name: string
  /** Whose daemon owns this cycle — the routing key for an edge or a review. */
  originId: string
  /** Inclusive day-column range, clamped to the window. */
  startIdx: number
  endIdx: number
  /** The real span reaches past this edge of the window — the band is drawn
   *  running off, rather than pretending the cycle begins or ends here. */
  openStart: boolean
  openEnd: boolean
  /** Sub-lane within the cycle strip; 0 is closest to the day headers. */
  lane: number
  /** Not yet confirmed by a poll — drawn immediately after a create. */
  pending?: boolean
}

/**
 * The NAME an era gets when it was spoken rather than named.
 *
 * A spoken era arrives as a paragraph — its ontology, its goal, what drives it,
 * what constrains it. The band on the strip is one capsule wide, so it needs a
 * handle, and the handle is the opening clause: the first sentence, or the
 * first line, whichever ends sooner, clipped at the width a band can carry.
 * The prose itself is not summarized away — it becomes the fiber's body, which
 * is where the era's intention is read from.
 */
export function eraName(prose: string): string {
  const first = prose.trim().split('\n')[0] ?? ''
  const sentence = /^(.+?[.!?])(?:\s|$)/.exec(first)
  const head = (sentence ? sentence[1] : first).trim().replace(/[.!?,;:]+$/, '')
  if (head.length <= 64) return head
  const cut = head.slice(0, 64)
  const space = cut.lastIndexOf(' ')
  return `${(space > 24 ? cut.slice(0, space) : cut).trim()}…`
}

/** Cycles stack this deep before overflow starts sharing a lane. */
const MAX_CYCLE_LANES = 3

/**
 * Place one cycle card on the day grid, or null when it misses the window.
 *
 * The two civil days come from `cycleSpan` (KanbanRules) rather than being
 * re-derived here, so the awkward cases have one owner across the views: a
 * cycle with only an end is a SINGLE DAY, and one with only a start runs to
 * today and is open-ended. That second case is also the state a freshly drawn
 * cycle passes through between its two writes.
 *
 * CIVIL DAYS COMPARE AS STRINGS HERE, and that is safe in a way instants never
 * are: these are bare `YYYY-MM-DD` values, fixed-width and offset-free, so
 * lexicographic order IS calendar order. The prohibition in ../civilDay.ts is
 * about INSTANTS, whose offsets make a string compare order by wall clock. The
 * comparison is needed because `dayIndex.get` cannot tell "before the window"
 * from "after" — both are simply absent, and they clamp to opposite edges.
 */
export function readCycleBand(
  card: CycleCard,
  days: readonly TimelineDay[],
  dayIndex: Map<string, number>,
  nowMs: number = railNoonMs(Date.now()),
): Omit<CycleBand, 'lane'> | null {
  const first = days[0]?.iso
  const last = days[days.length - 1]?.iso
  if (first === undefined || last === undefined) return null

  const span = cycleSpan({ start: card.cycleStart ?? undefined, due: card.due }, nowMs)
  if (!span) return null
  if (span.end < first || span.start > last) return null // wholly outside the window

  const startsBefore = span.start < first
  const endsAfter = span.end > last
  const startIdx = startsBefore ? 0 : (dayIndex.get(span.start) ?? 0)
  const endIdx = Math.max(
    endsAfter ? days.length - 1 : (dayIndex.get(span.end) ?? days.length - 1),
    startIdx,
  )

  return {
    id: card.id,
    name: card.name,
    originId: card.originId,
    startIdx,
    endIdx,
    openStart: startsBefore,
    // Both readings draw the same open edge, and both are the same claim: this
    // band does not stop here. Either it runs past the window, or it has no
    // declared end and is still running.
    openEnd: endsAfter || span.openEnded,
  }
}

/**
 * Greedy interval partitioning: each cycle takes the first lane whose last band
 * has already ended. Sorted by start so the greedy choice is optimal in lane
 * count — the classic result — which matters because lanes are vertical space
 * on a page whose whole argument is density.
 *
 * Past {@link MAX_CYCLE_LANES} the strip would out-shout the lifelines it
 * annotates, so overflow joins the lane that frees up soonest and may visually
 * touch its neighbour. Overlapping is the lesser harm: a cycle silently omitted
 * from a page you draw cycles on is worse than two that crowd.
 */
export function assignCycleLanes<T extends { startIdx: number; endIdx: number }>(
  bands: readonly T[],
  maxLanes: number = MAX_CYCLE_LANES,
): Array<T & { lane: number }> {
  const ordered = [...bands].sort((a, b) => a.startIdx - b.startIdx || b.endIdx - a.endIdx)
  const laneEnds: number[] = []
  const out: Array<T & { lane: number }> = []
  for (const band of ordered) {
    let lane = laneEnds.findIndex((end) => end < band.startIdx)
    if (lane === -1) {
      if (laneEnds.length < maxLanes) {
        lane = laneEnds.length
        laneEnds.push(band.endIdx)
      } else {
        lane = laneEnds.indexOf(Math.min(...laneEnds))
        laneEnds[lane] = Math.max(laneEnds[lane], band.endIdx)
      }
    } else {
      laneEnds[lane] = band.endIdx
    }
    out.push({ ...band, lane })
  }
  return out
}

/**
 * A cycle drawn this session, held until the daemon's feed carries it.
 *
 * `id` is the fiber id the create endpoint answered with. It is the whole
 * difference between a band that is a picture and a band that is a cycle: with
 * it the ghost carries the SAME id the served card will, so entering the era,
 * reading its face and fetching its intention all work immediately. Without it
 * — the seconds between the drag and the create's answer — there is nothing on
 * disk to enter, and the band is drawn as `pending` and does not respond.
 */
export interface PendingCycle {
  name: string
  startDay: string
  endDay: string | null
  /** Set the moment the create returns; undefined only while it is in flight. */
  id?: string
}

/**
 * Which optimistic cycles are still worth drawing.
 *
 * A ghost retires when the served feed carries the same cycle — matched by ID
 * first, because that is the identity the daemon and the create response agree
 * on. The NAME fallback covers the ghost whose create has not answered yet, and
 * the older store where a create returned no id at all.
 *
 * Matching by name alone was the defect: the feed is polled, so a ghost stayed
 * on the strip for up to a poll interval after its fiber existed, and a ghost
 * cannot be clicked. The band was drawn, dated and named, and did nothing.
 */
export function retirePendingCycles(
  pending: readonly PendingCycle[],
  served: readonly Pick<CycleCard, 'id' | 'name'>[],
): PendingCycle[] {
  const ids = new Set(served.map((c) => c.id))
  const names = new Set(served.map((c) => c.name))
  return pending.filter((p) => !(p.id !== undefined && ids.has(p.id)) && !names.has(p.name))
}

/** Every cycle on the grid, lane-assigned and in drawing order. */
export function buildCycleBands(
  cards: readonly CycleCard[],
  days: readonly TimelineDay[],
  dayIndex: Map<string, number>,
  nowMs: number = railNoonMs(Date.now()),
): CycleBand[] {
  const placed: Array<Omit<CycleBand, 'lane'>> = []
  for (const card of cards) {
    const band = readCycleBand(card, days, dayIndex, nowMs)
    if (band) placed.push(band)
  }
  return assignCycleLanes(placed)
}

// ── The look-back ────────────────────────────────────────────────────────────

export interface NarrationGroup {
  /** The fiber that made these commits — the row's click target. */
  cardId: string
  name: string
  count: number
  subjects: string[]
  /** What those commits changed, as the ledger recorded it. Carried beside the
   *  count because the two are the same fact at two grains — how many times the
   *  fiber spoke, and how much it moved. */
  insertions: number
  deletions: number
}

/**
 * The span's commit trail, gathered under the fiber that made each commit.
 *
 * The grouping is the COMMIT LEDGER's attribution: a hook recorded which
 * harness session each commit came out of, and the session ledger names that
 * session's fiber. So every row here opens the fiber it names, exactly — no
 * subject line is read for identity, and a commit the ledger cannot place is
 * not in the look back at all.
 */
export function groupNarration(
  ledger: LedgerNarration,
  cards: readonly KanbanCard[],
  limit = 4,
): NarrationGroup[] {
  const byId = new Map(cards.map((card) => [card.id, card]))
  const groups: NarrationGroup[] = []
  for (const [cardId, fiber] of ledger.byCard) {
    const card = byId.get(cardId)
    if (!card) continue
    groups.push({
      cardId,
      name: card.name,
      count: fiber.commits,
      // DISTINCT subjects. A run of identical messages is one thing said many
      // times — the count already carries "many", and repeating the sentence
      // three times turns a memoir into a stutter.
      subjects: [...new Set<string>(fiber.subjects)].slice(0, 2),
      // Trimming what is SAID must not trim what is COUNTED: the totals are the
      // whole group's, not the two subjects that survived the slice.
      insertions: fiber.insertions,
      deletions: fiber.deletions,
    })
  }
  return groups.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit)
}

/**
 * What each row's fiber changed in the rendered window, from the ledger alone.
 *
 * Recorded evidence only. The map carries an entry for a row only when the
 * join actually resolved commits onto its card inside the window — a row the
 * ledger cannot speak for is ABSENT rather than present with zeros, so the
 * gutter can tell "nothing recorded" from "recorded no change" and print
 * nothing at all for both without inventing a `+0 −0`. Nothing is read from a
 * subject-line prefix, and a row with no `cardId` has no fiber to ask about.
 */
export function rowDiffTotals(
  ledger: LedgerNarration,
  rows: readonly { cardId?: string }[],
): Map<string, DiffTotal> {
  const out = new Map<string, DiffTotal>()
  for (const row of rows) {
    if (!row.cardId) continue
    const fiber = ledger.byCard.get(row.cardId)
    if (!fiber || fiber.commits === 0) continue
    // `sumDiff` over the single joined fiber: the join has already folded that
    // fiber's commits (de-duplicated by sha across hosts) into one total, so
    // this is the same arithmetic said once rather than twice.
    const total = sumDiff([fiber])
    if (total.insertions === 0 && total.deletions === 0) continue
    out.set(row.cardId, total)
  }
  return out
}

/** Everything the gutter's figures could read off a ledger, as one string —
 *  so a second commit landing inside the same window still repaints. */
export function ledgerDigest(ledger: LedgerNarration | null): string {
  if (!ledger) return ''
  const parts: string[] = []
  for (const [cardId, fiber] of ledger.byCard) {
    parts.push(`${cardId}=${fiber.commits}/${fiber.insertions}/${fiber.deletions}`)
  }
  return parts.sort().join(',')
}

/** The first paragraph of a fiber body — the cycle's intention, as written. */
export function firstParagraph(body: string | undefined): string {
  if (!body) return ''
  for (const block of body.replace(/\r/g, '').split(/\n\s*\n/)) {
    const text = block
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('---'))
      .join(' ')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * The body out of a fiber-document response.
 *
 * The endpoint answers with the LIST envelope — `{ fibers: [{ fiber: {…} }] }`
 * — and the body rides the fiber object, only when the request asked for it
 * (`?body=1`).
 */
export function fiberBodyOf(doc: unknown): string | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined
  const body = (doc as { fibers?: Array<{ fiber?: { body?: unknown } }> }).fibers?.[0]?.fiber?.body
  return typeof body === 'string' && body.trim() ? body : undefined
}

// ── Row model ────────────────────────────────────────────────────────────────

export interface ChronicleRow {
  key: string
  label: string
  /** Tiny mono note under the name's right edge: the owning host. */
  note: string
  /** The host this row is WAITING ON — set only when the fiber is wholly owned
   *  by a remote origin whose read is stale. Null is the ordinary case, and it
   *  is also what a thin window says: data that simply has not arrived is not
   *  an error, so nothing but a stale origin lights this. */
  waitingOn: string | null
  /** Where the fiber stands, drawn as a glyph before the name. */
  state: LifecycleState
  cardId?: string
  days: Map<string, DayCell>
  /** The same days as sub-day spells — where inside each day the work sat. */
  spells: Map<string, DaySpell[]>
  /** Inclusive day-column range the solid lifeline covers. Never past today. */
  startIdx: number
  endIdx: number
  /**
   * Where the close actually HAPPENED, which is not the same question as where
   * the lifeline ends. Null when the fiber is open, when the close carries no
   * date, or when it landed outside the window — and a null suppresses the
   * mark rather than defaulting it, the way `dueIdx`/`launchIdx` already do.
   * Stamping ✓ on today because we could not place the real close is the view
   * asserting something it does not know.
   */
  closeIdx: number | null
  live: boolean
  closed: boolean
  /** Discarded (`tempered === false`) closes get ✗; everything else ✓. */
  closedOk: boolean
  dueIdx: number | null
  launchIdx: number | null
  /** Whose daemon owns this fiber — routing for the due-mark drag's write,
   *  the row's own twin of `CycleBand.originId`. Undefined for a row with no
   *  `cardId` (there is nothing to write back to). */
  originId?: string
  /** Ordering rank: most-recent evidence of actual work, or due-pressure
   *  standing in for it. See `buildFiberRow` for what feeds it. */
  sortMs: number
  /** Creation time, kept ONLY as the last-resort tiebreak among rows with no
   *  work and no due signal (`sortMs === 0`) — never mixed into `sortMs`
   *  itself, or a freshly-touched, never-worked fiber floats to the top on
   *  `createdAt` alone. */
  createdMs: number
}

/** The owning host, as a bare name. Origin first (it is what the board keys
 *  freshness by), then the daemon's own host, then the fiber's dispatch host —
 *  each rung only consulted when the one above says the uninformative `local`. */
function hostLabel(card: KanbanCard, response: KanbanResponse): string {
  const origin = response.staleness?.[card.originId]?.hostname ?? card.originId
  if (origin && origin !== 'local') return origin.toLowerCase()
  if (response.feltHost && response.feltHost !== 'local') return response.feltHost.toLowerCase()
  return (card.shuttleHost ?? 'local').toLowerCase()
}

/**
 * The host a row is waiting on, or null.
 *
 * WHOLLY REMOTE ONLY. A locally-owned fiber is read from this daemon, which
 * answers for itself, so nothing about a remote's freshness may gray it. A
 * remote-owned one has exactly one source, and when that source's last read is
 * stale the whole row — lifeline, ink and marks — is last-known-good rather
 * than current, which is what the muted register says.
 *
 * The origins block is keyed by ORIGIN NAME, and the board knows the same
 * origin by two spellings (the card's origin and the hostname the staleness
 * block reports). Both are tried; the label is what the reader sees either
 * way.
 */
export function rowWaitingOn(
  card: Pick<KanbanCard, 'originId'>,
  hostname: string,
  origins: TemporalOrigins,
): string | null {
  if (card.originId === 'local') return null
  const keys = [card.originId, hostname]
  return keys.some((key) => isOriginStale(origins, key)) ? hostname : null
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * The snap math a horizontal drag on this page shares — the cycle edges, the
 * cycle draw gesture, and the due-mark reschedule all convert a cursor
 * position into a day column the same way. Pulled out of `dayAt` so the
 * arithmetic can be pinned by a test without a DOM.
 *
 * Clamped, never out of range: a cursor that has strayed past either end of
 * the strip still names the nearest column, exactly like `dayAt` always has.
 */
export function columnIndexAtX(
  clientX: number,
  trackLeft: number,
  dayWidthPx: number,
  dayCount: number,
): number {
  if (dayCount <= 0) return 0
  const w = dayWidthPx || 1
  return clamp(Math.floor((clientX - trackLeft) / w), 0, dayCount - 1)
}

/**
 * Overlay pending due-mark drags on top of the daemon's cards, and say which
 * ones the daemon has now confirmed — the same "held until echoed" contract
 * {@link collectBands} already keeps for a cycle edge (see its `cycleEdits`
 * overlay). A confirmed edit is retired: the served card's `due` already
 * agrees, so holding the local patch any longer risks masking a LATER change
 * (a second drag, or a hand edit elsewhere) behind a stale optimistic value.
 *
 * Pure and DOM-free on purpose — this is the "date computation" half of the
 * due-mark drag, and it is what a test can pin without standing up a page.
 */
export function overlayDueEdits(
  cards: readonly KanbanCard[],
  edits: ReadonlyMap<string, string>,
): { cards: KanbanCard[]; confirmed: string[] } {
  const confirmed: string[] = []
  const next = cards.map((c) => {
    const edit = edits.get(c.id)
    if (edit === undefined) return c
    if (c.due === edit) {
      confirmed.push(c.id)
      return c
    }
    return { ...c, due: edit }
  })
  return { cards: next, confirmed }
}

/** Day-column index for an INSTANT, by its local day. Null when out of window. */
function idxOfInstant(iso: string | undefined, dayIndex: Map<string, number>): number | null {
  const ms = instantMs(iso)
  if (ms === undefined) return null
  return dayIndex.get(isoDayLocal(ms)) ?? null
}

/** Day-column index for a `due:`, by the civil day it names. */
export function idxOfDue(due: string | undefined, dayIndex: Map<string, number>): number | null {
  const day = dueCivilDay(due)
  return day === undefined ? null : (dayIndex.get(day) ?? null)
}

/** What one fiber's line covers, and where its close belongs. */
export interface LifelineExtent {
  startIdx: number
  endIdx: number
  closeIdx: number | null
  closed: boolean
}

/**
 * Resolve a fiber's lifeline against the day columns.
 *
 * The distinction this function exists to hold: WHERE THE CLOSE HAPPENED
 * (`closeIdx`, which may be unknowable) is not WHERE THE LINE ENDS (`endIdx`,
 * which always has an answer). Collapsing the two is what put a ✓ under today
 * on every fiber closed before the window — the page asserting a close date it
 * did not have.
 *
 * Three closed cases, and only the first may draw a mark:
 *   - a close we can place        → line ends there, mark there.
 *   - a DATED close we cannot place → it is necessarily before the window
 *     (nothing closes in the future), so the line stops at the fiber's start
 *     rather than running to today and claiming a month of work. No mark.
 *   - an UNDATED close            → fall back to today, because we genuinely
 *     know nothing better; a closed fiber can carry a null `closed_at`. No mark.
 *
 * Activity then stretches both ends: a fiber born before the window opened
 * still shows the work it did inside it.
 */
export function lifelineExtent(
  card: Pick<KanbanCard, 'createdAt' | 'closedAt' | 'status'>,
  activityDays: Iterable<string>,
  dayIndex: Map<string, number>,
  todayIdx: number,
): LifelineExtent {
  let startIdx = idxOfInstant(card.createdAt, dayIndex) ?? 0
  const closed = Boolean(card.closedAt) || card.status === 'closed'
  const closeIdx = idxOfInstant(card.closedAt, dayIndex)
  const closedMs = instantMs(card.closedAt)
  let endIdx = closed ? (closeIdx ?? (closedMs !== undefined ? startIdx : todayIdx)) : todayIdx
  for (const day of activityDays) {
    const idx = dayIndex.get(day)
    if (idx === undefined) continue
    if (idx < startIdx) startIdx = idx
    if (idx > endIdx) endIdx = idx
  }
  startIdx = clamp(startIdx, 0, todayIdx)
  endIdx = clamp(Math.max(endIdx, startIdx), 0, todayIdx)
  return { startIdx, endIdx, closeIdx, closed }
}

function buildFiberRow(
  card: KanbanCard,
  buckets: readonly ActivityBucket[],
  response: KanbanResponse,
  dayIndex: Map<string, number>,
  todayIdx: number,
  todayNoonMs: number,
  origins: TemporalOrigins,
): ChronicleRow {
  const days = aggregateByCivilDay(buckets)
  const spells = spellsByCivilDay(buckets)
  const { startIdx, endIdx, closeIdx, closed } = lifelineExtent(
    card,
    days.keys(),
    dayIndex,
    todayIdx,
  )

  // Deliberately NOT `modifiedAt`. It moves on any metadata touch — a due-date
  // tweak, a frontmatter edit — with no work behind it, and letting it into the
  // sort is exactly how an untouched fiber floated above ones actually being
  // worked. Two honest signals stand in instead, each at day granularity so
  // nothing here moves at 15s-poll cadence (a live fiber already floats on its
  // own flag; below that, rows may only reorder once a day):
  //
  //  - workMs: the most recent day this fiber was actually touched — an
  //    activity day, or the day it closed. A fiber finished this morning
  //    ranks at today's noon, same as one still being worked today.
  //  - due pressure: an overdue or due-soon fiber is lent a rank as if it had
  //    been worked that recently, so a fiber going stale under a deadline
  //    surfaces near the top of the unstarted rather than waiting for someone
  //    to touch it. A due date further out lends less; no due date lends
  //    nothing.
  //
  // `sortMs` is the louder of the two, and it alone decides ordering among
  // fibers with real signal. `createdAt` never enters it — see `createdMs`
  // and the comparator below for why a never-worked, no-due fiber sinks
  // instead of floating on how recently it was created.
  let workMs = instantMs(card.closedAt) ?? 0
  for (const day of days.keys()) workMs = Math.max(workMs, civilDayAt(day, 12) ?? 0)

  const dueMs = dueSortMs(card.due)
  let dueMsEquivalent = 0
  if (dueMs !== undefined) {
    const daysUntilDue = Math.round((dueMs - todayNoonMs) / DAY_MS)
    dueMsEquivalent = todayNoonMs - Math.max(0, daysUntilDue) * DAY_MS
  }

  const sortMs = Math.max(workMs, dueMsEquivalent)
  const createdMs = instantMs(card.createdAt) ?? 0

  const host = hostLabel(card, response)

  return {
    key: `fiber:${card.id}`,
    label: card.name,
    note: host,
    waitingOn: rowWaitingOn(card, host, origins),
    state: cardState(card),
    cardId: card.id,
    originId: card.originId,
    days,
    spells,
    startIdx,
    endIdx,
    closeIdx,
    live: hasLiveWorker(card),
    closed,
    closedOk: card.tempered !== false,
    dueIdx: idxOfDue(card.due, dayIndex),
    launchIdx: idxOfInstant(card.nextLaunchAt, dayIndex),
    sortMs,
    createdMs,
  }
}


/**
 * Every row the chronicle draws, in reading order: live fibers, then fibers by
 * most-recent activity.
 *
 * FIBER ROWS ONLY. Activity that joined to no fiber is not drawn: a row named
 * after a working directory teaches the page's unit wrong.
 *
 * The fiber set is "anything with activity in the window" ∪ "anything still
 * open" — the three Now lanes, the two future timeline
 * pools, AND Resting ({@link restingCards}: snoozed work plus a standing constitution
 * asleep on its cron). So an idle-but-open fiber still shows its lifeline, a
 * scheduled one still shows its ◴/◐ in the future region, a snoozed one keeps
 * its promise on the calendar even while parked off the Desk, and a closed one
 * still shows the week it took. Only `timeline.past` is left to the activity
 * join: a finished, tempered fiber earns its row by having actually been
 * worked on in the window.
 *
 * Resting was the gap that let a due-mark drag disappear its own row: a
 * snoozed card's `due` sliding to today or earlier is SUPPOSED to promote it
 * back onto the desk (`effectiveHorizon`'s drift rule), but that
 * reclassification is the daemon's, decided on the NEXT poll — the drag's own
 * optimistic edit (`overlayDueEdits`) only patches the card's `due` for this
 * row, not which surface array it sits in. A workless Resting fiber's only
 * other way onto this page was the activity join, which a workless fiber by
 * definition never wins. Reading `resp.stash` directly here closes that gap
 * without waiting on the poll to referee it.
 */
/**
 * A fiber that finished before this window opened and did nothing inside it.
 *
 * The Now lanes carry closed-but-unreviewed fibers with no age bound, so a
 * fiber closed in January still arrives here in August. With the close mark now
 * suppressed rather than defaulted, such a row would draw a one-day stub at the
 * left edge and nothing else — a line that says only "this exists", on a page
 * about when work happened. It keeps its place on the Desk; it just has no
 * entry in this stretch of the record.
 *
 * Deliberately narrow: an UNDATED close is not silent history (we cannot say
 * when it happened, so it still reads as current), and anything with in-window
 * activity or a future promise has a mark to make.
 */
export function saysNothingHere(
  card: KanbanCard,
  buckets: readonly ActivityBucket[],
  dayIndex: Map<string, number>,
): boolean {
  const closed = Boolean(card.closedAt) || card.status === 'closed'
  if (!closed) return false
  if (instantMs(card.closedAt) === undefined) return false
  if (idxOfInstant(card.closedAt, dayIndex) !== null) return false
  if (idxOfDue(card.due, dayIndex) !== null) return false
  if (idxOfInstant(card.nextLaunchAt, dayIndex) !== null) return false
  // Work inside the window is a mark, whatever the close date says.
  for (const day of aggregateByCivilDay(buckets).keys()) {
    if (dayIndex.has(day)) return false
  }
  return true
}

export function buildRows(
  response: KanbanResponse,
  cards: readonly KanbanCard[],
  attribution: Map<string, ActivityBucket[]>,
  dayIndex: Map<string, number>,
  todayIdx: number,
  todayDay: string,
  origins: TemporalOrigins,
): ChronicleRow[] {
  const todayNoonMs = civilDayAt(todayDay, 12) ?? Date.now()
  const byId = new Map(cards.map((c) => [c.id, c]))
  const include = new Set<string>(attribution.keys())
  for (const card of [
    ...response.now.drafts,
    ...response.now.inFlight,
    ...response.now.awaitingReview,
    ...response.timeline.futureDated,
    // Resting — see the doc comment above this function. `restingCards`
    // already carries `timeline.futureDated` too (a standing constitution asleep on
    // its cron); re-adding those ids here is a harmless no-op on the Set, and
    // calling the one shared function is what keeps this list from drifting
    // out of step with the Desk's own Resting region.
    ...restingCards(response),
    // Seats at rest have their own Desk band, but keep their calendar rows.
    ...response.roles,
  ]) {
    include.add(card.id)
  }

  const fibers: ChronicleRow[] = []
  for (const id of include) {
    const card = byId.get(id)
    if (!card) continue
    const buckets = attribution.get(id) ?? []
    if (saysNothingHere(card, buckets, dayIndex)) continue
    fibers.push(buildFiberRow(card, buckets, response, dayIndex, todayIdx, todayNoonMs, origins))
  }
  fibers.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1
    if (b.sortMs !== a.sortMs) return b.sortMs - a.sortMs
    // Both have no work and no due pressure (sortMs === 0 on each): fall back
    // to creation, so among equally-untouched fibers the newer one sits
    // above the older — but this tier is, by construction, below every row
    // with real signal, never competing with it.
    if (b.createdMs !== a.createdMs) return b.createdMs - a.createdMs
    return a.label.localeCompare(b.label)
  })

  return fibers
}

/** The busiest single SPELL across every row — the scale {@link spellHeight}
 *  maps onto. Measured in the same figure the strip draws (a spell's summed
 *  work), so the normalisation and the mark can never mean two different
 *  things. */
export function peakSpellWork(rows: readonly ChronicleRow[]): number {
  let peak = 0
  for (const row of rows)
    for (const spells of row.spells.values())
      for (const sp of spells) peak = Math.max(peak, sp.work)
  return peak
}

