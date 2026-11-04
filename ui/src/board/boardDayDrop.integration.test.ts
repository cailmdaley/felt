// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import { card, response } from './testFixtures'
import { isoDayLocal } from './civilDay'

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren() })

it('a live-card future-day drop sends only due, not kill or lifecycle requests', async () => {
  const writes: { url: string; body: unknown }[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method === 'POST') writes.push({ url: String(input), body: JSON.parse(String(init.body)) })
    return Response.json({})
  })
  vi.stubGlobal('fetch', fetcher)
  const board = new KanbanModal({ shuttleBase: 'https://board.example' }) as unknown as {
    lastResponse: ReturnType<typeof response>
    surfaces: { installTimelineDayDropHandlers(el: HTMLElement, day: string, label: string): void }
  }
  const live = card({ id: 'live', status: 'active', workerState: 'running', tmuxSession: 'worker' })
  board.lastResponse = response({ now: { drafts: [], inFlight: [live], awaitingReview: [] } })
  const day = isoDayLocal(Date.now() + 7 * 86_400_000)
  const target = document.createElement('div')
  board.surfaces.installTimelineDayDropHandlers(target, day, 'Schedule')
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: { getData: () => live.id } })
  target.dispatchEvent(drop)
  await vi.waitFor(() => expect(fetcher.mock.calls.some(([url]) => String(url).includes('/fibers/composite'))).toBe(true))
  expect(writes).toEqual([{
    url: 'https://board.example/api/v1/felt-edit', body: { fiber_id: 'live', origin: 'local', due: day },
  }])
})
