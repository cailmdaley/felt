import { expect, it } from 'vitest'
import { deskOrder, deskCardKey } from './deskOrdering.js'
import { projectDeskFrontier } from './KanbanReadModel.js'
import { card, response } from './testFixtures.js'

it('walks each constitution once, at its own row, never at a root heading another section', () => {
  const root = card({ id: 'hub', status: 'closed' })
  const ask = card({ id: 'hub/ask', orchestrator: 'hub', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const other = card({ id: 'solo', status: 'active', workerState: 'running', runtimePhase: 'working' })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [other], awaitingReview: [root] }, threads: [ask] }))
  expect(data.now.inFlight.map(c => [c.id, c.deskSection])).toEqual([['hub/ask', undefined], ['solo', undefined]])
  const order = deskOrder(data)
  expect(order.rows.map(c => c.id)).toEqual(['hub/ask', 'solo', 'hub'])
  expect(order.placements.get(deskCardKey(root))?.column).toBe('awaitingReview')
})
