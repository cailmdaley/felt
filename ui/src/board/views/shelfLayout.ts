/**
 * shelfLayout — where a card sits, and why.
 *
 * The Shelf has two kinds of card and the whole module is about keeping them
 * apart:
 *
 *   FLOWED   the surface arranges it, newest first, left-to-right and down, so
 *            recency has a direction on the canvas.
 *   PLACED   you arranged it. It carries an exact x/y/w/h that survives a
 *            reflow and a reload, because a position you chose is data and a
 *            position the layout chose is not.
 *
 * A card becomes placed by being dragged, resized, or STARRED — a star is
 * "hold this where it is", and it captures the geometry the flow had just
 * given it. Unstarring a card that was never moved by hand hands it back to
 * the flow. That is why the star lives in the same record as the geometry
 * rather than in a set beside it.
 *
 * THE FLOW IS MADE OF STACKS, NOT OF FILES. A fiber that sent ten files is one
 * tile on the surface, ten sheets deep, its newest send face up — see
 * buildStacks. There used to be a lens toggle here (by recency / by fiber) and
 * it is gone: two orderings of the same hundred cards are two ways of being
 * overwhelmed, whereas one tile per fiber is a board you can read across. The
 * ordering the fiber lens existed for — "everything from the shear run
 * together" — is now the shape of the tile itself.
 *
 * Pure: no DOM, no storage side effects beyond the two localStorage helpers at
 * the bottom, which swallow their own failures the way FiberDetailModal's do.
 */

import type { ShelfFile } from './shelfData.js'
import { flowSlots, packShelf, type Rect } from './shelfPack.js'

/** One card's remembered state. Geometry present ⇒ the card is placed. */
export interface ShelfCardState {
  x?: number
  y?: number
  w?: number
  h?: number
  starred?: boolean
}

export interface ShelfPersist {
  /** The surface's pan offset, so the canvas reopens where you left it. */
  pan: { x: number; y: number }
  /** The surface's scale. 1 is native; below it the board is a map of itself. */
  zoom: number
  cards: Record<string, ShelfCardState>
  /** Cards the reader has put away. Kept as paths rather than as a flag on the
   *  card state, because a dismissal must survive the card leaving the window
   *  and coming back — otherwise a file sent again returns from the dead. */
  dismissed: string[]
}

/**
 * The zoom range, and it is deliberately enormous.
 *
 * This is a NUMERICAL GUARD, not a matter of taste. The canvas is one
 * coordinate system and the zoom is a true geometric scale of all of it —
 * cards, their text, their chrome, and the documents inside them — so zooming
 * in far enough turns a 240px thumbnail into a full, readable page, and that
 * continuity is the point: there is no threshold where the board stops being a
 * board and becomes a viewer. Capping it at some tasteful ceiling would put a
 * wall in the middle of that gesture.
 *
 * What the bounds actually prevent is arithmetic: a scale of zero collapses
 * every coordinate to the origin and cannot be divided by (the drag maths
 * converts screen travel to surface travel by dividing), and an unbounded
 * scale runs into the browser's own transform limits and into float precision.
 */
export const ZOOM_MIN = 0.02
export const ZOOM_MAX = 60

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0) return 1
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

export const SHELF_PERSIST_KEY = 'shuttle:shelf'

export function emptyPersist(): ShelfPersist {
  return { pan: { x: 0, y: 0 }, zoom: 1, cards: {}, dismissed: [] }
}

/**
 * Undo every hand placement, keeping the stars.
 *
 * A star is a judgement about a FILE ("this one matters"); a position is a
 * judgement about the SURFACE. Resetting the surface should not throw away the
 * first, so a starred card keeps its star and rejoins the flow — where the
 * order sorts starred cards to the front, so it is still the first thing you
 * see. Everything else about the arrangement goes.
 */
export function resetLayout(persist: ShelfPersist): ShelfPersist {
  const cards: Record<string, ShelfCardState> = {}
  for (const [path, state] of Object.entries(persist.cards)) {
    if (state.starred) cards[path] = { starred: true }
  }
  return { ...persist, pan: { x: 0, y: 0 }, zoom: 1, cards }
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
}

