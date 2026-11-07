// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { KanbanSurfaceRenderer, restingOrder } from './KanbanSurfaces.js'
import { DeskKeyboard } from './DeskKeyboard.js'
import { card, response } from './testFixtures.js'

it('folds each Desk section from its heading and remembers it across renders', () => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
  const data = response({ now: { drafts: [card({ id: 'draft' })], inFlight: [card({ id: 'work', status: 'active' })], awaitingReview: [card({ id: 'review', status: 'closed' })] } })
  const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn() })
  const draw = () => {
    const root = document.createElement('div')
    root.append(renderer.renderNowSection(data.now, {}), renderer.renderStashSection(restingOrder([]), {}), renderer.renderRolesSection([], {}))
    return root
  }
  let root = draw()
  const head = (selector: string) => root.querySelector<HTMLElement>(selector)!
  const draft = '[data-column="drafts"] .kbn-col-head'
  expect(head(draft).getAttribute('aria-expanded')).toBe('false')
  expect(root.querySelector<HTMLElement>('[data-column="drafts"] .kbn-col-list')!.hidden).toBe(true)
  for (const selector of ['[data-column="inFlight"] .kbn-col-head', '[data-column="awaitingReview"] .kbn-col-head', '.kbn-section-stash .kbn-bandhead', '.kbn-section-roles .kbn-bandhead']) {
    expect(head(selector).getAttribute('aria-expanded')).toBe('true')
    head(selector).click()
    expect(head(selector).getAttribute('aria-expanded')).toBe('false')
  }
  head(draft).click()
  root = draw()
  expect(head(draft).getAttribute('aria-expanded')).toBe('true')
  for (const selector of ['[data-column="inFlight"] .kbn-col-head', '[data-column="awaitingReview"] .kbn-col-head', '.kbn-section-stash .kbn-bandhead', '.kbn-section-roles .kbn-bandhead']) {
    expect(head(selector).getAttribute('aria-expanded')).toBe('false')
  }
  vi.unstubAllGlobals()
})

it('skips paginated resting rows when the whole Resting section is folded', () => {
  const root = document.createElement('div')
  root.innerHTML = `<section data-column="awaitingReview"><div data-card-uid="review" data-card-origin="local"></div></section>
    <section class="kbn-section-stash"><div hidden><div class="kbn-cluster-item" hidden data-card-uid="rest" data-card-origin="local"></div></div></section>
    <section class="kbn-section-roles"><div data-card-uid="role" data-card-origin="local"></div></section>`
  const keyboard = new DeskKeyboard(root, vi.fn())
  keyboard.handle('down')
  expect(keyboard.selection?.uid).toBe('review')
  keyboard.handle('down')
  expect(keyboard.selection?.uid).toBe('role')
  keyboard.dispose()
})
