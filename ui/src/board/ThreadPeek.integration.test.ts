// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFrontierDetails } from './DeskFrontier.js'
import { ThreadIndex } from './threads.js'
import { card, response } from './testFixtures.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { projectDeskFrontier } from './KanbanReadModel.js'

const waiting = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const }
const working = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const }
const root = card({ id: 'proj/hub', name: 'Hub', ...waiting })
const busy = card({ id: 'proj/hub/busy', name: 'Busy', orchestrator: 'proj/hub', createdAt: '2026-10-01T00:00:00Z', ...working })
const asks = card({ id: 'proj/hub/busy/asks', name: 'Choose a cut', orchestrator: 'proj/hub/busy', createdAt: '2026-10-02T00:00:00Z', status: 'active', ask: { text: 'Which?', at: '2026-10-01T00:00:00Z' } })
const deeper = card({ id: 'proj/hub/busy/asks/deeper', name: 'Deeper', orchestrator: 'proj/hub/busy/asks', ...waiting })
const helper = card({ id: 'proj/hub/busy/helper', name: 'Helper', orchestrator: 'proj/hub/busy', createdAt: '2026-10-03T00:00:00Z', ...working })
const done = card({ id: 'proj/hub/done', name: 'Done', orchestrator: 'proj/hub', status: 'closed', tempered: true })
const all = [root, busy, asks, deeper, helper, done]

function row(of: typeof root, cards = all) {
  const host = document.createElement('div'), name = document.createElement('span'), end = document.createElement('div'), open = vi.fn()
  name.className = 'kbn-card-name'; name.textContent = of.name; host.append(name, end)
  installFrontierDetails(host, end, of, new ThreadIndex(cards), open)
  const names = () => [...host.querySelectorAll<HTMLElement>('.kbn-desk-threads .kbn-thread-row')].map(r => `${'  '.repeat(Number(r.dataset.depth))}${r.querySelector('.kbn-thread-name')!.textContent}`)
  const count = host.querySelector<HTMLButtonElement>('.kbn-thread-count')
  return { host, name, end, open, names, count }
}

describe('a Desk row and the threads it holds in its section', () => {
  beforeEach(() => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) })
    return () => vi.unstubAllGlobals()
  })
  it('in Your turn, holds the threads that wait on you beneath their nearest shown ancestor, open, named by slug path', () => {
    const { names, count, host, open } = row(root)
    expect(names()).toEqual(['busy/asks', '  deeper'])
    expect(count!.querySelector('.kbn-count-needs')?.textContent).toBe('2 need you')
    expect(count!.querySelector('[data-asks]')).not.toBeNull()
    const line = host.querySelector<HTMLElement>('.kbn-desk-threads .kbn-thread-row')!
    expect(line.title).toBe('Choose a cut')
    line.click(); expect(open).toHaveBeenLastCalledWith(asks)
    // Each level folds on its own caret.
    line.querySelector<HTMLButtonElement>('button.kbn-thread-fold')!.click()
    expect(names()).toEqual(['busy/asks'])
    count!.click()
    expect(names()).toEqual([])
  })
  it('heads Working with the root when its own state is another, faint, its working threads folded until opened, each level on its own', () => {
    const { host, name, names, count } = row({ ...root, deskSection: 'working' })
    expect(name.textContent).toBe('Hub')
    expect(host.classList.contains('kbn-card-header')).toBe(true)
    expect(count!.querySelector('.kbn-count-working')?.textContent).toBe('2 working')
    expect(names()).toEqual([])
    count!.click()
    expect(names()).toEqual(['busy'])
    host.querySelector<HTMLButtonElement>('.kbn-desk-threads button.kbn-thread-fold')!.click()
    expect(names()).toEqual(['busy', '  helper'])
    // The folds are remembered by section: drawn again, Working stands as left, and Your turn keeps its own.
    expect(row({ ...root, deskSection: 'working' }).names()).toEqual(['busy', '  helper'])
    expect(row(root).names()).toEqual(['busy/asks', '  deeper'])
  })
  it('draws no count where the section holds nothing beneath the row, and never an archived thread', () => {
    const lone = card({ id: 'proj/lone', name: 'Lone', ...waiting })
    const { count, host } = row(lone, [lone])
    expect(count).toBeNull()
    expect(host.querySelector('.kbn-desk-threads')).toBeNull()
    expect(row(root).host.textContent).not.toMatch(/done/)
  })
  it('names a thread whose ancestors are missing by their path', () => {
    const orphan = card({ id: 'missing/folder/work', orchestrator: 'missing-uid', status: 'active' })
    expect(row(orphan, [orphan]).name.textContent).toBe('missing/folder/work')
  })
  for (const mobile of [false, true]) it(`draws the same row on ${mobile ? 'phone' : 'desktop'}`, () => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile }))
    const data = projectDeskFrontier(response({ now: { drafts: [], inFlight: [root, busy], awaitingReview: [] }, threads: [asks, deeper, helper] }))
    const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => data,
      stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: vi.fn() })
    const section = renderer.renderNowSection(data.now, {})
    expect([...section.querySelectorAll('.kbn-card .kbn-card-name')].map(n => n.textContent)).toEqual(['Hub', 'Hub'])
    expect([...section.querySelectorAll('.kbn-desk-threads .kbn-thread-name')].map(n => n.textContent)).toEqual(['busy/asks', 'deeper'])
  })
})
