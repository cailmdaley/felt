/**
 * shelfPack — the board's spatial law, tested as arithmetic.
 *
 * Two claims are worth more than all the others and each has a test that says
 * so in one line: after packing, NOTHING OVERLAPS except cards of one fiber;
 * and a hard-ranked card (the one under the pointer, or a starred one) is
 * exactly where it was when the packer got it.
 */

import { describe, expect, it } from 'vitest'

import {
  arrangeStacks,
  flowSlots,
  intersects,
  PACK_GAP,
  packShelf,
  pushApart,
  STACK_DX,
  STACK_DY,
  unionRect,
  type PackCard,
  type Rect,
} from './shelfPack.js'

const W = 268
const H = 212

function card(key: string, x: number, y: number, extra?: Partial<PackCard>): PackCard {
  return { key, group: '', x, y, w: W, h: H, rank: 'soft', ...extra }
}

/** Every pair that is allowed to touch, doesn't. */
function assertLegal(cards: readonly PackCard[], settled: Map<string, Rect>): void {
  const groups = new Map(cards.map((c) => [c.key, c.group]))
  const entries = [...settled.entries()]
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [ka, a] = entries[i]
      const [kb, b] = entries[j]
      const sameFiber = groups.get(ka) === groups.get(kb) && !!groups.get(ka)
      if (sameFiber) continue
      expect(intersects(a, b), `${ka} overlaps ${kb}`).toBe(false)
    }
  }
}

describe('intersects / unionRect', () => {
  it('counts the gap as occupied space', () => {
    const a = { x: 0, y: 0, w: 100, h: 100 }
    const b = { x: 105, y: 0, w: 100, h: 100 }
    expect(intersects(a, b)).toBe(false)
    expect(intersects(a, b, 10)).toBe(true)
  })

  it('wraps a pile in one footprint', () => {
    expect(unionRect([{ x: 10, y: 20, w: 100, h: 50 }, { x: 40, y: 30, w: 100, h: 50 }])).toEqual({
      x: 10,
      y: 20,
      w: 130,
      h: 60,
    })
  })
})

describe('flowSlots — water around stones', () => {
  const metrics = { columns: 3, cardW: W, cardH: H, gap: 20 }

  it('fills left to right, then down', () => {
    const slots = flowSlots(4, metrics, [])
    expect(slots[0]).toMatchObject({ x: 0, y: 0 })
    expect(slots[1].x).toBe(W + 20)
    expect(slots[1].y).toBe(0)
    expect(slots[3]).toMatchObject({ x: 0, y: H + 20 })
  })

  it('skips a slot a placed card is sitting in, keeping the grid a grid', () => {
    // An anchor over the second slot of the first row.
    const anchor = { x: W + 20, y: 0, w: W, h: H }
    const slots = flowSlots(3, metrics, [anchor])
    expect(slots.map((s) => `${s.x},${s.y}`)).toEqual([
      `0,0`,
      `${2 * (W + 20)},0`,
      `0,${H + 20}`,
    ])
    // Every slot is still ON the grid — none was nudged off it.
    for (const slot of slots) {
      expect(slot.x % (W + 20)).toBe(0)
      expect(slot.y % (H + 20)).toBe(0)
      expect(intersects(slot, anchor, PACK_GAP)).toBe(false)
    }
  })

  it('offsets a band without changing the column rhythm', () => {
    const slots = flowSlots(2, metrics, [], { x: 0, y: 500 })
    expect(slots[0]).toMatchObject({ x: 0, y: 500 })
    expect(slots[1]).toMatchObject({ x: W + 20, y: 500 })
  })

  it('terminates rather than searching forever when everything is blocked', () => {
    // A wall of anchors across the first several rows.
    const wall: Rect[] = []
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 3; col++) {
        wall.push({ x: col * (W + 20), y: row * (H + 20), w: W, h: H })
      }
    }
    const slots = flowSlots(2, metrics, wall)
    expect(slots).toHaveLength(2)
    expect(slots[0].y).toBeGreaterThanOrEqual(4 * (H + 20))
  })
})

