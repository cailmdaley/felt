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
  it('names the places in board order: the Now columns, then the rest', () => {
    expect(ids(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts')).toEqual([
      'inFlight',
      'awaitingReview',
      'stashed',
      'pin',
      'queue',
    ])
  })

  it('labels every destination with the board\'s own name for the place', () => {
    const labels = new Map(
      moveDestinations(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts').map((d) => [d.id, d.label]),
    )
    expect(labels.get('inFlight')).toBe('In flight')
    expect(labels.get('awaitingReview')).toBe('Awaiting review')
    expect(labels.get('stashed')).toBe('Resting')
    expect(labels.get('pin')).toBe('Pinned')
  })

  it('puts the Now columns in one group and everything else in the other', () => {
    const d = moveDestinations(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts')
    expect(d.filter((x) => x.group === 'column').map((x) => x.id)).toEqual(['inFlight', 'awaitingReview'])
    expect(d.filter((x) => x.group === 'other').map((x) => x.id)).toEqual(['stashed', 'pin', 'queue'])
  })

  // One row per guard the menu mirrors: the card's state, where the board has
  // it, and the exact menu that state earns. Exact lists, so an entry that
  // appears where no drop would commit fails as loudly as one that vanishes.
  const menus: [guard: string, state: Partial<KanbanCard>, column: Parameters<typeof moveDestinations>[1], menu: string[]][] = [
    // `transition`'s one no-op guard, `fromKind === target`; the desk is
    // likewise withheld from a card already on it.
    ['a one-shot in In flight is not offered In flight or the desk', { shuttleKind: 'oneshot' }, 'inFlight',
      ['drafts', 'awaitingReview', 'stashed', 'pin', 'queue']],
    // pinRole: a block-less draft has no host or project_dir to install from.
    ['a block-less draft is not offered Drafts or the strip', { status: 'open' }, 'drafts',
      ['inFlight', 'awaitingReview', 'stashed', 'queue']],
    // Awaiting review is a plain lifecycle drop with no gate of its own, so it
    // is offered from every column but its own; a closed card is off the desk.
    ['an awaiting card is offered every other column and the desk', { status: 'closed' }, 'awaitingReview',
      ['drafts', 'inFlight', 'now', 'stashed', 'queue']],
    ['a closed card that still carries the now horizon is offered the desk', { status: 'closed', effectiveHorizon: 'now', shuttleKind: 'oneshot' }, 'awaitingReview',
      ['drafts', 'inFlight', 'now', 'stashed', 'pin', 'queue']],
    ['a tempered card is offered Awaiting review and both surfaces', { status: 'closed', tempered: true }, 'tempered',
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'stashed', 'queue']],
    ['a resting card is not offered Resting', { status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'queue']],
    // setSurface compares the card's `cold` against the gesture's, and a menu
    // Rest carries none, so clearing the flag is the move.
    ['a resting cold card is offered Resting', { status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', cold: true }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'stashed', 'queue']],
    // setSurface's standing guard: "it runs on its schedule". Drag-to-In-flight
    // still runs it now.
    ['a standing role is withheld both surfaces', { shuttleKind: 'standing', effectiveHorizon: 'stashed' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'pin', 'queue']],
    // setSurface's pinned-at-rest guard, and pinRole's "already pinned".
    ['a resting pinned role is offered lifecycle moves, the queue and Unpin', { shuttleKind: 'pinned', status: 'active' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'unpin', 'queue']],
    // pinRole: refusing this was a bug; a once-pinned card left closed could
    // never be re-rested from the board.
    ['an awaiting pinned role comes back to the strip', { shuttleKind: 'pinned', status: 'closed' }, 'awaitingReview',
      ['drafts', 'inFlight', 'pin', 'unpin', 'queue']],
    ['a composted pinned role comes back to the strip', { shuttleKind: 'pinned', status: 'closed', tempered: false }, 'composted',
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'stashed', 'pin', 'unpin', 'queue']],
    ['a live pinned role is offered a stop back onto the strip', { shuttleKind: 'pinned', status: 'active', workerState: 'running', tmuxSession: 'w' }, 'inFlight',
      ['drafts', 'awaitingReview', 'pin', 'unpin', 'queue']],
    // The queue exit is offered on the EDGE: a card that names a predecessor is
    // in a queue whether or not the fold happens to be drawing it under one.
    ['an open queued pinned role is offered the strip and the queue exit', { shuttleKind: 'pinned', status: 'open', dependsOn: ['work/b'], dependsOnShape: 'scalar' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'stashed', 'pin', 'unpin', 'queue', 'unstack']],
    ['an active queued pinned role is offered the strip and the queue exit', { shuttleKind: 'pinned', status: 'active', dependsOn: ['work/b'], dependsOnShape: 'scalar' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'pin', 'unpin', 'queue', 'unstack']],
    ['a card on a scalar edge is offered the queue exit', { dependsOn: ['work/b'], dependsOnShape: 'scalar', foldedUnder: 'work/b' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'stashed', 'queue', 'unstack']],
    // stackDropVerdict: a hand-written list is a fan-in nobody may collapse.
    ['a hand-written depends_on list is offered neither queue entry', { dependsOnShape: 'list', dependsOn: ['x', 'y'], foldedUnder: 'x' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'stashed']],
    ['a cycle is offered nothing: a span of time is not work', { isCycle: true }, null, []],
  ]

  it('offers exactly the destinations each guard allows', () => {
    const wrong = menus
      .map(([guard, state, column, menu]) => ({ guard, menu, got: ids(card(state), column) }))
      .filter(row => JSON.stringify(row.got) !== JSON.stringify(row.menu))
    expect(wrong).toEqual([])
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
