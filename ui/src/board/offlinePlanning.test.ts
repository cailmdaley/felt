import { describe, expect, it } from 'vitest'
import { parseCompositeFeed } from './KanbanComposite.js'
import { cardFromCompositeEntry } from './KanbanReadModel.js'
import { moveDestinations } from './MoveDestinations.js'
import { canPlanOffline, offlineExplanation } from './offlinePlanning.js'
import { lifecycleVerbsFor, sessionVerbsFor } from './workspace/lifecycleVerbs.js'

function archive(kind = 'oneshot', capable = true, status = 'active') {
  const feed = parseCompositeFeed({ host: 'hub', fibers: [{
    origin: 'removed', local_planning: capable, felt_store: '/archive', path: 'work/events/2611-ade/2611-ade.md',
    fiber: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', slug: 'work/events/2611-ade', name: 'Offline work', status,
      shuttle: { kind, host: 'removed', schedule: { expr: '0 9 * * *' }, runtime: { session_uuid: 'unconcluded' } } },
  }], origins: { removed: { kind: 'archive', stale: true } } })
  return cardFromCompositeEntry(feed.entries[0])
}

describe('daemon-provided exit capability through the real composite read model', () => {
  it.each(['oneshot', 'pinned', 'standing'])('lets a removed-host %s leave despite unconcluded archive evidence', kind => {
    const card = archive(kind)
    expect(card.originId).toBe('removed')
    expect(card.originStale).toBeDefined()
    expect(canPlanOffline(card)).toBe(true)
    expect(lifecycleVerbsFor(card, true)).toContain('rest')
    expect(lifecycleVerbsFor(card, true)).toContain('discard')
    expect(lifecycleVerbsFor(card, true)).not.toContain('temper')
    expect(sessionVerbsFor(card)).toEqual([])
    expect(moveDestinations(card, 'inFlight').map(place => place.id)).toEqual(['awaitingReview', 'stashed'])
    expect(offlineExplanation(card)).not.toContain('Reconnect')
  })

  it('withholds scheduled-standing, remote-only and unowned inconclusive saves when the daemon refuses them', () => {
    for (const card of [archive('standing', false, 'closed'), archive('oneshot', false), { ...archive('oneshot', false), shuttleHost: '' }]) {
      expect(canPlanOffline(card)).toBe(false)
      expect(lifecycleVerbsFor(card, true)).toEqual([])
      expect(moveDestinations(card, null)).toEqual([])
      expect(sessionVerbsFor(card)).toEqual([])
      expect(offlineExplanation(card)).not.toContain('can be saved')
    }
  })

  it('preserves a healthy owner row and its waiting-for-sync explanation', () => {
    const feed = parseCompositeFeed({ host: 'hub', fibers: [{ origin: 'owner', planning_pending: true,
      felt_store: '/owner', path: 'work/item/item.md', fiber: { id: '01ARZ3NDEKTSV4RRFFQ69G5FAX', slug: 'work/item',
        name: 'Owner draft', status: 'open', outcome: 'Owner result', shuttle: { kind: 'oneshot', host: 'owner' } },
    }], origins: { owner: { kind: 'remote', stale: false } } })
    const card = cardFromCompositeEntry(feed.entries[0])
    expect(card.status).toBe('open')
    expect(card.outcome).toBe('Owner result')
    expect(card.originStale).toBeUndefined()
    expect(card.planningPending).toBe(true)
    expect(offlineExplanation(card)).toContain('waiting for Git sync')
    expect(lifecycleVerbsFor(card, true)).toEqual([])
    expect(moveDestinations(card, 'drafts')).toEqual([])
  })
})