/**
 * A card is a PAGE. The default is portrait at A4's proportion (1 : 1.414),
 * because almost everything the fleet sends is a document — a report, a deck,
 * a plot on a page — and a landscape tile crops every one of them to a band
 * across the middle. At portrait the thumbnail shows a document's shape:
 * title, first figure, the start of the argument. You can tell two reports
 * apart from across the canvas, which is the entire premise of the surface.
 */
/** The proportion of a page. */
export const A4 = 1.414

export const SHELF_METRICS: ShelfMetrics = {
  width: 1200,
  cardW: 225,
  cardH: Math.round(225 * A4),
  gap: 20,
}

/** The band a flowed card's width may be stretched or squeezed into. Below the
 *  floor a thumbnail stops being recognisable; above the ceiling a lone column
 *  becomes a billboard. */
export const FLOW_MIN_W = 190
export const FLOW_MAX_W = 300

/**
 * How many columns fit, and how wide a card is in them.
 *
 * THE COLUMN COUNT IS ROUNDED, NOT FLOORED, and the card width then flexes to
 * fill the row exactly. Flooring a fixed card width is what put most of a
 * card's worth of dead canvas beside the docked reader: at a half-screen
 * viewport of ~711px the arithmetic was floor((711+20)/260) = 2 columns
 * occupying 500px, leaving 211 unusable pixels — visibly a whole empty column,
 * and no amount of dragging the divider would ever produce the third.
 *
 * Rounding asks the honest question ("how many columns does this width most
 * nearly hold?") and the flex then makes the answer true, so the flow always
 * spans its viewport and the surface never carries a margin it did not choose.
 * A width that would squeeze cards below the legibility floor drops a column
 * instead — one fewer, wider column beats a row of unreadable slivers.
 */
export function flowMetrics(
  width: number,
  gap: number,
  preferred: number,
): { columns: number; cardW: number; cardH: number } {
  const usable = Math.max(1, width)
  let columns = Math.max(1, Math.round((usable + gap) / (preferred + gap)))
  let cardW = (usable - (columns - 1) * gap) / columns
  // Too thin to read: take a column away and give its width to the rest.
  while (columns > 1 && cardW < FLOW_MIN_W) {
    columns -= 1
    cardW = (usable - (columns - 1) * gap) / columns
  }
  cardW = Math.floor(Math.min(FLOW_MAX_W, Math.max(FLOW_MIN_W, cardW)))
  return { columns, cardW, cardH: Math.round(cardW * A4) }
}

/**
 * A stack: one fiber's sends, as one tile.
 *
 * This is the unit the surface arranges. Ten reports from `shear-run` occupy
 * ONE flow slot with the newest of them face up, and the other nine are leafed
 * through in place — the board's card count becomes its fiber count, which is
 * the difference between a wall you scan and a wall you give up on.
 *
 * A stack is never a container you have to open to find out what is in it: the
 * face is a real, live card (its report renders, it opens, it drags), and the
 * depth is stated on it.
 */
export interface ShelfStack {
  /** The fiber, or '' for files that named none. */
  uid: string
  /** Every card in the stack, newest first. */
  files: ShelfFile[]
  /** The sheet on top — the one file the surface actually draws. */
  face: ShelfFile
}

/**
 * Gather files into the tiles the surface will lay out.
 *
 * Three rules, and each earns its place:
 *
 *   A card you PLACED or STARRED stands alone. Both gestures are claims about
 *   one file ("this one, here"), so honouring them means taking that file out
 *   of its fiber's stack — which is also how you pull a sheet off a pile: drag
 *   it out. The rest of the fiber closes up behind it.
 *
 *   A file with NO FIBER stands alone. An unattributed card has nothing to be
 *   a stack of — the same rule shelfPack applies to piles.
 *
 *   Everything else stacks by fiber, newest first.
 *
 * `faces` is the reader's paging: fiber → the path they leafed to. It is a
 * reading position, not a property of the work, so it is held in memory and
 * not persisted, and a path that has since left the window falls back to the
 * newest send rather than emptying the tile.
 */
