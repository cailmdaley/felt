// THE FIRST FRAME AFTER A DROP MUST BE THE ANSWER.
//
// Dragging a queued row onto In-flight is three or four round trips deep —
// clear the row's edge, repair its successor's, transition, dispatch — and
// every stopping point between them is a state that is true of the store and
// false of what the human asked for. Left to render, they rendered: the card
// reached In flight, popped back into Drafts, and then launched.
//
// Two things fixed it, and this pins the half that is pure. `clearQueueEdge`
// releases the card from its queue in the response the board is about to
// paint, so the row leaves its peek list and the plum gated glyph goes in the
// same frame the drop lands — before any write has gone out. (The other half
// is `gestureDepth`, which keeps the 15-second poll from painting one of the
// intermediate states while the writes run underneath.)

import { describe, expect, it } from 'vitest'
import { clearQueueEdge } from './KanbanModal.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card as baseCard, response } from './testFixtures.js'

const card = (id: string, over: Partial<KanbanCard> = {}): KanbanCard =>
  baseCard({ id, ...over })

const QUEUED = {
  dependsOn: ['work/head'],
  dependsOnShape: 'scalar' as const,
}

describe('clearQueueEdge', () => {
  it('brings a FOLDED card onto the desk — it had no surface to be put back on', () => {
    // A folded card is drawn only as a row in its head's peek list, so
    // "restore it where it was" has no answer. Unfolding IS its arrival, and it
    // lands in the column its own status names.
    const resp = response({ folded: [card('work/queued', QUEUED)] })
    const out = clearQueueEdge(resp, 'work/queued')!
    expect(out.folded).toHaveLength(0)
    expect(out.now.drafts.map((c) => c.id)).toEqual(['work/queued'])
    expect(out.now.drafts[0].foldedUnder).toBeUndefined()
  })

  it('releases a resting card without moving it off its surface', () => {
    // A card drawn in Resting stays in Resting: the edge goes, the surface does
    // not. Where it lands next is the drop's own business, applied on top.
    const resp = response({ stash: [card('work/head'), card('work/queued', QUEUED)] })
    const out = clearQueueEdge(resp, 'work/queued')
    expect(out).not.toBeNull()
    const released = out!.stash.find((c) => c.id === 'work/queued')!
    expect(released.foldedUnder).toBeUndefined()
    expect(released.dependsOn).toBeUndefined()
    expect(released.dependsOnShape).toBeUndefined()
    expect(out!.stash).toHaveLength(2)
  })

  it('leaves the head card, and everyone else, exactly as they were', () => {
    // The edge is the row's own field. Guessing the successor's repair edge
    // here would put a chain shape on screen that no document says yet — that
    // write has a real failure mode and gets to fail visibly.
    const head = card('work/head')
    const tail = card('work/tail', { ...QUEUED, dependsOn: ['work/queued'] })
    const resp = response({ stash: [head, card('work/queued', QUEUED), tail] })
    const out = clearQueueEdge(resp, 'work/queued')!
    expect(out.stash.find((c) => c.id === 'work/head')).toEqual(head)
    expect(out.stash.find((c) => c.id === 'work/tail')).toEqual(tail)
  })

  it('never mutates the response it was handed', () => {
    // The caller keeps the pre-paint response as `basis` — `transition` reads
    // it to learn where the card came FROM. Mutating it would make the card
    // appear to have started at its destination, and the transition would
    // early-return "already in In flight" without ever writing.
    const resp = response({ stash: [card('work/queued', QUEUED)] })
    const snapshot = JSON.stringify(resp)
    clearQueueEdge(resp, 'work/queued')
    expect(JSON.stringify(resp)).toBe(snapshot)
  })

  it('finds the card on a Now column too, not only in Resting', () => {
    const resp = response({
      now: { drafts: [card('work/queued', QUEUED)], inFlight: [], awaitingReview: [] },
    })
    const out = clearQueueEdge(resp, 'work/queued')!
    expect(out.now.drafts[0].dependsOn).toBeUndefined()
    expect(out.stash).toHaveLength(0)
  })

  it('returns null for a card that is nowhere, and for no response at all', () => {
    // The caller then skips the optimistic paint and leans on the refetch.
    expect(clearQueueEdge(response(), 'work/ghost')).toBeNull()
    expect(clearQueueEdge(null, 'work/queued')).toBeNull()
  })
})
