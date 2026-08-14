/**
 * WHOSE WORK WAS THIS — the one join every temporal view reads.
 *
 * Two things arrive stamped with a tmux session or a harness session: an
 * activity bucket (a minute of work) and a commit ledger record (a commit).
 * Both answer the same question, so both are answered here, once, by the same
 * index. Day, Week and Chronicle import it; none reaches into another.
 *
 * RECORDED EVIDENCE ONLY. The ladder has two rungs and both are things the
 * daemon WROTE DOWN:
 *
 *   0. the session ledger pairs this tmux session with the fiber it was
 *      dispatched for;
 *   1. the session name is exactly a live worker's tmux name, which the board
 *      carries on the card.
 *
 * There is no rung reading a name for a fiber it might mean. A ULID parsed out
 * of a session name and a slug matched against a card's path segments were both
 * tried, and both are inferences from a string somebody typed: a directory
 * names a project, a project is not a fiber, and a leaf slug like `board` is
 * shared by every project that has one. Work that joins no fiber is not drawn
 * at all: this is a board of shuttle work, and a bucket the shuttle never
 * dispatched has nothing to say on it.
 *
 * NEUTRAL MODULE, deliberately. It has no `registerView` side effect, so a view
 * may import it without disturbing the registry's import order (which is tab
 * order — see views/index.ts).
 */

import type { KanbanCard } from '../KanbanTypes.js'
import {
  lookupSession,
  lookupTmux,
  parseCommitSlug,
  type ActivityBucket,
  type CommitRecord,
  type SessionPairing,
} from './TemporalData.js'

/** What a raster tick can honestly say about itself. */
export interface BucketOrigin {
  /** The card the bucket joined. */
  cardId: string
  /** The fiber's name. */
  label: string
  /** The joined fiber carries a `shuttle:` block: constitution-driven work. */
  shuttle: boolean
  /**
   * The harness session UUID this minute belongs to, when the ledger recorded
   * one, and the host that recorded it — the pair a hover needs to ask
   * `/api/v1/moment` for the words.
   *
   * The activity plane holds no text of its own; the ledger's pairing names a
   * transcript, and a transcript does. Null when the bucket joined no recorded
   * session, which is when a hover has to keep saying so.
   */
  source: MomentSource | null
}

/** Where a minute's words would be found: a session, on a host. */
export interface MomentSource {
  session: string
  host: string | null
  /**
   * This session contributed an ATTENTION minute to the mark — it is one of
   * the transcripts a spine is drawn from.
   *
   * The tooltip's words are capped (a hover must not fan out over every
   * transcript a busy slot touched), and the cap used to cut in bucket order,
   * which is arrival order and says nothing about who spoke. A Week slot
   * pooling four sessions could therefore draw a red spine off session three
   * while fetching sessions one and two — a claimed human message the tooltip
   * had no way to surface. This flag is what the cap sorts on, so the sessions
   * behind the spines are the ones that are always asked. See
   * {@link MomentLoader}.
   */
  spoke: boolean
}

/**
 * The cards, indexed by everything a record can name them with.
 *
 * `byUlid` exists only for the ledger pairing's `uid` half: a fiber id is a
 * path and can be moved out from under one, so identity is the fallback when
 * the recorded path no longer resolves.
 */
export interface JoinIndex {
  byId: Map<string, KanbanCard>
  byUlid: Map<string, KanbanCard>
  byWorker: Map<string, KanbanCard>
  /** The session ledger's tmux→fiber pairings, when the board has them. */
  byTmux: ReadonlyMap<string, SessionPairing>
}

/** A card is shuttle-backed iff it has a `shuttle:` block, which is exactly
 *  what `shuttleKind` is present for (KanbanTypes). Not `shuttleAgent`, which
 *  a block may omit. */
export function isShuttleBacked(card: KanbanCard | undefined): boolean {
  return card?.shuttleKind !== undefined
}

export function buildJoinIndex(
  cards: readonly KanbanCard[],
  byTmux: ReadonlyMap<string, SessionPairing> = new Map(),
): JoinIndex {
  const byId = new Map<string, KanbanCard>()
  const byUlid = new Map<string, KanbanCard>()
  const byWorker = new Map<string, KanbanCard>()
  for (const card of cards) {
    byId.set(card.id, card)
    for (const value of [card.uid, card.shuttleFiberId]) {
      const ulid = typeof value === 'string' ? value.trim().toUpperCase() : ''
      if (ulid) byUlid.set(ulid, card)
    }
    if (card.runningWorker) byWorker.set(card.runningWorker, card)
  }
  return { byId, byUlid, byWorker, byTmux }
}

/**
 * The fiber a bucket's minutes belong to, or null when nothing recorded says.
 *
 * HOST-SCOPED. A tmux name is unique within a host, never across the fleet, and
 * the buckets arrive from every daemon at once — so `ada`'s `run-shuttle`
 * minutes must not join the pairing `bob` recorded under the same name.
 * `lookupTmux` reads the scoped key first and falls back to the bare name only
 * for a bucket that cannot say where it ran.
 *
 * A pairing naming a fiber THIS BOARD DOES NOT CARRY falls through to null
 * rather than resolving to nothing halfway: the work is simply not drawn, the
 * same as any other unjoined minute.
 */
