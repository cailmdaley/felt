// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard, KanbanResponse } from '../KanbanTypes.js'
import type { TemporalView, ViewContext } from './ViewRegistry.js'

const now = Date.now(), hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()
const hub = card({ id: 'sci/hub', uid: 'hub', name: 'Hub', status: 'active', createdAt: when(300), workerState: 'running', runtimePhase: 'working', sessionUuid: 's0' })
const asked = card({ id: 'sci/hub/asked', uid: 'asked', name: 'Asked', orchestrator: 'sci/hub', status: 'active', createdAt: when(10), ask: { text: 'Which?', at: when(1) }, sessionUuid: 's1' })
const done = card({ id: 'sci/hub/done', uid: 'done', name: 'Done work', orchestrator: 'sci/hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5), sessionUuid: 's2' })
const quietAsk = card({ id: 'life/admin/form', uid: 'form', name: 'A form', status: 'active', createdAt: when(50), ask: { text: 'Sign?', at: when(2) } })
const lifeNote = card({ id: 'life/admin/note', uid: 'note', name: 'A note', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(40) })
const cards: KanbanCard[] = [hub, asked, done, quietAsk, lifeNote]
const response = (list = cards): KanbanResponse => ({
  feltHost: list[0].originId, now: { drafts: [], inFlight: list, awaitingReview: [] }, timeline: { past: [], futureDated: [] }, stash: [], roles: [], threads: [], cycles: [],
} as unknown as KanbanResponse)

const workspace = {
  mountOverview: vi.fn(), hideOverview: vi.fn(), isActive: false,
  dock: { openConversation: vi.fn() }, openFromDesk: vi.fn(), openPage: vi.fn(), readLead: vi.fn(async () => undefined),
}
const context = (list = cards): ViewContext => ({ response: response(list), cards: list, workspace, shuttleBase: '' } as unknown as ViewContext)
let view: TemporalView
let host: HTMLElement
const list = (): HTMLElement => host.querySelector('[role="tree"]')!
const rows = (): string[] => [...host.querySelectorAll('.tree-name')].map(el => el.textContent!)
const row = (name: string): HTMLElement => [...host.querySelectorAll<HTMLElement>('.tree-row')].findLast(el => el.querySelector('.tree-name')?.textContent === name)!
const selected = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('[aria-selected="true"]')]
const key = (name: string): void => { view.keydown!(new KeyboardEvent('keydown', { key: name, bubbles: true })) }

beforeEach(async () => {
  vi.resetModules()
  await import('./TreeView.js')
  view = (await import('./ViewRegistry.js')).getView('tree')!
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) })
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ files: [{ uid: 'hub', fullPath: '/r/plot.png', basename: 'plot.png', timestamp: now - hour, host: hub.originId }] }) })))
  Element.prototype.scrollIntoView = vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  view.mount(host, context())
})
afterEach(() => { view.unmount(); host.remove(); vi.unstubAllGlobals() })

