// The Move menu's destination list, held against the drag's own legality.
//
// The menu exists because drag-and-drop has no touch backend, so the one
// property worth pinning is AGREEMENT: an entry appears iff the equivalent
// drop would have committed rather than bannered. Each case below names the
// guard in KanbanModal / KanbanRules it is standing in for.

import { describe, expect, it } from 'vitest'
import { moveDestinations } from './MoveDestinations.js'
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
    ])
  })

  it('labels every destination with the board\'s own name for the place', () => {
    const labels = new Map(
      moveDestinations(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts').map((d) => [d.id, d.label]),
    )
    expect(labels.get('inFlight')).toBe('In flight')
    expect(labels.get('awaitingReview')).toBe('Awaiting review')
    expect(labels.get('stashed')).toBe('Resting')
  })

  it('puts the Now columns in one group and everything else in the other', () => {
    const d = moveDestinations(card({ status: 'open', shuttleKind: 'oneshot' }), 'drafts')
    expect(d.filter((x) => x.group === 'column').map((x) => x.id)).toEqual(['inFlight', 'awaitingReview'])
    expect(d.filter((x) => x.group === 'other').map((x) => x.id)).toEqual(['stashed'])
  })

  // One row per guard the menu mirrors: the card's state, where the board has
  // it, and the exact menu that state earns. Exact lists, so an entry that
  // appears where no drop would commit fails as loudly as one that vanishes.
  const menus: [guard: string, state: Partial<KanbanCard>, column: Parameters<typeof moveDestinations>[1], menu: string[]][] = [
    // `transition`'s one no-op guard, `fromKind === target`; the desk is
    // likewise withheld from a card already on it.
    ['a one-shot in In flight is not offered In flight or the desk', { shuttleKind: 'oneshot' }, 'inFlight',
      ['drafts', 'awaitingReview', 'stashed']],
    // Resting from In flight: the board's rest, the worker's `shuttle rest`
    // said by hand.
    ['a live one-shot is offered Resting — put down without review', { shuttleKind: 'oneshot', workerState: 'running', tmuxSession: 'w' }, 'inFlight',
      ['drafts', 'awaitingReview', 'stashed']],
    ['a block-less draft is not offered Drafts', { status: 'open' }, 'drafts',
      ['inFlight', 'awaitingReview', 'stashed']],
    // Awaiting review is a plain lifecycle drop with no gate of its own, so it
    // is offered from every column but its own; a closed card is off the desk.
    ['an awaiting card is offered every other column and the desk', { status: 'closed' }, 'awaitingReview',
      ['drafts', 'inFlight', 'now', 'stashed']],
    ['a closed card that still carries the now horizon is offered the desk', { status: 'closed', effectiveHorizon: 'now', shuttleKind: 'oneshot' }, 'awaitingReview',
      ['drafts', 'inFlight', 'now', 'stashed']],
    ['a tempered card is offered Awaiting review and both surfaces', { status: 'closed', tempered: true }, 'tempered',
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'stashed']],
    ['a resting card is not offered Resting', { status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed' }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'now']],
    // setSurface compares the card's `cold` against the gesture's, and a menu
    // Rest carries none, so clearing the flag is the move.
    ['a resting cold card is offered Resting', { status: 'open', effectiveHorizon: 'stashed', storedHorizon: 'stashed', cold: true }, null,
      ['drafts', 'inFlight', 'awaitingReview', 'now', 'stashed']],
    // setSurface's standing guard: "it runs on its schedule". Drag-to-In-flight
    // still runs it now.
    ['a standing constitution is withheld both surfaces', { shuttleKind: 'standing', effectiveHorizon: 'stashed' }, null,
      ['drafts', 'inFlight', 'awaitingReview']],
    ['a cycle is offered nothing: a span of time is not work', { isCycle: true }, null, []],
  ]

  it('offers exactly the destinations each guard allows', () => {
    const wrong = menus
      .map(([guard, state, column, menu]) => ({ guard, menu, got: ids(card(state), column) }))
      .filter(row => JSON.stringify(row.got) !== JSON.stringify(row.menu))
    expect(wrong).toEqual([])
  })
})
