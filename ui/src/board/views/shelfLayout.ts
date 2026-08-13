/**
 * shelfLayout — where a card sits, and why.
 *
 * The Shelf has two kinds of card and the whole module is about keeping them
 * apart:
 *
 *   FLOWED   the surface arranges it. Order is a LENS — recency or fiber —
 *            and the card's position is a consequence of that lens, so it
 *            moves when the lens changes and when new work lands.
 *   PLACED   you arranged it. It carries an exact x/y/w/h that survives a
 *            reflow, a lens switch and a reload, because a position you chose
 *            is data and a position the layout chose is not.
 *
 * A card becomes placed by being dragged, resized, or STARRED — a star is
 * "hold this where it is", and it captures the geometry the flow had just
 * given it. Unstarring a card that was never moved by hand hands it back to
 * the flow. That is why the star lives in the same record as the geometry
 * rather than in a set beside it.
 *
 * Pure: no DOM, no storage side effects beyond the two localStorage helpers at
 * the bottom, which swallow their own failures the way FiberDetailModal's do.
 */

import type { ShelfFile } from './shelfData.js'

/** The lens — how flowed cards are ordered on the surface. */
export type ShelfLens = 'recency' | 'fiber'

/** One card's remembered state. Geometry present ⇒ the card is placed. */
export interface ShelfCardState {
  x?: number
  y?: number
  w?: number
  h?: number
  starred?: boolean
}

export interface ShelfPersist {
  lens: ShelfLens
  /** The surface's pan offset, so the canvas reopens where you left it. */
  pan: { x: number; y: number }
  cards: Record<string, ShelfCardState>
}

export const SHELF_PERSIST_KEY = 'shuttle:shelf'

export function emptyPersist(): ShelfPersist {
  return { lens: 'recency', pan: { x: 0, y: 0 }, cards: {} }
}

/** Is this card placed by hand (or held down by a star)? */
export function isPlaced(state: ShelfCardState | undefined): boolean {
  return !!state && num(state.x) !== null && num(state.y) !== null
}

// ── Flow ─────────────────────────────────────────────────────────────────────

export interface ShelfMetrics {
  /** Usable width of the surface, in px. */
  width: number
  cardW: number
  cardH: number
  gap: number
  /** Height of a fiber caption line, in the fiber lens. */
  captionH: number
}

export const SHELF_METRICS: ShelfMetrics = {
  width: 1200,
  cardW: 268,
  cardH: 212,
  gap: 20,
  captionH: 26,
}

export interface PlacedCard {
  file: ShelfFile
  x: number
  y: number
  w: number
  h: number
  /** True when the position came from the user, not from the flow. */
  pinned: boolean
  starred: boolean
}

export interface ShelfCaption {
  /** The fiber slug, or '' for files that never named one. */
  uid: string
  label: string
  x: number
  y: number
  width: number
}

export interface ShelfLayout {
  cards: PlacedCard[]
  captions: ShelfCaption[]
  /** Total surface extent, so the viewport knows how far it may pan. */
  height: number
  width: number
}

/**
 * Lay the shelf out.
 *
 * Flowed cards fill left-to-right, top-to-bottom, so RECENCY HAS A DIRECTION:
 * the newest thing enters at the top-left and older work migrates right and
 * down. Starred-but-unplaced cards sort ahead of the rest — a star that has
 * lost its geometry (a hand-edited store, a card that came back after being
 * cleared) still reads as "this one first" rather than silently becoming
 * ordinary.
 *
 * Placed cards are drawn at their own coordinates and take no part in the
 * flow — they float over it. Reserving flow slots around them was the other
 * option and it is worse: a pinned card would then push its neighbours around
 * every time the fleet sent a file, which is the opposite of what pinning it
 * was for.
 */