export function buildStacks(
  files: readonly ShelfFile[],
  states: Record<string, ShelfCardState>,
  faces: Record<string, string> = {},
): ShelfStack[] {
  const groups = new Map<string, ShelfFile[]>()
  const alone: ShelfStack[] = []
  for (const file of files) {
    const state = states[file.fullPath]
    const uid = file.uid ?? ''
    if (!uid || isPlaced(state) || state?.starred === true) {
      alone.push({ uid, files: [file], face: file })
      continue
    }
    const list = groups.get(uid)
    if (list) list.push(file)
    else groups.set(uid, [file])
  }
  const stacked: ShelfStack[] = []
  for (const [uid, group] of groups) {
    group.sort(byNewest)
    const chosen = group.find((f) => f.fullPath === faces[uid])
    stacked.push({ uid, files: group, face: chosen ?? group[0] })
  }
  return [...stacked, ...alone].sort((a, b) => byNewest(a.files[0], b.files[0]))
}

const byNewest = (a: ShelfFile, b: ShelfFile): number =>
  b.timestamp - a.timestamp || a.fullPath.localeCompare(b.fullPath)

interface PlacedCard {
  /** The face — the only file of the stack the surface draws. */
  file: ShelfFile
  stack: ShelfStack
  x: number
  y: number
  w: number
  h: number
  /** True when the position came from the user, not from the flow. */
  pinned: boolean
  starred: boolean
}

export interface ShelfLayout {
  cards: PlacedCard[]
  /** Total surface extent, so the viewport knows how far it may pan. */
  height: number
  width: number
}

/**
 * Lay the shelf out.
 *
 * Flowed stacks fill left-to-right, top-to-bottom, so RECENCY HAS A DIRECTION:
 * the newest thing enters at the top-left and older work migrates right and
 * down. A stack's place in that order is its NEWEST member's — leafing back
 * through a fiber's older sends must not make its tile crawl down the board
 * under your hand. Starred-but-unplaced cards sort ahead of the rest — a star
 * that has lost its geometry (a hand-edited store, a card that came back after
 * being cleared) still reads as "this one first" rather than silently becoming
 * ordinary.
 *
 * Placed cards are drawn at their own coordinates and take no part in the
 * flow — they float over it. Reserving flow slots around them was the other
 * option and it is worse: a pinned card would then push its neighbours around
 * every time the fleet sent a file, which is the opposite of what pinning it
 * was for.
 */
