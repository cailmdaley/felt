/**
 * shelfPack — the board's one spatial law: NOTHING OVERLAPS, except a pile.
 *
 * A canvas where cards can cover each other is a canvas that loses work. You
 * drop a card, it lands on another, and the one underneath is simply gone —
 * not moved, not smaller, gone, and nothing on screen says so. So the surface
 * refuses the state: cards are bodies with volume, and a body arriving
 * somewhere occupied makes the occupants move.
 *
 * THE ONE EXCEPTION IS A PILE. Cards from the SAME FIBER may overlap, because
 * a heap of one fiber's outputs is a thing you meant to make — it reads as one
 * object ("everything from the shear run"), not as a card lost under another.
 * Piles are drawn as a cascade so their depth is visible, and from then on the
 * whole pile moves and is moved as a single body.
 *
 * The pipeline, and each stage is exported because each stage is worth a test:
 *
 *   flowSlots      lay unplaced cards on a grid, SKIPPING slots the placed
 *                  cards already occupy — the flow routes around anchors
 *                  rather than being pushed off its grid by them.
 *   arrangeStacks  gather same-fiber overlapping cards into piles, cascade
 *                  each pile, and hand back one rigid BODY per pile.
 *   pushApart      relax the bodies until none intersect: each colliding pair
 *                  separates along its shallowest axis, which is what makes
 *                  the motion read as things making room rather than as a
 *                  re-sort.
 *   packShelf      all three, in order.
 *
 * RANK decides who yields. A `hard` body never moves: the card under the
 * pointer right now, and any card the user starred (a star is a claim on a
 * position — see shelfLayout). Everything else is `soft` and gives way, two
 * softs splitting the difference between them. Without the ranking a drag
 * would push its own target away and the user could never put anything down.
 *
 * Pure — rectangles in, positions out. No DOM. The view runs this on every
 * reflow AND on every frame of a drag, which is where the collision reads as
 * physics: the dragged card tracks the pointer 1:1 while everything it leans
 * on slides away under the card transition.
 */

/** A rectangle on the surface, in surface coordinates. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Who yields to whom. */
export type PinRank = 'hard' | 'soft'

/** One card, as the packer sees it. */
export interface PackCard extends Rect {
  key: string
  /** The fiber. Cards sharing a non-empty group may pile; `''` never piles —
   *  an unattributed card has nothing to be a pile OF. */
  group: string
  rank: PinRank
}

/** A rigid body: one card, or one pile moved as a unit. */
export interface Body extends Rect {
  /** Member keys with their offsets from the body's origin. */
  members: Array<{ key: string; dx: number; dy: number }>
  rank: PinRank
}

/** Breathing room kept between two bodies — a hairline of surface, so
 *  neighbours read as separate sheets rather than a butt joint. */
export const PACK_GAP = 10

/** The cascade of a pile: enough to show the card under it is a card. */
export const STACK_DX = 18
export const STACK_DY = 15

/** How many relaxation passes before we accept what we have. A dozen settles
 *  any arrangement a hand can make; the cap only matters for the pathological
 *  case of more bodies than will fit, where stopping is the right answer. */
const MAX_PASSES = 24

// ── Geometry ─────────────────────────────────────────────────────────────────

/** Do these two rects intersect, allowing for the gap they must keep? */
export function intersects(a: Rect, b: Rect, gap = 0): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  )
}

/** Union of a non-empty list of rects — a pile's footprint. */
export function unionRect(rects: readonly Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x))
  const y = Math.min(...rects.map((r) => r.y))
  const right = Math.max(...rects.map((r) => r.x + r.w))
  const bottom = Math.max(...rects.map((r) => r.y + r.h))
  return { x, y, w: right - x, h: bottom - y }
}

// ── The flow: a grid that routes around what is already placed ────────────────

export interface FlowMetrics {
  columns: number
  cardW: number
  cardH: number
  gap: number
}

/**
 * Positions for `count` flowed cards, filling left-to-right then down from
 * `origin`, skipping any slot that would collide with a `blocked` rect.
 *
 * Skipping rather than shoving is the whole point. A placed card is an anchor
 * the reader put somewhere deliberate; the flow is water. Water goes around a
 * stone, and the grid stays a grid — which is what makes the surface scannable
 * at all. (The alternative, letting the relaxation push flowed cards off the
 * grid, settles into a drift of not-quite-aligned cards.)
 */
export function flowSlots(
  count: number,
  metrics: FlowMetrics,
  blocked: readonly Rect[],
  origin: { x: number; y: number } = { x: 0, y: 0 },
): Rect[] {
  const { columns, cardW, cardH, gap } = metrics
  const out: Rect[] = []
  // A ceiling, so a canvas whose every slot is blocked terminates rather than
  // searching down forever: every blocked rect can cost at most a full row.
  const limit = count + blocked.length * Math.max(1, columns) + columns
  for (let slot = 0; out.length < count && slot < limit; slot++) {
    const rect = {
      x: origin.x + (slot % columns) * (cardW + gap),
      y: origin.y + Math.floor(slot / columns) * (cardH + gap),
      w: cardW,
      h: cardH,
    }
    if (blocked.some((b) => intersects(rect, b, PACK_GAP))) continue
    out.push(rect)
  }
  return out
}

// ── Piles ────────────────────────────────────────────────────────────────────