describe('arrangeStacks — one fiber makes a pile', () => {
  it('leaves cards that do not touch as bodies of one', () => {
    const bodies = arrangeStacks([card('/a', 0, 0), card('/b', 600, 0)])
    expect(bodies).toHaveLength(2)
    expect(bodies.every((b) => b.members.length === 1)).toBe(true)
  })

  it('refuses to pile cards from different fibers, however they overlap', () => {
    const bodies = arrangeStacks([
      card('/a', 0, 0, { group: 'shear' }),
      card('/b', 20, 20, { group: 'lensing' }),
    ])
    expect(bodies).toHaveLength(2)
  })

  it('never piles unattributed cards — there is nothing to be a pile of', () => {
    const bodies = arrangeStacks([card('/a', 0, 0), card('/b', 20, 20)])
    expect(bodies).toHaveLength(2)
  })

  it('cascades a same-fiber overlap into a readable pile', () => {
    const bodies = arrangeStacks([
      card('/a', 100, 100, { group: 'shear' }),
      card('/b', 130, 120, { group: 'shear' }),
    ])
    expect(bodies).toHaveLength(1)
    const [pile] = bodies
    expect(pile.members).toHaveLength(2)
    expect(pile.x).toBe(100)
    expect(pile.y).toBe(100)
    // Second card sits one cascade step down-and-right of the first.
    expect(pile.members[1].dx).toBe(STACK_DX)
    expect(pile.members[1].dy).toBe(STACK_DY)
    expect(pile.w).toBe(W + STACK_DX)
    expect(pile.h).toBe(H + STACK_DY)
  })

  it('is transitive: A on B on C is one pile even if A never touches C', () => {
    const bodies = arrangeStacks([
      card('/a', 0, 0, { group: 'shear' }),
      card('/b', 200, 0, { group: 'shear' }),
      card('/c', 400, 0, { group: 'shear' }),
    ])
    expect(bodies).toHaveLength(1)
    expect(bodies[0].members).toHaveLength(3)
  })

  it('anchors the cascade on the dragged card, and never moves it', () => {
    const bodies = arrangeStacks([
      card('/settled', 100, 100, { group: 'shear' }),
      card('/dragged', 140, 130, { group: 'shear', rank: 'hard' }),
    ])
    const [pile] = bodies
    const dragged = pile.members.find((m) => m.key === '/dragged')!
    // The pile assembles from where the pointer is holding the card.
    expect(pile.x + dragged.dx).toBe(140)
    expect(pile.y + dragged.dy).toBe(130)
    expect(pile.rank).toBe('hard')
  })
})

describe('pushApart — bodies make room', () => {
  const body = (key: string, x: number, y: number, rank: 'hard' | 'soft' = 'soft') => ({
    x,
    y,
    w: W,
    h: H,
    rank,
    members: [{ key, dx: 0, dy: 0 }],
  })

  it('separates along the shallowest axis — a nudge from the side slides sideways', () => {
    // Deeply overlapping vertically, barely horizontally: it must go sideways.
    const [a, b] = pushApart([body('/a', 0, 0, 'hard'), body('/b', W - 30, 10)])
    expect(a).toMatchObject({ x: 0, y: 0 }) // hard: did not budge
    expect(b.y).toBe(10) // stayed on its row
    expect(b.x).toBe(W + PACK_GAP)
  })

  it('leaves a hard body exactly where it was', () => {
    const settled = pushApart([body('/dragged', 100, 100, 'hard'), body('/other', 110, 110)])
    const dragged = settled.find((s) => s.members[0].key === '/dragged')!
    expect(dragged).toMatchObject({ x: 100, y: 100 })
  })

  it('splits the correction between two soft bodies', () => {
    const [a, b] = pushApart([body('/a', 0, 0), body('/b', W - 40, 0)])
    // Both moved, symmetrically, and they no longer touch.
    expect(a.x).toBeLessThan(0)
    expect(b.x).toBeGreaterThan(W - 40)
    expect(Math.abs(a.x) - 0).toBeCloseTo(b.x - (W - 40), 6)
    expect(intersects(a, b)).toBe(false)
  })

  it('does not move two hard bodies, even stacked — a claim is a claim', () => {
    const settled = pushApart([body('/a', 0, 0, 'hard'), body('/b', 10, 10, 'hard')])
    expect(settled[0]).toMatchObject({ x: 0, y: 0 })
    expect(settled[1]).toMatchObject({ x: 10, y: 10 })
  })

  it('separates bodies dropped at the very same point rather than dividing by zero', () => {
    const [a, b] = pushApart([body('/a', 50, 50), body('/b', 50, 50)])
    expect(Number.isFinite(a.x)).toBe(true)
    expect(Number.isFinite(b.x)).toBe(true)
    expect(intersects(a, b)).toBe(false)
  })

  it('settles a crowd so that nothing is left overlapping', () => {
    const crowd = Array.from({ length: 8 }, (_, i) => body(`/c${i}`, i * 30, i * 20))
    const settled = pushApart(crowd)
    for (let i = 0; i < settled.length; i++) {
      for (let j = i + 1; j < settled.length; j++) {
        expect(intersects(settled[i], settled[j])).toBe(false)
      }
    }
  })
})

