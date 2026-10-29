// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installFrontierDetails } from './DeskFrontier.js'
import { ThreadIndex } from './threads.js'
import { card, response } from './testFixtures.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { projectDeskFrontier } from './KanbanReadModel.js'

const root = card({ id: 'root', name: 'Quiet chair', status: 'open', effectiveHorizon: 'stashed' })
const work = card({ id: 'root/work', name: 'Analysis', orchestrator: 'root', status: 'active', workerState: 'running', runtimePhase: 'working' })
const ask = card({ id: 'root/work/ask', name: 'Choose cut', orchestrator: 'root/work', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' }, tags: ['pinned'] })
const quiet = card({ id: 'root/work/draft', orchestrator: 'root/work', status: 'open' })

describe('a family row', () => {
  it('a deep asker leads with an elided crumb whose root opens the family, and the count names work', () => {
    const host = document.createElement('div'), name = document.createElement('span'), end = document.createElement('div'), open = vi.fn()
    name.className = 'kbn-card-name'; name.textContent = ask.name; host.append(name, end)
    installFrontierDetails(host, end, ask, new ThreadIndex([root, work, ask, quiet]), open)
    expect(name.textContent).toBe('Quiet chair / … /\u00a0Choose cut')
    expect(name.querySelector('.kbn-card-crumb')!.getAttribute('title')).toBe('Quiet chair › Analysis')
    name.querySelector<HTMLButtonElement>('.kbn-card-crumb button')!.click()
    expect(open).toHaveBeenLastCalledWith(root, true)
    const count = end.querySelector<HTMLButtonElement>('.kbn-thread-count')!
    expect(count.querySelector('.kbn-count-working')?.textContent).toBe('1 working')
    expect(count.querySelector('.kbn-count-needs')).toBeNull()
    count.click(); expect(open).toHaveBeenLastCalledWith(root, true)
    expect(host.querySelector('.kbn-family-asks')).toBeNull()
  })
  it('a node that is not its family\'s row draws only its crumb', () => {
    const host = document.createElement('div'), open = vi.fn()
    installFrontierDetails(host, host, work, new ThreadIndex([root, work, ask, quiet]), open)
    expect(host.textContent).toBe('Quiet chair /\u00a0')
  })
  it('never draws a tail for quiet kin', () => {
    const lone = document.createElement('div')
    installFrontierDetails(lone, lone, work, new ThreadIndex([work, quiet]), vi.fn())
    expect(lone.querySelector('.kbn-thread-count')).toBeNull()
  })
  it('renders missing ancestors as plain path text, not an orphan label or guessed link', () => {
    const orphan = card({ id: 'missing/folder/work', orchestrator: 'missing-uid', status: 'active' })
    const host = document.createElement('div')
    installFrontierDetails(host, host, orphan, new ThreadIndex([orphan]), vi.fn())
    expect(host.textContent).toBe('missing / … /\u00a0')
    expect(host.querySelector('button')).toBeNull()
  })
  it('the others asking the same thing are indented sub-lines that open themselves', () => {
    const second = card({ id: 'root/second', name: 'Second ask', orchestrator: 'root', status: 'active', workerState: 'running', runtimePhase: 'waiting' })
    const host = document.createElement('div'), open = vi.fn()
    installFrontierDetails(host, host, ask, new ThreadIndex([root, work, ask, second]), open)
    const lines = [...host.querySelectorAll<HTMLButtonElement>('.kbn-family-ask-name')]
    expect(lines.map(l => l.textContent)).toEqual(['Second ask'])
    lines[0].click(); expect(open).toHaveBeenLastCalledWith(second)
    expect(host.querySelector('.kbn-family-more')).toBeNull()
  })
  for (const mobile of [false, true]) it(`draws the same row on ${mobile ? 'phone' : 'desktop'}`, () => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile }))
    try {
      const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [work], awaitingReview: [] }, threads: [root, ask, quiet] }))
      const open = vi.fn()
      const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
        stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: open })
      const section = renderer.renderNowSection(data.now, {})
      expect(section.querySelectorAll('.kbn-card')).toHaveLength(1)
      expect(section.querySelector('.kbn-card-name')?.textContent).toBe('Quiet chair / … /\u00a0Choose cut')
      expect(section.querySelector('.kbn-count-working')?.textContent).toBe('1 working')
      section.querySelector<HTMLButtonElement>('.kbn-thread-count')!.click()
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'root' }), true)
    } finally { vi.unstubAllGlobals() }
  })
})
