/**
 * Where one activity bucket came from — the small join a raster needs to say
 * anything about the ink it drew.
 *
 * A bucket is `{m, s, cwd, k, n}`: a minute, a tmux session name, a working
 * directory, a kind, a count. IT CARRIES NO TEXT. Nothing in the activity plane
 * records what was typed or what a worker said, so nothing downstream of this
 * module may claim to. What it CAN establish is whose work the minute was, and
 * whether that work is being driven by a constitution — which is the honest
 * substance behind both a hover tooltip and a raster that distinguishes
 * shuttle-backed fibers from plain ones.
 *
 * NEUTRAL MODULE, deliberately. It has no `registerView` side effect, so a view
 * may import it without disturbing the registry's import order (which is tab
 * order — see views/index.ts). That is the reason this join lives here rather
 * than being imported from ChronicleView, which owns the fuller
 * `attributeActivity` and whose ladder this one is the two-rung core of. If a
 * third caller ever needs the full ladder, it moves here and Chronicle imports
 * it back.
 */

import type { KanbanCard } from '../KanbanTypes.js'
import type { ActivityBucket, SessionPairing } from './TemporalData.js'
import { cardPathSegments, cardUlids, sessionSlug, sessionUlid } from './sessionNames.js'

/** What a raster tick can honestly say about itself. */
export interface BucketOrigin {
  /** The card the bucket joined, or null when nothing earned it. */
  cardId: string | null
  /** Fiber name when joined; otherwise the session name or the directory —
   *  labelled for what it is, never dressed up as a fiber. */
  label: string
  /** The joined fiber carries a `shuttle:` block: constitution-driven work. */
  shuttle: boolean
}

export interface OriginIndex {
  byWorker: Map<string, string>
  byUlid: Map<string, string>
  /** null marks a token claimed by several cards — ambiguous, unusable. */
  bySlug: Map<string, string | null>
  byId: Map<string, KanbanCard>
  byTmux: ReadonlyMap<string, SessionPairing>
}

/** A card is shuttle-backed iff it has a `shuttle:` block, which is exactly
 *  what `shuttleKind` is present for (KanbanTypes). Not `shuttleAgent`, which
 *  a block may omit. */
export function isShuttleBacked(card: KanbanCard | undefined): boolean {
  return card?.shuttleKind !== undefined
}

export function buildOriginIndex(
  cards: readonly KanbanCard[],
  byTmux: ReadonlyMap<string, SessionPairing> = new Map(),
): OriginIndex {
  const byWorker = new Map<string, string>()
  const byUlid = new Map<string, string>()
  const bySlug = new Map<string, string | null>()
  const byId = new Map<string, KanbanCard>()

  for (const card of cards) {
    byId.set(card.id, card)
    if (card.runningWorker) byWorker.set(card.runningWorker, card.id)
    for (const ulid of cardUlids(card)) byUlid.set(ulid, card.id)
    for (const slug of cardPathSegments(card)) {
      const held = bySlug.get(slug)
      if (held === undefined) bySlug.set(slug, card.id)
      else if (held !== card.id) bySlug.set(slug, null)
    }
  }
  return { byWorker, byUlid, bySlug, byId, byTmux }
}

/**
 * A working directory as a label: a home prefix folds to `~`, anything else
 * keeps its last two segments. There is no `$HOME` in a browser, so the home
 * shapes are matched structurally.
 */
export function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length >= 2 && (parts[0] === 'home' || parts[0] === 'Users')) {
    const rest = parts.slice(2).join('/')
    return rest ? `~/${rest}` : '~'
  }
  if (parts.length <= 2) return `/${parts.join('/')}`
  return `…/${parts.slice(-2).join('/')}`
}

/**
 * Resolve one bucket, strongest evidence first: the session ledger (a recorded
 * pairing), then a live worker's tmux name, then a ULID embedded in the session
 * name, then the session's slug half when it names exactly one card.
 *
 * A DIRECTORY IS NOT A RUNG. A cwd names a project, and a project is not a
 * fiber; attributing by directory tail put one worker's minutes on another
 * fiber's line on real data. Unjoined work keeps its own name (the session, or
 * the directory) and says so.
 */
export function originOf(index: OriginIndex, bucket: ActivityBucket): BucketOrigin {
  const card = resolveCard(index, bucket)
  if (card) return { cardId: card.id, label: card.name, shuttle: isShuttleBacked(card) }
  if (bucket.s) return { cardId: null, label: bucket.s, shuttle: false }
  if (bucket.cwd) return { cardId: null, label: shortCwd(bucket.cwd), shuttle: false }
  return { cardId: null, label: 'unattributed', shuttle: false }
}

function resolveCard(index: OriginIndex, bucket: ActivityBucket): KanbanCard | undefined {
  const { byWorker, byUlid, bySlug, byId, byTmux } = index
  if (bucket.s !== null) {
    const pairing = byTmux.get(bucket.s)
    if (pairing) {
      const direct = byId.get(pairing.fiber)
      if (direct) return direct
      const viaUid = pairing.uid ? byUlid.get(pairing.uid.trim().toUpperCase()) : undefined
      if (viaUid !== undefined) return byId.get(viaUid)
    }
    const worker = byWorker.get(bucket.s)
    if (worker !== undefined) return byId.get(worker)
  }
  const ulid = sessionUlid(bucket.s)
  if (ulid !== null) {
    const hit = byUlid.get(ulid)
    if (hit !== undefined) return byId.get(hit)
  }
  const slug = sessionSlug(bucket.s)
  if (slug !== null) {
    const hit = bySlug.get(slug)
    if (hit) return byId.get(hit)
  }
  return undefined
}
