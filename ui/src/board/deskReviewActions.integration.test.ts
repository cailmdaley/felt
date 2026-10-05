// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { card, response } from './testFixtures.js'

function renderer(): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => null,
    stopDragAutoScroll: () => {},
    transition: vi.fn(),
    setSurface: () => {},
    pin: () => {},
    stack: () => {},
    reorderQueue: () => {},
    unqueueRow: () => {},
    openDetail: () => {},
    onRefresh: () => {},
  })
}

describe('verdict actions ride cards awaiting review and in flight', () => {
  it('renders Temper and Discard on review and in-flight cards, never drafts', () => {
    const data = response({ now: {
      drafts: [card({ id: 'draft' })],
      inFlight: [card({ id: 'flight', status: 'active', shuttleKind: 'oneshot' })],
      awaitingReview: [card({ id: 'review', status: 'closed' })],
    } })
    const root = renderer().renderNowSection(data.now, data.staleness)
    expect(root.querySelector('[data-fiber-id="draft"] .kbn-card-review-meta-actions')).toBeNull()
    for (const id of ['flight', 'review']) {
      const actions = root.querySelectorAll<HTMLButtonElement>(`[data-fiber-id="${id}"] .kbn-review-meta-btn`)
      expect([...actions].map((button) => button.textContent)).toEqual(['Temper', 'Discard'])
      expect([...actions].every((button) => button.type === 'button')).toBe(true)
    }
  })
})
