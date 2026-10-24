// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installFrontierDetails } from './DeskFrontier.js'
import { ThreadIndex } from './threads.js'
import { card, response } from './testFixtures.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'

const root = card({ id: 'root', name: 'Quiet chair', status: 'open', effectiveHorizon: 'stashed' })
const work = card({ id: 'root/work', name: 'Analysis', orchestrator: 'root', status: 'active', workerState: 'running', runtimePhase: 'working' })
const ask = card({ id: 'root/work/ask', name: 'Choose cut', orchestrator: 'root/work', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' }, tags: ['pinned'] })
const quiet = card({ id: 'root/work/draft', orchestrator: 'root/work', status: 'open' })

describe('compact frontier rows', () => {
  it('draws clickable known ancestry and an awake-only count that opens the rail', () => {
    const host = document.createElement('div'), end = document.createElement('div'), open = vi.fn()
    host.append(end)
    installFrontierDetails(host, end, work, new ThreadIndex([root, work, ask, quiet]), open)
    expect(host.querySelector('.kbn-card-ancestry')?.textContent).toBe('Quiet chair › ')
    host.querySelector<HTMLButtonElement>('.kbn-card-ancestry button')!.click()
    expect(open).toHaveBeenLastCalledWith(root)
    const count = end.querySelector<HTMLButtonElement>('.kbn-thread-count')!
    expect(count.textContent).toBe('1 · 1 waiting')
    expect(count.classList.contains('kbn-thread-count-waiting')).toBe(true)
    count.click(); expect(open).toHaveBeenLastCalledWith(work, true)
    expect(host.querySelector('.kbn-thread-tree, .kbn-thread-subentries, .kbn-thread-pin')).toBeNull()
  })
  it('does not label reviews as waiting and never draws quiet-only counts', () => {
    const review = card({ id: 'root/work/review', orchestrator: work.id, status: 'closed' })
    const host = document.createElement('div'), open = vi.fn()
    installFrontierDetails(host, host, work, new ThreadIndex([work, review, quiet]), open)
    expect(host.querySelector('.kbn-thread-count')?.textContent).toBe('1')
    const onlyQuiet = document.createElement('div')
    installFrontierDetails(onlyQuiet, onlyQuiet, work, new ThreadIndex([work, quiet]), open)
    expect(onlyQuiet.querySelector('.kbn-thread-count')).toBeNull()
  })
  it('renders missing ancestors as plain path text, not an orphan label or guessed link', () => {
    const orphan = card({ id: 'missing/folder/work', orchestrator: 'missing-uid', status: 'active' })
    const host = document.createElement('div')
    installFrontierDetails(host, host, orphan, new ThreadIndex([orphan]), vi.fn())
    expect(host.textContent).toBe('missing › folder › ')
    expect(host.querySelector('button')).toBeNull()
  })
  for (const mobile of [false, true]) it(`keeps the same compact card and no family controls on ${mobile ? 'phone' : 'desktop'}`, () => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile }))
    try {
      const data = response({ now: { drafts: [], inFlight: [work], awaitingReview: [] }, threads: [root, ask, quiet] })
      const open = vi.fn()
      const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
        stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: open, onRefresh: () => {} })
      const section = renderer.renderNowSection(data.now, {})
      expect(section.querySelectorAll('.kbn-card')).toHaveLength(1)
      expect(section.querySelector('.kbn-card-ancestry')?.textContent).toContain('Quiet chair')
      expect(section.querySelector('.kbn-thread-count')?.textContent).toBe('1 · 1 waiting')
      expect(section.querySelector('.kbn-thread-peek, .kbn-thread-subentries, .kbn-thread-pin, .kbn-thread-mark')).toBeNull()
      section.querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
      expect(open).toHaveBeenCalledWith(work, true)
      section.querySelector<HTMLButtonElement>('.kbn-card-menu')!.click()
      expect(document.body.textContent).not.toMatch(/Expand family|Fold family/)
      renderer.closeMenu()
    } finally { vi.unstubAllGlobals() }
  })
})