export function layoutShelf(
  files: readonly ShelfFile[],
  lens: ShelfLens,
  states: Record<string, ShelfCardState>,
  metrics: ShelfMetrics = SHELF_METRICS,
): ShelfLayout {
  const { cardW, cardH, gap, captionH } = metrics
  const columns = Math.max(1, Math.floor((metrics.width + gap) / (cardW + gap)))
  const cards: PlacedCard[] = []
  const captions: ShelfCaption[] = []

  const flowed: ShelfFile[] = []
  for (const file of files) {
    const state = states[file.fullPath]
    if (isPlaced(state)) {
      cards.push({
        file,
        x: num(state!.x) ?? 0,
        y: num(state!.y) ?? 0,
        w: num(state!.w) ?? cardW,
        h: num(state!.h) ?? cardH,
        pinned: true,
        starred: state!.starred === true,
      })
    } else {
      flowed.push(file)
    }
  }

  const starred = (f: ShelfFile): boolean => states[f.fullPath]?.starred === true
  const byRecency = (a: ShelfFile, b: ShelfFile): number =>
    (starred(b) ? 1 : 0) - (starred(a) ? 1 : 0) ||
    b.timestamp - a.timestamp ||
    a.fullPath.localeCompare(b.fullPath)

  const colX = (i: number): number => (i % columns) * (cardW + gap)
  const rowY = (i: number): number => Math.floor(i / columns) * (cardH + gap)

  let bottom = 0
  if (lens === 'recency') {
    const ordered = [...flowed].sort(byRecency)
    ordered.forEach((file, i) => {
      cards.push({
        file, x: colX(i), y: rowY(i), w: cardW, h: cardH,
        pinned: false, starred: starred(file),
      })
    })
    bottom = ordered.length ? rowY(ordered.length - 1) + cardH : 0
  } else {
    // Fiber lens: one band per fiber, bands ordered by their own most recent
    // send, so the group you touched last is still the group at the top. The
    // band a file with no fiber falls into sorts last and is captioned for
    // what it is, not left unlabelled.
    const groups = new Map<string, ShelfFile[]>()
    for (const file of flowed) {
      const key = file.uid ?? ''
      const list = groups.get(key)
      if (list) list.push(file)
      else groups.set(key, [file])
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === '') return 1
      if (b === '') return -1
      const newest = (k: string): number =>
        Math.max(...groups.get(k)!.map((f) => f.timestamp))
      return newest(b) - newest(a) || a.localeCompare(b)
    })
    let y = 0
    for (const key of keys) {
      const group = groups.get(key)!.sort(byRecency)
      captions.push({
        uid: key,
        label: key || 'unattributed',
        x: 0,
        y,
        width: metrics.width,
      })
      y += captionH
      group.forEach((file, i) => {
        cards.push({
          file, x: colX(i), y: y + rowY(i), w: cardW, h: cardH,
          pinned: false, starred: starred(file),
        })
      })
      y += rowY(group.length - 1) + cardH + gap * 2
      bottom = y - gap
    }
  }

  // The surface must be big enough for the furthest thing on it — including a
  // card someone dragged far off to one side.
  let width = columns * (cardW + gap) - gap
  let height = bottom
  for (const card of cards) {
    width = Math.max(width, card.x + card.w)
    height = Math.max(height, card.y + card.h)
  }
  return { cards, captions, width, height }
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Read the remembered shelf. Best-effort in exactly the sense the detail
 * panel's store is: a missing, unreadable or half-written record is a shelf
 * with nothing remembered, never an error — the canvas must open either way.
 */
export function loadShelfPersist(storage?: Storage): ShelfPersist {
  const store = storage ?? safeStorage()
  if (!store) return emptyPersist()
  try {
    const raw = store.getItem(SHELF_PERSIST_KEY)
    if (!raw) return emptyPersist()
    return coercePersist(JSON.parse(raw))
  } catch {
    return emptyPersist()
  }
}

export function saveShelfPersist(state: ShelfPersist, storage?: Storage): void {
  const store = storage ?? safeStorage()
  if (!store) return
  try {
    store.setItem(SHELF_PERSIST_KEY, JSON.stringify(state))
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}

/** Coerce a parsed record into a persist, field by field. Exported for the
 *  round-trip test, which is the only way to be sure a store written by an
 *  older shelf still opens. */
export function coercePersist(parsed: unknown): ShelfPersist {
  const out = emptyPersist()
  if (!parsed || typeof parsed !== 'object') return out
  const rec = parsed as Record<string, unknown>
  if (rec.lens === 'fiber' || rec.lens === 'recency') out.lens = rec.lens
  const pan = rec.pan
  if (pan && typeof pan === 'object') {
    const p = pan as Record<string, unknown>
    out.pan = { x: num(p.x) ?? 0, y: num(p.y) ?? 0 }
  }
  const cards = rec.cards
  if (cards && typeof cards === 'object' && !Array.isArray(cards)) {
    for (const [path, value] of Object.entries(cards as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue
      const c = value as Record<string, unknown>
      const state: ShelfCardState = {}
      const x = num(c.x), y = num(c.y), w = num(c.w), h = num(c.h)
      // Geometry is all-or-nothing: half a position is not a placement, and
      // storing one would place the card at an axis it never chose.
      if (x !== null && y !== null) { state.x = x; state.y = y }
      if (w !== null && h !== null) { state.w = w; state.h = h }
      if (c.starred === true) state.starred = true
      if (Object.keys(state).length > 0) out.cards[path] = state
    }
  }
  return out
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