/**
 * Gather same-fiber overlapping cards into piles and lay each pile as a
 * cascade; everything else becomes a body of one.
 *
 * The cascade anchors on the pile's HARD member when it has one — the card
 * under the pointer stays under the pointer and the pile assembles beneath it
 * — and otherwise on the pile's top-left card, so a pile that is merely being
 * pushed around keeps its own shape.
 */
export function arrangeStacks(cards: readonly PackCard[]): Body[] {
  const clusters = clusterByFiber(cards)
  return clusters.map((cluster) => {
    if (cluster.length === 1) {
      const card = cluster[0]
      return {
        x: card.x,
        y: card.y,
        w: card.w,
        h: card.h,
        rank: card.rank,
        members: [{ key: card.key, dx: 0, dy: 0 }],
      }
    }
    // Order: the anchor first, then by where the cards already are, so a pile
    // keeps its reading order across reflows instead of shuffling.
    const rest = [...cluster].sort((a, b) => a.y - b.y || a.x - b.x || a.key.localeCompare(b.key))
    const anchor = rest.find((c) => c.rank === 'hard') ?? rest[0]
    const ordered = [anchor, ...rest.filter((c) => c !== anchor)]
    const placed = ordered.map((card, i) => ({
      card,
      x: anchor.x + i * STACK_DX,
      y: anchor.y + i * STACK_DY,
    }))
    const rect = unionRect(placed.map((p) => ({ x: p.x, y: p.y, w: p.card.w, h: p.card.h })))
    return {
      ...rect,
      // A pile containing a starred or dragged card is itself immovable: the
      // claim on the position belongs to the pile now.
      rank: cluster.some((c) => c.rank === 'hard') ? 'hard' : 'soft',
      members: placed.map((p) => ({ key: p.card.key, dx: p.x - rect.x, dy: p.y - rect.y })),
    }
  })
}

/** Union-find over "same fiber AND overlapping" — a pile is transitive: A on
 *  B on C is one pile even if A and C never touch. */
function clusterByFiber(cards: readonly PackCard[]): PackCard[][] {
  const parent = cards.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]
      const b = cards[j]
      if (!a.group || a.group !== b.group) continue
      if (!intersects(a, b)) continue
      const ra = find(i)
      const rb = find(j)
      if (ra !== rb) parent[ra] = rb
    }
  }
  const groups = new Map<number, PackCard[]>()
  cards.forEach((card, i) => {
    const root = find(i)
    const list = groups.get(root)
    if (list) list.push(card)
    else groups.set(root, [card])
  })
  return [...groups.values()]
}

// ── The relaxation ───────────────────────────────────────────────────────────

/**
 * Push bodies apart until none intersect.
 *
 * Each colliding pair separates along its SHALLOWEST axis — the direction it
 * has least far to go — which is why the motion reads as making room: a card
 * nudged from the left slides left, not down and around. Hard bodies are
 * immovable and soft ones absorb the whole correction; two softs split it.
 *
 * Deterministic: pairs are visited in a fixed order and the result of a given
 * arrangement is always the same arrangement, which is what lets a drag be
 * re-solved every frame without the surface shivering.
 */
export function pushApart(bodies: readonly Body[], gap = PACK_GAP): Body[] {
  const out = bodies.map((b) => ({ ...b }))
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]
        const b = out[j]
        if (a.rank === 'hard' && b.rank === 'hard') continue
        if (!intersects(a, b, gap)) continue
        // Penetration depth on each axis, from the centres.
        const dx = a.x + a.w / 2 - (b.x + b.w / 2)
        const dy = a.y + a.h / 2 - (b.y + b.h / 2)
        const overlapX = (a.w + b.w) / 2 + gap - Math.abs(dx)
        const overlapY = (a.h + b.h) / 2 + gap - Math.abs(dy)
        if (overlapX <= 0 || overlapY <= 0) continue
        // Two bodies at the same centre have no direction to separate along;
        // break the tie sideways rather than dividing by zero.
        const horizontal = overlapX < overlapY
        const push = horizontal ? overlapX : overlapY
        const sign = horizontal ? (dx === 0 ? 1 : Math.sign(dx)) : dy === 0 ? 1 : Math.sign(dy)
        const aShare = a.rank === 'hard' ? 0 : b.rank === 'hard' ? 1 : 0.5
        const bShare = 1 - aShare
        if (horizontal) {
          a.x += sign * push * aShare
          b.x -= sign * push * bShare
        } else {
          a.y += sign * push * aShare
          b.y -= sign * push * bShare
        }
        moved = true
      }
    }
    if (!moved) break
  }
  return out
}

// ── The whole pipeline ───────────────────────────────────────────────────────

/**
 * Final positions for a set of cards: piles assembled, everything separated.
 * The map is keyed by card key; a card the packer did not move still appears,
 * so the caller can paint from one source.
 */
export function packShelf(cards: readonly PackCard[], gap = PACK_GAP): Map<string, Rect> {
  const settled = pushApart(arrangeStacks(cards), gap)
  const byKey = new Map<string, Rect>()
  const sizes = new Map(cards.map((c) => [c.key, c]))
  for (const body of settled) {
    for (const member of body.members) {
      const card = sizes.get(member.key)
      if (!card) continue
      byKey.set(member.key, {
        x: body.x + member.dx,
        y: body.y + member.dy,
        w: card.w,
        h: card.h,
      })
    }
  }
  return byKey
}
