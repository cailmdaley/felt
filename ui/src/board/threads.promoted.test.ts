// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { card, response } from './testFixtures.js'
import { projectDeskFrontier, inFlightBand } from './KanbanReadModel.js'
import { applyOptimisticSurface, applyOptimisticTransition } from './KanbanModal.js'
import { boardCards } from './KanbanSurfaces.js'

it('resting or judging an awake root reveals its awake descendants immediately', () => {
  const root = card({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [root], awaitingReview: [] }, threads: [ask] }))
  for (const result of [applyOptimisticSurface(data, 'hub')!, applyOptimisticTransition(data, 'hub', 'tempered')!]) {
    expect(result.now.inFlight.map(c => c.id)).toStrictEqual(['hub/ask'])
    expect(result.stash).toHaveLength(0); expect(result.timeline.past).toHaveLength(0)
    expect(boardCards(result)).toHaveLength(2)
  }
  expect(data.now.inFlight[0].workerState).toBe('running')
})
it('launching a quiet ancestor folds its descendants without borrowing their turn', () => {
  const root = card({ id: 'hub', status: 'open', effectiveHorizon: 'stashed' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [ask], awaitingReview: [] }, threads: [root] }))
  // An armed ancestor alone remains quiet until its worker actually arrives.
  const armed = applyOptimisticTransition(data, 'hub', 'inFlight')!
  expect(armed.now.inFlight.map(c => c.id)).toStrictEqual(['hub/ask'])
  const live = projectDeskFrontier({ ...armed, threads: armed.threads?.map(c => c.id === 'hub' ? { ...c, workerState: 'running', runtimePhase: 'working' } : c) })
  expect(live.now.inFlight.map(c => c.id)).toStrictEqual(['hub'])
  expect(inFlightBand(live.now.inFlight[0])).toBe('working')
})
