// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { card, response } from './testFixtures.js'
import { projectDeskFrontier, inFlightBand } from './KanbanReadModel.js'
import { applyOptimisticSurface, applyOptimisticTransition } from './KanbanModal.js'
import { boardCards } from './KanbanSurfaces.js'

const named = (cards: ReturnType<typeof card>[]) => cards.map(c => c.deskSection ? `${c.id}*` : c.id)

it('resting or judging a root keeps its place, and it still heads its asking thread', () => {
  const root = card({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [root], awaitingReview: [] }, threads: [ask] }))
  expect(named(data.now.inFlight)).toStrictEqual(['hub/ask', 'hub'])
  for (const result of [applyOptimisticSurface(data, 'hub')!, applyOptimisticTransition(data, 'hub', 'tempered')!]) {
    expect(named(result.now.inFlight)).toStrictEqual(['hub/ask'])
    expect(inFlightBand(result.now.inFlight[0])).toBe('yourTurn')
    expect([...result.stash, ...result.timeline.past].map(c => c.id)).toEqual(['hub'])
    expect(boardCards(result)).toHaveLength(2)
  }
  expect(boardCards(data).find(c => c.id === 'hub')?.workerState).toBe('running')
})
it('launching a quiet ancestor brings its own row in beside the header of its asking thread', () => {
  const root = card({ id: 'hub', status: 'open', effectiveHorizon: 'stashed' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [], awaitingReview: [] }, stash: [root], threads: [ask] }))
  expect(named(data.now.inFlight)).toStrictEqual(['hub/ask'])
  const armed = applyOptimisticTransition(data, 'hub', 'inFlight')!
  expect(named(armed.now.inFlight)).toStrictEqual(['hub/ask', 'hub'])
  const live = projectDeskFrontier({ ...armed, now: { ...armed.now, inFlight: armed.now.inFlight.map(c => c.id === 'hub' ? { ...c, workerState: 'running', runtimePhase: 'working', turn: 'working' as const } : c) } })
  expect(live.now.inFlight.map(c => inFlightBand(c))).toStrictEqual(['yourTurn', 'working'])
  // Once the question is answered, the working root is the family's only row.
  const answer = (c: ReturnType<typeof card>) => ({ ...c, ask: undefined, turn: c.turn === 'question' ? 'none' as const : c.turn })
  const answered = projectDeskFrontier({ ...live, now: { ...live.now, inFlight: live.now.inFlight.map(answer) }, threads: live.threads?.map(answer) })
  expect(named(answered.now.inFlight)).toStrictEqual(['hub'])
  expect(inFlightBand(answered.now.inFlight[0])).toBe('working')
})
