// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { MOBILE_MEDIA } from './mobile.js'
import { card, response } from './testFixtures.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('a fresh phone Desk opens on In flight and names every tab exactly as its column', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  // No layout here: the pager is given a phone's width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(390)
  const data = response({ now: { drafts: [card({ id: 'd' })], inFlight: [card({ id: 'f', status: 'active' })], awaitingReview: [] } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn() })
  document.body.append(renderer.renderNowSection(data.now, {}))
  for (const run of frames.splice(0)) run(0)
  expect(document.querySelector<HTMLElement>('.kbn-now-board')!.scrollLeft).toBe(390)
  const segs = [...document.querySelectorAll<HTMLElement>('.kbn-folio-seg')]
  expect(segs.map(seg => seg.querySelector('.kbn-folio-name')!.textContent)).toEqual(['Drafts', 'In flight', 'Awaiting review'])
  expect(segs.map(seg => seg.getAttribute('aria-label'))).toEqual(['Drafts (1)', 'In flight (1)', 'Awaiting review (0)'])
  expect(document.querySelector('.kbn-folio .kbn-cap')).toBeNull()
  expect(segs.map(seg => seg.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
})

it('names the Stash and New idea actions beside their glyphs and leaves Awaiting review quiet', () => {
  const stash = vi.fn(), idea = vi.fn()
  const data = response({ now: {
    drafts: [card({ id: 'draft' })],
    inFlight: [card({ id: 'flight', status: 'active' })],
    awaitingReview: [card({ id: 'review', status: 'closed' })],
  } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onStashClick: stash, onNewIdeaClick: idea })
  const root = renderer.renderNowSection(data.now, {})
  const actions = [...root.querySelectorAll<HTMLButtonElement>('.kbn-col-action')]
  expect(actions.map(action => action.textContent)).toEqual(['+Stash', '✶New idea'])
  expect(actions.map(action => action.getAttribute('aria-label'))).toEqual(['Stash a new fiber', 'New idea — speak it into a card'])
  expect(root.querySelector('.kbn-col-action-awaitingReview')).toBeNull()
  actions[0].click(); actions[1].click()
  expect(stash).toHaveBeenCalledOnce()
  expect(idea).toHaveBeenCalledOnce()
})