export function joinBucket(index: JoinIndex, bucket: Pick<ActivityBucket, 's' | 'host'>): KanbanCard | null {
  if (!bucket.s) return null
  const pairing = lookupTmux(index.byTmux, bucket.host, bucket.s)
  const paired = pairing ? cardForPairing(index, pairing) : null
  if (paired) return paired
  return index.byWorker.get(bucket.s) ?? null
}

/**
 * The card a ledger pairing names, or null when this board does not carry it.
 *
 * BOTH HALVES are tried, in this order: the fiber id, which is the name the
 * ledger wrote; then its ULID, which is identity and survives the fiber being
 * moved out from under that path. Shared by the two joins that read a pairing —
 * a bucket's minute and a commit's attribution — so neither can drift from the
 * other about which fiber a session belongs to.
 */
export function cardForPairing(index: JoinIndex, pairing: SessionPairing): KanbanCard | null {
  const byFiber = index.byId.get(pairing.fiber)
  if (byFiber) return byFiber
  const uid = pairing.uid?.trim().toUpperCase()
  return (uid ? index.byUlid.get(uid) : undefined) ?? null
}

/** What a bucket's tick may say, or null when it joined no fiber and is
 *  therefore not drawn. */
export function originOf(index: JoinIndex, bucket: ActivityBucket): BucketOrigin | null {
  const card = joinBucket(index, bucket)
  if (!card) return null
  return {
    cardId: card.id,
    label: card.name,
    shuttle: isShuttleBacked(card),
    source: momentSource(index, bucket),
  }
}

/**
 * The transcript a bucket points at, from the ledger pairing alone.
 *
 * The bucket's own host is preferred over the ledger's — the bucket is telling
 * us which daemon's events file this minute came out of, which is the machine
 * the transcript sits on.
 */
export function momentSource(index: JoinIndex, bucket: ActivityBucket): MomentSource | null {
  const pairing = lookupTmux(index.byTmux, bucket.host, bucket.s)
  if (!pairing?.session) return null
  return {
    session: pairing.session,
    host: bucket.host ?? pairing.host ?? null,
    spoke: bucket.k === 'attention',
  }
}

// ── The commit ledger ────────────────────────────────────────────────────────
//
// The prose half of a temporal page. A commit is attributed by the harness
// session that made it — a hook wrote that down AT COMMIT TIME — joined through
// the session ledger to a fiber. Nothing here reads the `slug: ` prefix for
// identity, which is the point: a prefix is a convention a human types, and it
// can be mistyped, omitted, or shared by two fibers.

/** What the ledger says one fiber did in the window. */
export interface LedgerFiber {
  /** Subjects with the `slug: ` prefix removed — the prose an entry sets. A
   *  wordless commit contributes none, so this can be shorter than `commits`. */
  subjects: string[]
  /** How many commits the fiber made in the window. */
  commits: number
  insertions: number
  deletions: number
}

/** The ledger resolved onto a page: what each fiber committed. */
export interface LedgerNarration {
  byCard: Map<string, LedgerFiber>
}

/**
 * Resolve a window's ledger commits onto the board's fibers.
 *
 * The join is `commit.session` → the session ledger's pairing → a card, HOST
 * SCOPED the way the bucket join is: a commit stamped with the host it was
 * recorded on may only read a pairing recorded on that same host.
 *
 * A record with no resolvable session, or one naming a fiber this board does
 * not carry, is dropped. Span-agnostic: the caller cuts the records to whatever
 * window its page draws.
 */
export function buildLedgerNarration(
  records: readonly CommitRecord[],
  cards: readonly KanbanCard[],
  bySession: ReadonlyMap<string, SessionPairing> | undefined,
): LedgerNarration {
  const byCard = new Map<string, LedgerFiber>()
  if (!bySession || bySession.size === 0) return { byCard }
  const index = buildJoinIndex(cards)
  const seen = new Set<string>()
  for (const record of records) {
    // The composite can serve one commit twice — a remote's cached read
    // overlapping the local one — and a sha is a sha on every host.
    if (seen.has(record.sha)) continue
    const pairing = lookupSession(bySession, record.host, record.session)
    if (!pairing) continue
    const card = cardForPairing(index, pairing)
    if (!card) continue
    seen.add(record.sha)
    let fiber = byCard.get(card.id)
    if (!fiber) {
      fiber = { subjects: [], commits: 0, insertions: 0, deletions: 0 }
      byCard.set(card.id, fiber)
    }
    fiber.commits += 1
    const { rest } = parseCommitSlug(record.subject)
    if (rest) fiber.subjects.push(rest)
    fiber.insertions += record.insertions
    fiber.deletions += record.deletions
  }
  return { byCard }
}

/** Records inside `[fromMs, toMs)`, by their recorded instant. */
export function ledgerBetween(
  records: readonly CommitRecord[],
  fromMs: number,
  toMs: number,
): CommitRecord[] {
  return records.filter((record) => record.at >= fromMs && record.at < toMs)
}
