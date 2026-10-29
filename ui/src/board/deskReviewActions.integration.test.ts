// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { card, response } from './testFixtures.js'
import { Verdicts } from './workspace/Verdicts.js'

function renderer(): KanbanSurfaceRenderer {
  return new KanbanSurfaceRenderer({
    getDragSourceId: () => null,
    setDragSourceId: () => {},
    getLastResponse: () => null,
    stopDragAutoScroll: () => {},
    transition: vi.fn(),
    setSurface: () => {},
    openDetail: () => {},
  })
}

describe('verdict actions ride cards awaiting review and in flight', () => {
  it('offers the header verbs on review and in-flight cards, none on a plain note', () => {
    const data = response({ now: {
      drafts: [card({ id: 'draft' })],
      inFlight: [card({ id: 'flight', status: 'active', shuttleKind: 'oneshot' })],
      awaitingReview: [card({ id: 'review', status: 'closed', shuttleKind: 'oneshot' })],
    } })
    const surfaces = renderer()
    const root = surfaces.renderNowSection(data.now, data.staleness)
    document.body.append(root)
    try {
      for (const id of ['draft', 'flight', 'review']) {
        expect(root.querySelector(`[data-fiber-id="${id}"] .kbn-card-menu`)).toBeNull()
        root.querySelector<HTMLElement>(`[data-fiber-id="${id}"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        const actions = document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
        // The header's verbs for each place: work in flight can also be closed for review; a plain note takes none.
        expect([...actions].map(button => button.textContent)).toEqual({ draft: [], flight: ['Close for review', 'Temper', 'Discard'], review: ['Temper', 'Discard'] }[id])
        expect([...actions].every(button => button.type === 'button')).toBe(true)
        surfaces.closeMenu()
      }
    } finally { surfaces.closeMenu(); document.body.replaceChildren() }
  })
  it('waits out every Desk verdict on the card\'s own foot, whatever the column', async () => {
    vi.useFakeTimers()
    const draft = card({ id: 'draft', uid: 'draft-uid' }), review = card({ id: 'review', status: 'closed' })
    const data = response({ now: { drafts: [draft], inFlight: [], awaitingReview: [review] } })
    const root = renderer().renderNowSection(data.now, data.staleness)
    document.body.append(root)
    const verdicts = new Verdicts()
    try {
      verdicts.queue(review, 'tempered', vi.fn())
      verdicts.queue(draft, 'composted', vi.fn())
      const foot = (id: string) => root.querySelector<HTMLElement>(`[data-fiber-id="${id}"] .kbn-card-meta`)!
      expect(foot('review').querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Tempered·undo z')
      expect(foot('draft').querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Discarded·undo z')
      // A re-render mid-window keeps the line on the rebuilt card.
      const again = renderer().renderNowSection(data.now, data.staleness)
      root.replaceWith(again); await Promise.resolve()
      expect(again.querySelectorAll('.kbn-card-meta > .ws-verdict-undo')).toHaveLength(2)
    } finally { verdicts.dispose(); document.body.replaceChildren(); vi.useRealTimers() }
  })
})
