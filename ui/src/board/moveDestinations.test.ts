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

const at0 = '2026-01-01T00:00:00Z'

const card = (over: Partial<KanbanCard> = {}): KanbanCard => ({
  id: 'work/a',
  name: 'A',
  path: 'work/a.md',
  originId: 'here',
  status: 'active',
  createdAt: at0,
  dependsOnSatisfied: true,
  effectiveHorizon: 'now',
  drifted: false,
  isCycle: false,
  cycleStart: null,
  ...over,
})

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
  it('withholds both surfaces from a standing role, and the queue with them', () => {
    const d = ids(card({ shuttleKind: 'standing', effectiveHorizon: 'stashed' }), null)
    expect(d).not.toContain('now')
    expect(d).not.toContain('stashed')
    expect(d).not.toContain('queue')
    expect(d).toContain('inFlight') // drag-to-In-flight still runs it now
  })

  // setSurface's pinned-at-rest guard, and pinRole's "already pinned".
  it('offers a resting pinned role only the unpin and the lifecycle moves', () => {
    const d = ids(card({ shuttleKind: 'pinned', status: 'active' }), null)
    expect(d).toEqual(['inFlight', 'drafts', 'unpin'])
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

  // setSurface: a dep-gated card asking for Now is asking to leave the queue.
  it('replaces "bring to the desk" with the queue exit for a gated card', () => {
    const d = ids(
      card({ depGated: true, dependsOn: ['work/b'], dependsOnShape: 'scalar', effectiveHorizon: 'stashed' }),
      null,
    )
    expect(d).toContain('unstack')
    expect(d).not.toContain('now')
  })

  // setSurface: re-resting a gated closed card would reopen it.
  it('will not re-rest a gated card that is already closed', () => {
    const d = ids(card({ depGated: true, status: 'closed', tempered: false }), 'composted')
    expect(d).not.toContain('stashed')
  })

  // stackDropVerdict: a hand-written list is a fan-in nobody may collapse.
  it('leaves a hand-written depends_on list alone', () => {
    const d = ids(card({ dependsOnShape: 'list', dependsOn: ['x', 'y'], depGated: true }), null)
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
  const deps = buildDependents(all.filter((x) => x.tempered !== true))

  it('offers every card the drop would accept, and resolves to the chain tail', () => {
    const targets = queueTargets(a, all, deps)
    expect(targets.map((t) => t.card.id).sort()).toEqual(['b', 'c'])
    // Dropping onto B joins the END of B's queue, which is C.
    expect(targets.find((t) => t.card.id === 'b')?.tail).toBe('c')
  })

  it('excludes the card itself and a tempered tail', () => {
    const targets = queueTargets(a, all, deps).map((t) => t.card.id)
    expect(targets).not.toContain('a')
    expect(targets).not.toContain('d')
  })

  it('excludes a target the card is already queued behind', () => {
    expect(queueTargets(c, all, deps).map((t) => t.card.id)).not.toContain('b')
  })
})
