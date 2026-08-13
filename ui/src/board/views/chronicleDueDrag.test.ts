/**
 * Due-mark drag: the two pure halves.
 *
 *  - `columnIndexAtX` — the snap math shared by every horizontal drag on this
 *    page (cycle edges, cycle draw, and this one), pulled out of `dayAt` so
 *    it can be pinned without a DOM.
 *  - `overlayDueEdits` — the optimistic overlay: a dropped date is held
 *    against the served cards until the daemon's own copy agrees, mirroring
 *    the cycle strip's `cycleEdits` contract (see `collectBands`).
 *
 * The gesture itself (mousedown/mousemove/mouseup, Escape, drop-outside) is
 * DOM-driven and lives in `installDueMarkDrag` — not unit-tested here, same
 * as its sibling `installEdgeDrag` never has been; these two functions are
 * what it is built from, and what a future change to either must keep true.
 */

import { describe, expect, it } from 'vitest'
import { columnIndexAtX, overlayDueEdits } from './ChronicleView.js'
import type { KanbanCard } from '../KanbanTypes.js'

function card(over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  return {
    name: over.name ?? over.id,
    path: `.felt/${over.id}.md`,
    originId: 'local',
    status: 'active',
    createdAt: '2026-01-01T09:00:00Z',
    dependsOnSatisfied: true,
    effectiveHorizon: 'now',
    drifted: false,
    isCycle: false,
    cycleStart: null,
    ...over,
  }
}

describe('columnIndexAtX — the drag snap math', () => {
  const trackLeft = 100
  const dayW = 24
  const dayCount = 30

  it('places the cursor in the column it sits over', () => {
    expect(columnIndexAtX(trackLeft, trackLeft, dayW, dayCount)).toBe(0)
    expect(columnIndexAtX(trackLeft + dayW, trackLeft, dayW, dayCount)).toBe(1)
    expect(columnIndexAtX(trackLeft + dayW * 5 + 3, trackLeft, dayW, dayCount)).toBe(5)
  })

  it('floors within a column rather than rounding to the nearer edge', () => {
    // Anywhere in [trackLeft + 2*dayW, trackLeft + 3*dayW) is still column 2.
    expect(columnIndexAtX(trackLeft + dayW * 2, trackLeft, dayW, dayCount)).toBe(2)
    expect(columnIndexAtX(trackLeft + dayW * 2.99, trackLeft, dayW, dayCount)).toBe(2)
  })

  it('clamps a cursor past either end to the nearest real column', () => {
    expect(columnIndexAtX(trackLeft - 500, trackLeft, dayW, dayCount)).toBe(0)
    expect(columnIndexAtX(trackLeft + dayW * dayCount + 500, trackLeft, dayW, dayCount)).toBe(
      dayCount - 1,
    )
  })

  it('never divides by zero when the day width has not been measured yet', () => {
    expect(() => columnIndexAtX(trackLeft + 50, trackLeft, 0, dayCount)).not.toThrow()
    expect(Number.isFinite(columnIndexAtX(trackLeft + 50, trackLeft, 0, dayCount))).toBe(true)
  })

  it('answers column 0 for an empty track rather than a negative index', () => {
    expect(columnIndexAtX(trackLeft, trackLeft, dayW, 0)).toBe(0)
  })
})

describe('overlayDueEdits — the optimistic due-mark overlay', () => {
  it('leaves cards untouched when there are no pending edits', () => {
    const cards = [card({ id: 'a', due: '2026-08-01' })]
    const { cards: out, confirmed } = overlayDueEdits(cards, new Map())
    expect(out).toEqual(cards)
    expect(confirmed).toEqual([])
  })

  it('patches a card whose id has a pending edit, and leaves others alone', () => {
    const a = card({ id: 'a', due: '2026-08-01' })
    const b = card({ id: 'b', due: '2026-08-05' })
    const edits = new Map([['a', '2026-08-20']])
    const { cards: out, confirmed } = overlayDueEdits([a, b], edits)
    expect(out.find((c) => c.id === 'a')?.due).toBe('2026-08-20')
    expect(out.find((c) => c.id === 'b')?.due).toBe('2026-08-05')
    expect(confirmed).toEqual([])
    // The original array is untouched — a fresh object stands in for the edit.
    expect(a.due).toBe('2026-08-01')
  })

  it('reports a card confirmed once the served due already matches the edit', () => {
    const a = card({ id: 'a', due: '2026-08-20' }) // the daemon has caught up
    const edits = new Map([['a', '2026-08-20']])
    const { cards: out, confirmed } = overlayDueEdits([a], edits)
    expect(out[0].due).toBe('2026-08-20')
    expect(confirmed).toEqual(['a'])
  })

  it('does not confirm an edit for a card the daemon has not echoed yet', () => {
    const a = card({ id: 'a', due: '2026-08-01' })
    const edits = new Map([['a', '2026-08-20']])
    const { confirmed } = overlayDueEdits([a], edits)
    expect(confirmed).toEqual([])
  })

  it('holds an edit even for a card that has since lost its due entirely', () => {
    // A drag in flight against a card whose due was cleared some other way —
    // the overlay still wins until the daemon's answer to THIS edit lands.
    const a = card({ id: 'a', due: undefined })
    const edits = new Map([['a', '2026-08-20']])
    const { cards: out, confirmed } = overlayDueEdits([a], edits)
    expect(out[0].due).toBe('2026-08-20')
    expect(confirmed).toEqual([])
  })
})
