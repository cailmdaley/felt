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

describe('review actions stay on Awaiting review cards', () => {
  it('renders Temper and Discard only on actionable cards in that column', () => {
    const data = response({ now: {
      drafts: [card({ id: 'draft' })],
      inFlight: [card({ id: 'flight', status: 'active', shuttleKind: 'oneshot' })],
      awaitingReview: [card({ id: 'review', status: 'closed' })],
    } })
    const root = renderer().renderNowSection(data.now, data.staleness)
    expect(root.querySelector('[data-fiber-id="draft"] .kbn-card-review-meta-actions')).toBeNull()
    expect(root.querySelector('[data-fiber-id="flight"] .kbn-card-review-meta-actions')).toBeNull()
    const actions = root.querySelectorAll<HTMLButtonElement>('[data-fiber-id="review"] .kbn-review-meta-btn')
    expect([...actions].map((button) => button.textContent)).toEqual(['Temper', 'Discard'])
    expect([...actions].every((button) => button.type === 'button')).toBe(true)
  })
})
