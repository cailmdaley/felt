// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { MOBILE_MEDIA } from './mobile.js'
import { card, response } from './testFixtures.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('a fresh phone Desk opens on In flight, its tabs one plain word each, the full name in the label', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  // No layout here: the pager is given a phone's width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
  const data = response({ now: { drafts: [card({ id: 'd' })], inFlight: [card({ id: 'f', status: 'active' })], awaitingReview: [] } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onRefresh: () => {} })
  document.body.append(renderer.renderNowSection(data.now, {}))
  for (const run of frames.splice(0)) run(0)
  expect(document.querySelector<HTMLElement>('.kbn-now-board')!.scrollLeft).toBe(390)
  const segs = [...document.querySelectorAll<HTMLElement>('.kbn-folio-seg')]
  expect(segs.map(seg => seg.querySelector('.kbn-folio-name')!.textContent)).toEqual(['Drafts', 'Live', 'Review'])
  expect(segs.map(seg => seg.getAttribute('aria-label'))).toEqual(['Drafts (1)', 'In flight (1)', 'Awaiting review (0)'])
  expect(document.querySelector('.kbn-folio .kbn-cap')).toBeNull()
  expect(segs.map(seg => seg.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
})
