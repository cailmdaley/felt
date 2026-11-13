// @vitest-environment jsdom
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { MOBILE_MEDIA } from './mobile.js'
import { card, response, settle } from './testFixtures.js'

afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('a fresh phone Desk opens on In flight and names every tab exactly as its column', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  // No layout here: the pager is given a phone's width.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
  const data = response({ now: { drafts: [card({ id: 'd' })], inFlight: [card({ id: 'f', status: 'active' })], awaitingReview: [] } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn() })
  document.body.append(renderer.renderNowSection(data.now, {}))
  for (const run of frames.splice(0)) run(0)
  await settle()
  expect(document.querySelector<HTMLElement>('.kbn-now-board')!.scrollLeft).toBe(375)
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Now — which column is showing"] [role="tab"]')]
  expect(tabs.map(tab => tab.querySelector('.kbn-folio-name')!.textContent)).toEqual(['Drafts', 'In flight', 'Awaiting review'])
  expect(tabs.map(tab => tab.getAttribute('aria-label'))).toEqual(['Drafts (1)', 'In flight (1)', 'Awaiting review (0)'])
  expect(document.querySelector('.kbn-folio .kbn-cap')).toBeNull()
  expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false'])
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1])
  expect(tabs[1].querySelector('.kbn-folio-count')?.textContent).toBe('1')
})

it('turns the pager from the folio tabs by press, arrows, Home and End, and marks the leaf the pager lands on', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => frames.push(run))
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(375)
  const turns: number[] = []
  // jsdom has no scrolling: the pager lands at once and says so.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    turns.push(options.left!)
    this.scrollLeft = options.left!
    this.dispatchEvent(new Event('scroll'))
  } })
  onTestFinished(() => { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo })
  const data = response({ now: { drafts: [card({ id: 'd' })], inFlight: [card({ id: 'f', status: 'active' })], awaitingReview: [] } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn(), onNewIdeaClick: vi.fn() })
  document.body.append(renderer.renderNowSection(data.now, {}))
  for (const run of frames.splice(0)) run(0)
  await settle()
  const tabs = [...document.querySelectorAll<HTMLElement>('.kbn-folio [role="tab"]')]
  const board = document.querySelector<HTMLElement>('.kbn-now-board')!
  // The adopted action sits beside its tab, never inside it.
  expect(tabs.some(tab => tab.querySelector('button'))).toBe(false)
  expect(document.querySelector('.kbn-folio-seg-active .kbn-col-action')).not.toBeNull()
  tabs[1].focus()
  for (const [key, leaf] of [['ArrowRight', 2], ['ArrowRight', 0], ['End', 2], ['ArrowLeft', 1], ['Home', 0]] as const) {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    await settle()
    expect(document.activeElement).toBe(tabs[leaf])
    expect(board.scrollLeft).toBe(leaf * 375)
    expect(tabs.map(tab => tab.getAttribute('aria-selected') === 'true')).toEqual([0, 1, 2].map(i => i === leaf))
    expect(document.querySelector('.kbn-folio-seg-active')).toBe(tabs[leaf].closest('.kbn-folio-seg'))
  }
  tabs[2].click()
  await settle()
  expect(turns.at(-1)).toBe(750)
  // A swipe is the pager's own: the strip follows the scroll.
  board.scrollLeft = 375
  board.dispatchEvent(new Event('scroll'))
  await settle()
  expect(tabs.map(tab => tab.tabIndex)).toEqual([-1, 0, -1])
})

it('draws the Stash and New idea actions as bare glyphs named for assistive tech and leaves Awaiting review quiet', () => {
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
  expect(actions.map(action => action.textContent)).toEqual(['+', '✶'])
  expect(actions.map(action => action.getAttribute('aria-label'))).toEqual(['Stash a new fiber', 'New idea — speak it into a card'])
  expect(root.querySelector('.kbn-col-action-awaitingReview')).toBeNull()
  actions[0].click(); actions[1].click()
  expect(stash).toHaveBeenCalledOnce()
  expect(idea).toHaveBeenCalledOnce()
})
