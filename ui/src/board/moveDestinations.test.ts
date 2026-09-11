// The Move menu's destination list, held against the drag's own legality.
//
// The menu exists because drag-and-drop has no touch backend, so the one
// property worth pinning is AGREEMENT: an entry appears iff the equivalent
// drop would have committed rather than bannered. Each case below names the
// guard in KanbanModal / KanbanRules it is standing in for.

import { describe, expect, it } from 'vitest'
import { moveDestinations, queueTargets } from './MoveDestinations.js'
import { buildDependents } from './KanbanRules.js'
import type { KanbanCard } from './KanbanTypes.js'
import { card as baseCard } from './testFixtures.js'

const at0 = '2026-01-01T00:00:00Z'

const card = (over: Partial<KanbanCard> = {}): KanbanCard =>
  baseCard({ id: 'work/a', name: 'A', path: 'work/a.md', originId: 'here', status: 'active', createdAt: at0, ...over })

const ids = (c: KanbanCard, column: Parameters<typeof moveDestinations>[1] = null): string[] =>
  moveDestinations(c, column).map((d) => d.id)

describe('moveDestinations', () => {
  it('offers a plain draft the launch, the stash and a queue', () => {
    expect(ids(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts')).toEqual([
      'inFlight',
      'stashed',
      'pin',
      'queue',
    ])
  })

  it('never offers the column the card already sits in', () => {
    expect(ids(card({ shuttleKind: 'oneshot' }), 'inFlight')).not.toContain('inFlight')
    expect(ids(card({ status: 'open' }), 'drafts')).not.toContain('drafts')
  })

  it('says nothing at all about a cycle — a span of time is not work', () => {
    expect(moveDestinations(card({ isCycle: true }), null)).toEqual([])
  })

  // setSurface's standing guard: "it runs on its schedule".
  it('withholds both surfaces from a standing role, but still offers the queue', () => {
    const d = ids(card({ shuttleKind: 'standing', effectiveHorizon: 'stashed' }), null)
    expect(d).not.toContain('now')
    expect(d).not.toContain('stashed')
    expect(d).toContain('queue')
    expect(d).toContain('inFlight') // drag-to-In-flight still runs it now
  })

  // setSurface's pinned-at-rest guard, and pinRole's "already pinned".
  it('offers a resting pinned role the lifecycle moves, the queue, and unpin', () => {
    const d = ids(card({ shuttleKind: 'pinned', status: 'active' }), null)
    expect(d).toContain('inFlight')
    expect(d).toContain('drafts')
    expect(d).toContain('queue')
    expect(d).toContain('unpin')
    expect(d).not.toContain('now')
    expect(d).not.toContain('stashed')
  })

  // pinRole ~1611: refusing this was a bug — a once-pinned card left closed
  // could never be re-rested from the board.
  it('lets a pinned role whose last run is closed come back to rest', () => {
    const awaiting = card({ shuttleKind: 'pinned', status: 'closed' })
    expect(ids(awaiting, 'awaitingReview')).toContain('pin')
    const composted = card({ shuttleKind: 'pinned', status: 'closed', tempered: false })
    expect(ids(composted, 'composted')).toContain('pin')
  })

  // setSurface compares the card's `cold` against the gesture's, and a menu
  // Rest carries none — so clearing the flag IS the move.
  it('offers Rest to a resting card that is cold', () => {
    const cold = card({ status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', cold: true })
    expect(ids(cold, null)).toContain('stashed')
  })

  it('offers to stop a live pinned role back onto the strip', () => {
    const d = ids(card({ shuttleKind: 'pinned', status: 'active', runningWorker: 'w' }), 'inFlight')
    expect(d).toContain('pin')
    expect(d).toContain('unpin')
  })

  // pinRole: a block-less draft has no host or project_dir to install from.
  it('will not pin a card with no shuttle block', () => {
    expect(ids(card({ status: 'open' }), 'drafts')).not.toContain('pin')
  })

  // The queue exit is offered on the EDGE: a card that names a predecessor is
  // in a queue whether or not the fold happens to be drawing it under one.
  it('offers the queue exit to any card carrying a scalar edge', () => {
    const d = ids(
      card({ dependsOn: ['work/b'], dependsOnShape: 'scalar', foldedUnder: 'work/b' }),
      null,
    )
    expect(d).toContain('unstack')
  })

  it('does not offer the queue exit to a card with no edge', () => {
    expect(ids(card({ status: 'open' }), 'drafts')).not.toContain('unstack')
  })

  // stackDropVerdict: a hand-written list is a fan-in nobody may collapse.
  it('leaves a hand-written depends_on list alone', () => {
    const d = ids(card({ dependsOnShape: 'list', dependsOn: ['x', 'y'], foldedUnder: 'x' }), null)
    expect(d).not.toContain('queue')
    expect(d).not.toContain('unstack')
  })

  it('does not offer Resting to a card already sitting in it', () => {
    const resting = card({ status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed' })
    expect(ids(resting, null)).not.toContain('stashed')
    expect(ids(resting, null)).toContain('now')
  })
})

describe('queueTargets', () => {
  const a = card({ id: 'a', name: 'A', status: 'open' })
  const b = card({ id: 'b', name: 'B', status: 'open' })
  const c = card({ id: 'c', name: 'C', status: 'open', dependsOn: ['b'], dependsOnShape: 'scalar' })
  const done = card({ id: 'd', name: 'D', status: 'closed', tempered: true })
  const all = [a, b, c, done]
  const deps = buildDependents(all)

  it('offers every card the drop would accept, and resolves to the chain tail', () => {
    const targets = queueTargets(a, all, deps)
    expect(targets.map((t) => t.card.id).sort()).toEqual(['b', 'c', 'd'])
    // Dropping onto B joins the END of B's queue, which is C.
    expect(targets.find((t) => t.card.id === 'b')?.tail).toBe('c')
  })

  it('excludes the card itself, and offers finished work — a queue is ordering', () => {
    const targets = queueTargets(a, all, deps).map((t) => t.card.id)
    expect(targets).not.toContain('a')
    expect(targets).toContain('d')
  })

  it('excludes a target the card is already queued behind', () => {
    expect(queueTargets(c, all, deps).map((t) => t.card.id)).not.toContain('b')
  })
})
