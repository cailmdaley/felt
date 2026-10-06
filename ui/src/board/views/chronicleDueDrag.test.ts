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
import fc from 'fast-check'
import { columnIndexAtX, overlayDueEdits } from './ChronicleView.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { card as baseCard } from '../testFixtures.js'

const card = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
  baseCard({ status: 'active', ...over })

describe('columnIndexAtX — the drag snap math', () => {
  it('floors the cursor into the column it sits over, clamped to a real column', () => {
    // Integer pixels keep the column edges exact, so a cursor anywhere in
    // [left + k·w, left + (k+1)·w) must answer k — floored, never rounded to
    // the nearer edge — and a cursor past either end the nearest real column.
    // A width of 0 is a track not measured yet: still a real column, never a
    // division by zero. An empty track answers 0, never a negative index.
    fc.assert(fc.property(
      fc.integer({ min: -500, max: 500 }), fc.integer({ min: 0, max: 40 }),
      fc.integer({ min: 0, max: 31 }), fc.integer({ min: -2000, max: 2000 }),
      (trackLeft, dayW, dayCount, offset) => {
        const at = columnIndexAtX(trackLeft + offset, trackLeft, dayW, dayCount)
        expect(Number.isInteger(at)).toBe(true)
        expect(at).toBeGreaterThanOrEqual(0)
        expect(at).toBeLessThan(Math.max(dayCount, 1))
        if (dayW === 0 || dayCount === 0) return
        if (offset < 0) expect(at).toBe(0)
        else if (offset >= dayW * dayCount) expect(at).toBe(dayCount - 1)
        else {
          expect(trackLeft + at * dayW).toBeLessThanOrEqual(trackLeft + offset)
          expect(trackLeft + offset).toBeLessThan(trackLeft + (at + 1) * dayW)
        }
      },
    ), { seed: 0xd1a95, numRuns: 200 })
  })
})

describe('overlayDueEdits — the optimistic due-mark overlay', () => {
  const DATES = ['2026-08-01', '2026-08-05', '2026-08-20'] as const
  const ids = ['a', 'b', 'c', 'd']
  // Some cards carry no due at all: a drag in flight against a card whose due
  // was cleared some other way still holds until the daemon answers THIS edit.
  const served = fc.subarray(ids).chain((present) => fc.tuple(
    fc.constant(present),
    fc.array(fc.option(fc.constantFrom(...DATES), { nil: undefined }), {
      minLength: present.length, maxLength: present.length,
    }),
  )).map(([present, dues]) => present.map((id, i) => card({ id, due: dues[i] })))
  // Edits may name ids the served list does not carry.
  const pending = fc.dictionary(fc.constantFrom(...ids, 'z'), fc.constantFrom(...DATES))
    .map((o) => new Map(Object.entries(o)))

  it('patches every card with a pending edit, confirms the ones already echoed, and touches nothing else', () => {
    fc.assert(fc.property(served, pending, (cards, edits) => {
      const before = structuredClone(cards)
      const { cards: out, confirmed } = overlayDueEdits(cards, edits)

      expect(cards, 'the served cards are never mutated').toEqual(before)
      expect(out).toHaveLength(cards.length)
      cards.forEach((c, i) => {
        const edit = edits.get(c.id)
        if (edit === undefined) expect(out[i], `${c.id} has no edit`).toBe(c)
        else expect(out[i], `${c.id} shows its edit`).toEqual({ ...c, due: edit })
      })
      // Confirmed once the served due already matches — and only then.
      expect(confirmed).toEqual(cards.filter((c) => edits.has(c.id) && edits.get(c.id) === c.due).map((c) => c.id))
    }), { seed: 0x0e71a7, numRuns: 200 })
  })
})
