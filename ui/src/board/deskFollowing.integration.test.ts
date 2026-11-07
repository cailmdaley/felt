// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { projectDeskFollowing, projectDeskFrontier } from './KanbanReadModel.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { card, response } from './testFixtures.js'

it('keeps the followed worker in Working and out of family needs, until the target moves', () => {
  const waiting = { status: 'active', workerState: 'running' as const, runtimePhase: 'waiting' }
  const root = card({ id: 'hub', ...waiting })
  const a = card({ id: 'hub/a', uid: 'a-uid', orchestrator: 'hub', ...waiting, ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
  const b = card({ id: 'hub/b', orchestrator: 'hub', ...waiting })
  const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [root], awaitingReview: [] }, threads: [a, b] }))
  const followed = projectDeskFollowing(data, { fiber_id: 'a-uid', origin: a.originId, name: a.name })
  const render = (view: typeof data) => new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => view,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn() }).renderNowSection(view.now, {})
  const section = render(followed)
  const yours = section.querySelector('[data-flight-band="yourTurn"]')!
  const working = section.querySelector('[data-flight-band="working"]')!
  expect(yours.querySelector('.kbn-count-needs')?.textContent).toBe('2 need you')
  expect(yours.querySelector('[data-fiber-id="hub/a"]')).toBeNull()
  expect(working.querySelector('[data-fiber-id="hub/a"] .constitution-state-dot')?.getAttribute('data-turn')).toBe('working')
  expect(render(data).querySelector('.kbn-count-needs')?.textContent).toBe('3 need you')
  const elsewhere = projectDeskFollowing(data, { fiber_id: 'a-uid', origin: 'other', name: a.name })
  expect(render(elsewhere).querySelector('.kbn-count-needs')?.textContent).toBe('3 need you')
})
