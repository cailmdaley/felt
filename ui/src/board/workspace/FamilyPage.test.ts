// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, settle } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { MapFile } from '../family/model.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage, type ViewFeeds } from './FamilyPage.js'
import { Dock } from './Dock.js'
import { leadVerb, lifecycleVerbsFor, verbSpec } from './lifecycleVerbs.js'
import { offeredVerbs } from './testActs.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', createdAt: when(300), status: 'active', shuttleKind: 'oneshot', outcome: 'The hub came to this.', dispatchedAt: when(3), handedOffAt: when(1) })
const asked = card({ id: 'hub/q', name: 'Asked', orchestrator: 'hub', status: 'active', createdAt: when(10), ask: { text: 'Which one?', at: when(1) } })
const idle = card({ id: 'hub/w', name: 'Idle', orchestrator: 'hub', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 2 * hour, outcome: 'Needs a look', sessionUuid: 'session-idle' })
const mid = card({ id: 'hub/mid', name: 'Mid', orchestrator: 'hub', status: 'active', createdAt: when(40), workerState: 'running', runtimePhase: 'working', sessionUuid: 'session-mid', outcome: 'Mid came to this.', shuttleProjectDir: '/p' })
const leaf = card({ id: 'hub/mid/a', name: 'Leaf', orchestrator: 'hub/mid', status: 'active', createdAt: when(20), workerState: 'running', runtimePhase: 'waiting' })
const done = card({ id: 'hub/d', name: 'Done', orchestrator: 'hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5) })
const cards = [root, asked, idle, mid, leaf, done]

const file = (name: string, back: number): MapFile => ({ key: `host:/w/${name}`, name, at: now - back * hour, unread: false })
const sent = [file('new.png', 1), file('mid.md', 2)]
const tapestry = file('tapestry.html', 4)
function feedsWith(over: Partial<ViewFeeds> = {}): ViewFeeds {
  return {
    marks: () => undefined, reach: () => 14 * 86_400_000, files: c => c.id === 'hub/mid' ? sent : [], refresh: vi.fn(),
    lead: async c => c.id === 'hub/mid' ? { ...tapestry, name: 'Tapestry' } : undefined,
    said: c => c.id === 'hub/mid' ? { text: 'Posted the **cut**.', at: now - hour } : undefined,
    open: vi.fn(), view: vi.fn(), shuttleBase: '', ...over,
  }
}
function made(at: KanbanCard, over: Partial<ViewFeeds> = {}, known = cards): { page: FamilyPage; feeds: ViewFeeds } {
  const feeds = feedsWith(over)
  const page = new FamilyPage(feeds, vi.fn())
  document.body.append(page.el)
  page.update(at, new ThreadIndex(known), now)
  return { page, feeds }
}
const threads = (page: FamilyPage) => [...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => [row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-word')?.textContent])
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('a constitution\'s view', () => {
  it('heads with its slug, its run and whether it needs the human, then its threads as rows, most urgent first; no outcome anywhere', () => {
    const { page } = made(root)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('hub')
    expect(page.el.querySelector('.ov-head .ov-time')!.textContent).toBe('worked 2h 0m · stopped 1h ago')
    expect(page.el.querySelector('.ov-needs')).toBeNull()
    expect(threads(page)).toStrictEqual([['q', 'question'], ['w', 'your turn'], ['mid', 'working'], ['d', 'archived']])
    expect(page.el.textContent).not.toContain('came to this')
    expect(page.el.textContent).not.toContain('Needs a look')
    // Only its own threads: the leaf is mid's.
    expect(page.el.textContent).not.toContain('Leaf')
  })

  it('says what it last posted beside its tapestry, and opens its pages from its head and its thumbnail', async () => {
    const { page, feeds } = made(mid)
    await settle()
    expect(page.el.querySelector('.ov-said-text')!.textContent).toBe('Posted the **cut**.')
    const figure = page.el.querySelector<HTMLButtonElement>('.ov-figure')!
    expect([figure.hidden, figure.title]).toStrictEqual([false, 'Open Tapestry'])
    figure.click()
    expect(feeds.open).toHaveBeenLastCalledWith(mid, tapestry.key)
    const parts = [...page.el.querySelectorAll<HTMLElement>('.ov-head .ws-doc-button')].map(button => button.dataset.part)
    expect(parts).toStrictEqual(['constitution', 'tapestry', 'sends', 'edits'])
    page.el.querySelector<HTMLButtonElement>('.ov-head [data-part="sends"]')!.click()
    expect(feeds.open).toHaveBeenLastCalledWith(mid, sent[0].key)
  })

  it('says a question it waits on, gold, and shows no strip for a constitution that said nothing', () => {
    const { page } = made(asked)
    expect(page.el.querySelector('.ov-needs')!.textContent).toBe('asks')
    expect(made(idle).page.el.querySelector<HTMLElement>('.ov-strip')!.hidden).toBe(true)
  })

  it('opens a thread\'s view from its row, and its orchestrators\' from the heads above it', () => {
    const { page, feeds } = made(leaf)
    expect([...page.el.querySelectorAll('.ov-up .ov-slug')].map(el => el.textContent)).toStrictEqual(['hub', 'mid'])
    page.el.querySelector<HTMLElement>('.ov-ancestor')!.click()
    expect(feeds.view).toHaveBeenLastCalledWith(root)
    const top = made(root)
    top.page.el.querySelector<HTMLElement>('.ov-thread[data-fiber="hub/mid"]')!.click()
    expect(top.feeds.view).toHaveBeenLastCalledWith(mid)
  })

  it('moves among the rows by j and k, opens one by Enter, and goes up by h, leaving the page from the top', () => {
    const { page, feeds } = made(mid)
    page.focus()
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub/mid/a')
    press(document.activeElement!, 'Enter')
    expect(feeds.view).toHaveBeenLastCalledWith(leaf)
    press(document.activeElement!, 'k')
    press(document.activeElement!, 'k')
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub')
    press(document.activeElement!, 'h')
    expect(feeds.view).toHaveBeenLastCalledWith(root)
    const top = made(root), leave = vi.fn()
    top.page.leave = leave
    top.page.focus()
    press(document.activeElement!, 'h')
    expect(leave).toHaveBeenCalledOnce()
  })

  it('opens its orchestrator\'s view when pulled down past its top', () => {
    const { page, feeds } = made(mid)
    const scroller = page.el.querySelector('.ws-family-scroll')!
    for (let n = 0; n < 3; n++) scroller.dispatchEvent(Object.assign(new Event('wheel'), { deltaY: -50 }))
    expect(feeds.view).toHaveBeenLastCalledWith(root)
  })

  it('draws its acts in its head, as the lifecycle offers them', async () => {
    const work = { ...mid, shuttleKind: 'oneshot' as const }
    const dock = new Dock('', vi.fn(), vi.fn(), undefined, { onRest: vi.fn() })
    const page = new FamilyPage(feedsWith(), vi.fn(), target => dock.actsFor(target))
    page.update(work, new ThreadIndex([root, work, leaf]), now)
    const offered = lifecycleVerbsFor(work, true), lead = leadVerb(work, offered)
    expect(await offeredVerbs(page.el.querySelector('.ov-tools')!)).toEqual([...lead ? [lead] : [], ...offered.filter(verb => verb !== lead)].map(verb => verbSpec(verb, work).label))
    page.dispose()
  })
})

describe('its frame', () => {
  it('reads and repaints nothing parked, and catches up when selected again', () => {
    const refresh = vi.fn(), { page } = made(root, { refresh })
    const asks = refresh.mock.calls.length
    suspendFileViewer(page.el)
    page.update(root, new ThreadIndex(cards.map(c => c === asked ? { ...asked, id: 'hub/q2' } : c)), now + hour)
    expect(refresh.mock.calls.length).toBe(asks)
    expect(threads(page).map(([name]) => name)).toContain('q')
    resumeFileViewer(page.el)
    expect(threads(page).map(([name]) => name)).toContain('q2')
  })
  it('keeps the focus on its row across a repaint', () => {
    const { page } = made(root)
    page.focus()
    press(document.activeElement!, 'j')
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub/w')
    page.update(root, new ThreadIndex([...cards, card({ id: 'hub/new', name: 'New', orchestrator: 'hub', status: 'active', ask: { text: 'New?', at: when(0) } })]), now + 120_000)
    expect(threads(page).map(([name]) => name)).toContain('new')
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub/w')
  })
  it('tells its owner when its frame is evicted', () => {
    const disposed = vi.fn(), page = new FamilyPage(feedsWith(), disposed)
    disposeFileViewer(page.el)
    expect(disposed).toHaveBeenCalledOnce()
  })
})