export function layoutShelf(
  stacks: readonly ShelfStack[],
  states: Record<string, ShelfCardState>,
  metrics: ShelfMetrics = SHELF_METRICS,
  /** The card under the pointer (or just released): immovable for this
   *  layout, so a drop keeps the ground it landed on and its neighbours are
   *  the ones that yield. */
  active?: string | null,
): ShelfLayout {
  const { gap } = metrics
  // The card size is a CONSEQUENCE of the width available, not a constant:
  // `metrics.cardW` is the preferred width the column count is chosen from,
  // and the cards then flex to fill the row. See flowMetrics.
  const { columns, cardW, cardH } = flowMetrics(metrics.width, gap, metrics.cardW)
  const cards: PlacedCard[] = []

  const flowed: ShelfStack[] = []
  for (const stack of stacks) {
    const state = states[stack.face.fullPath]
    if (isPlaced(state)) {
      cards.push({
        file: stack.face,
        stack,
        x: num(state!.x) ?? 0,
        y: num(state!.y) ?? 0,
        w: num(state!.w) ?? cardW,
        h: num(state!.h) ?? cardH,
        pinned: true,
        starred: state!.starred === true,
      })
    } else {
      flowed.push(stack)
    }
  }

  const starred = (s: ShelfStack): boolean => states[s.face.fullPath]?.starred === true
  // The stack's own age is its NEWEST member's, whichever sheet is face up.
  const byRecency = (a: ShelfStack, b: ShelfStack): number =>
    (starred(b) ? 1 : 0) - (starred(a) ? 1 : 0) || byNewest(a.files[0], b.files[0])

  // The rects the flow must route AROUND: everything the reader placed by
  // hand. Water around stones — see shelfPack.flowSlots.
  const anchors: Rect[] = cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }))
  const flowGrid = { columns, cardW, cardH, gap }

  const colX = (i: number): number => (i % columns) * (cardW + gap)
  const rowY = (i: number): number => Math.floor(i / columns) * (cardH + gap)

  const ordered = [...flowed].sort(byRecency)
  const slots = flowSlots(ordered.length, flowGrid, anchors)
  ordered.forEach((stack, i) => {
    const slot = slots[i] ?? { x: colX(i), y: rowY(i), w: cardW, h: cardH }
    cards.push({
      file: stack.face, stack, x: slot.x, y: slot.y, w: cardW, h: cardH,
      pinned: false, starred: starred(stack),
    })
  })
  const bottom = slots.length ? Math.max(...slots.map((s) => s.y + cardH)) : 0

  // ── Settle ──
  // The flow already routes around the anchors, so this pass exists for the
  // one case the flow cannot prevent: two cards the reader placed by hand on
  // the same piece of surface. Same-fiber ones become a pile (cascaded, moved
  // as one); everything else is pushed apart. `active` — the card under the
  // pointer, or the one just dropped — is immovable, so a drop always wins the
  // ground it landed on.
  const settled = packShelf(
    cards.map((card) => ({
      key: card.file.fullPath,
      group: card.stack.uid,
      x: card.x,
      y: card.y,
      w: card.w,
      h: card.h,
      rank: card.file.fullPath === active || card.starred ? 'hard' : 'soft',
    })),
  )
  for (const card of cards) {
    const at = settled.get(card.file.fullPath)
    if (!at) continue
    card.x = at.x
    card.y = at.y
  }

  // The surface must be big enough for the furthest thing on it — including a
  // card someone dragged far off to one side.
  let width = columns * (cardW + gap) - gap
  let height = bottom
  for (const card of cards) {
    width = Math.max(width, card.x + card.w)
    height = Math.max(height, card.y + card.h)
  }
  return { cards, width, height }
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
  return readJSON(SHELF_PERSIST_KEY, coercePersist, emptyPersist, storage)
}

export function saveShelfPersist(state: ShelfPersist, storage?: Storage): void {
  writeJSON(SHELF_PERSIST_KEY, state, storage)
}

/**
 * Coerce a parsed record into a persist, field by field. Exported for the
 * round-trip test, which is the only way to be sure a store written by an
 * older shelf still opens.
 *
 * Field by field is also the whole migration story: a record written when the
 * board still had a lens carries a `lens` key that nothing here reads, and it
 * is dropped in passing rather than needing a version stamp to step over.
 */
export function coercePersist(parsed: unknown): ShelfPersist {
  const out = emptyPersist()
  if (!parsed || typeof parsed !== 'object') return out
  const rec = parsed as Record<string, unknown>
  const pan = rec.pan
  if (pan && typeof pan === 'object') {
    const p = pan as Record<string, unknown>
    out.pan = { x: num(p.x) ?? 0, y: num(p.y) ?? 0 }
  }
  out.zoom = clampZoom(num(rec.zoom) ?? 1)
  if (Array.isArray(rec.dismissed)) {
    out.dismissed = [...new Set(rec.dismissed.filter((p): p is string => typeof p === 'string' && !!p))]
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

/** localStorage, or null where the page has none (SSR, a browser with site
 *  data blocked — the accessor itself throws there). */
export function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Read one JSON record, best-effort: a missing, unreadable or half-written
 *  entry is `empty()`, never an error — the caller's surface must open either
 *  way. `coerce` is the caller's own, because only it knows what an older
 *  record looks like. */
export function readJSON<T>(
  key: string,
  coerce: (parsed: unknown) => T,
  empty: () => T,
  storage?: Storage,
): T {
  const store = storage ?? safeStorage()
  if (!store) return empty()
  try {
    const raw = store.getItem(key)
    return raw ? coerce(JSON.parse(raw)) : empty()
  } catch {
    return empty()
  }
}

/** Write one JSON record, or REMOVE it when `value` is null — which record is
 *  worth keeping is the caller's judgement, not this helper's. */
export function writeJSON(key: string, value: unknown | null, storage?: Storage): void {
  const store = storage ?? safeStorage()
  if (!store) return
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full / disabled — persistence is best-effort */
  }
}