describe('the Tree', () => {
  it('is a real ARIA tree, with one selection', () => {
    expect(list().getAttribute('aria-activedescendant')).toBe(selected()[0].id)
    expect(selected()).toHaveLength(1)
    const top = row('Hub')
    expect([top.getAttribute('role'), top.getAttribute('aria-level'), top.getAttribute('aria-expanded')]).toEqual(['treeitem', '1', 'true'])
    expect(row('Asked').getAttribute('aria-level')).toBe('2')
  })
  it('shows live work by default and folds the rest', () => {
    expect(rows()).toEqual(expect.arrayContaining(['Hub', 'Asked', 'Archived']))
    expect(rows()).not.toContain('Done work')
    expect(row('Archived').hasAttribute('data-quiet')).toBe(true)
  })
  it('tells on a collapsed row what asks beneath it', () => {
    const life = row('life/admin')
    expect(life.querySelector('.tree-rollup')).toBeNull()
    life.querySelector<HTMLElement>('.tree-caret')!.click()
    const rollup = row('life/admin').querySelector<HTMLElement>('.tree-rollup[data-standing="question"]')
    expect(rollup?.textContent).toBe('1')
  })
  it('moves by keys without touching Rex, and folds with right and left', () => {
    expect(selected()[0]).toBe(row('life/admin'))
    key('j')
    expect(selected()[0]).toBe(row('A form'))
    key('h')
    expect(selected()[0]).toBe(row('life/admin'))
    key('ArrowLeft')
    expect(row('life/admin').getAttribute('aria-expanded')).toBe('false')
    key('l')
    expect(row('life/admin').getAttribute('aria-expanded')).toBe('true')
    key('l')
    expect(selected()[0]).toBe(row('A form'))
    expect(workspace.dock.openConversation).not.toHaveBeenCalled()
  })
  it('opens a thread\'s chat on a click or Enter, moving selection; a caret only folds', () => {
    row('Asked').querySelector<HTMLElement>('.tree-name')!.click()
    expect(workspace.dock.openConversation).toHaveBeenCalledWith(asked)
    expect(selected()[0]).toBe(row('Asked'))
    workspace.dock.openConversation.mockClear()
    row('Hub').querySelector<HTMLElement>('.tree-caret')!.click()
    expect(workspace.dock.openConversation).not.toHaveBeenCalled()
    key('Enter')
    expect(workspace.dock.openConversation).toHaveBeenCalledWith(hub)
  })
  it('opens a file on the stage and a thread\'s map from its row', () => {
    row('Archived').querySelector<HTMLElement>('.tree-caret')!.click()
    row('Done work').querySelector<HTMLElement>('.tree-name')!.click()
    const constitution = [...host.querySelectorAll<HTMLElement>('.tree-row[data-role="constitution"]')].find(el => el.getAttribute('aria-level') === '4')!
    constitution.click()
    expect(workspace.openPage).toHaveBeenCalledWith(done, expect.stringContaining('fiber:'))
    row('Hub').querySelector<HTMLElement>('.tree-map')!.click()
    expect(workspace.openFromDesk).toHaveBeenCalledWith(hub)
    key('m')
    expect(workspace.openFromDesk).toHaveBeenCalledTimes(2)
  })
  it('filters by name, keeping ancestors, and clears on Escape', () => {
    key('/')
    const filter = host.querySelector<HTMLInputElement>('.tree-filter')!
    filter.value = 'done'
    filter.dispatchEvent(new Event('input'))
    expect(rows()).toEqual(['Hub', 'Archived', 'Done work'])
    expect(selected()[0]).toBe(row('Done work'))
    filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(filter.value).toBe('')
    expect(rows()).toContain('Done work')
  })
  it('starts the filter on a letter no key takes', () => {
    key('e')
    expect(host.querySelector<HTMLInputElement>('.tree-filter')!.value).toBe('e')
  })
  it('remembers what a hand folded, per browser', () => {
    row('Hub').querySelector<HTMLElement>('.tree-caret')!.click()
    expect(Object.values(JSON.parse(localStorage.getItem('shuttle.tree.open')!))).toEqual([false])
  })
  it('selects and shows the row Rex moved to, leaving Rex be', () => {
    expect(view.reveal!('done', done.originId)).toBe(true)
    expect(selected()[0]).toBe(row('Done work'))
    expect(row('Archived').getAttribute('aria-expanded')).toBe('true')
    expect(workspace.dock.openConversation).not.toHaveBeenCalled()
    expect(view.reveal!('elsewhere', done.originId)).toBe(false)
  })
  it('keeps every unchanged row\'s element through a poll, and its selection', () => {
    const element = row('Asked')
    element.querySelector<HTMLElement>('.tree-name')!.click()
    const mark = element.querySelector('.tree-name')
    view.refresh(context())
    expect(row('Asked')).toBe(element)
    expect(row('Asked').querySelector('.tree-name')).toBe(mark)
    expect(selected()).toEqual([element])
  })
  it('falls back to the nearest row in view when the selected one is folded away', () => {
    row('Asked').querySelector<HTMLElement>('.tree-name')!.click()
    const closed = { ...asked, status: 'closed', closedAt: when(0), tempered: true, ask: undefined }
    view.refresh(context([hub, closed, done, quietAsk, lifeNote]))
    expect(selected()[0]).toBe(row('Hub'))
  })
  it('folds a thread\'s sent files, newest first, behind its threads', async () => {
    await vi.waitFor(() => expect(rows()).toContain('Files'))
    row('Files').querySelector<HTMLElement>('.tree-caret')!.click()
    expect(rows()).toContain('plot.png')
    row('plot.png').click()
    expect(workspace.openPage).toHaveBeenCalledWith(hub, expect.stringContaining('plot.png'))
  })
})