describe('packShelf — the whole law', () => {
  it('leaves an already-legal board untouched', () => {
    const cards = [card('/a', 0, 0), card('/b', W + 40, 0)]
    const settled = packShelf(cards)
    expect(settled.get('/a')).toMatchObject({ x: 0, y: 0 })
    expect(settled.get('/b')).toMatchObject({ x: W + 40, y: 0 })
  })

  it('clears the ground under a dropped card and hides nothing', () => {
    const cards = [
      card('/old', 100, 100),
      card('/dropped', 120, 110, { rank: 'hard' }),
      card('/neighbour', 100 + W + 30, 100),
    ]
    const settled = packShelf(cards)
    expect(settled.get('/dropped')).toMatchObject({ x: 120, y: 110 })
    assertLegal(cards, settled)
  })

  it('lets one fiber pile up while everything else keeps its distance', () => {
    const cards = [
      card('/s1', 100, 100, { group: 'shear' }),
      card('/s2', 130, 125, { group: 'shear' }),
      card('/other', 150, 140, { group: 'lensing' }),
    ]
    const settled = packShelf(cards)
    // The pile is a pile: its two cards still overlap, cascaded.
    expect(intersects(settled.get('/s1')!, settled.get('/s2')!)).toBe(true)
    assertLegal(cards, settled)
  })

  it('moves a whole pile as one body when something displaces it', () => {
    const cards = [
      card('/s1', 100, 100, { group: 'shear' }),
      card('/s2', 118, 115, { group: 'shear' }),
      card('/hard', 120, 105, { group: 'lensing', rank: 'hard' }),
    ]
    const settled = packShelf(cards)
    const s1 = settled.get('/s1')!
    const s2 = settled.get('/s2')!
    // The cascade offset survived the push: the pile moved, it did not scatter.
    expect(s2.x - s1.x).toBe(STACK_DX)
    expect(s2.y - s1.y).toBe(STACK_DY)
    expect(settled.get('/hard')).toMatchObject({ x: 120, y: 105 })
    assertLegal(cards, settled)
  })

  it('returns every card it was given, moved or not', () => {
    const cards = [card('/a', 0, 0), card('/b', 1000, 1000)]
    expect([...packShelf(cards).keys()].sort()).toEqual(['/a', '/b'])
  })

  it('is deterministic — the same board solves to the same board', () => {
    const cards = [
      card('/a', 0, 0),
      card('/b', 30, 20),
      card('/c', 60, 40, { rank: 'hard' }),
      card('/d', 90, 60, { group: 'shear' }),
      card('/e', 100, 70, { group: 'shear' }),
    ]
    expect([...packShelf(cards)]).toEqual([...packShelf(cards)])
  })
})
