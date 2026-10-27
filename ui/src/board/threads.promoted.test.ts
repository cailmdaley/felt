// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { card, response } from './testFixtures.js'
import { projectDeskFrontier, inFlightBand } from './KanbanReadModel.js'
import { applyOptimisticSurface, applyOptimisticTransition } from './KanbanModal.js'
import { boardCards } from './KanbanSurfaces.js'

it('resting or judging a root leaves its family on the asking thread, at once', () => {
  const root = card({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [root], awaitingReview: [] }, threads: [ask] }))
  for (const result of [applyOptimisticSurface(data, 'hub')!, applyOptimisticTransition(data, 'hub', 'tempered')!]) {
    expect(result.now.inFlight.map(c => c.id)).toStrictEqual(['hub/ask'])
    expect(result.stash).toHaveLength(0); expect(result.timeline.past).toHaveLength(0)
    expect(boardCards(result)).toHaveLength(2)
  }
  expect(data.threads?.find(c => c.id === 'hub')?.workerState).toBe('running')
})
it('launching a quiet ancestor leaves the row on the thread that asks, folding the ancestor in', () => {
  const root = card({ id: 'hub', status: 'open', effectiveHorizon: 'stashed' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [ask], awaitingReview: [] }, threads: [root] }))
  // An armed ancestor alone remains quiet until its worker actually arrives.
  const armed = applyOptimisticTransition(data, 'hub', 'inFlight')!
  expect(armed.now.inFlight.map(c => c.id)).toStrictEqual(['hub/ask'])
  const live = projectDeskFrontier({ ...armed, threads: armed.threads?.map(c => c.id === 'hub' ? { ...c, workerState: 'running', runtimePhase: 'working' } : c) })
  expect(live.now.inFlight.map(c => c.id)).toStrictEqual(['hub/ask'])
  expect(inFlightBand(live.now.inFlight[0])).toBe('yourTurn')
  // Once the question is answered, the working root is the family's row.
  const answered = projectDeskFrontier({ ...live, now: { ...live.now, inFlight: live.now.inFlight.map(c => ({ ...c, ask: undefined })) } })
  expect(answered.now.inFlight.map(c => c.id)).toStrictEqual(['hub'])
  expect(inFlightBand(answered.now.inFlight[0])).toBe('working')
})
