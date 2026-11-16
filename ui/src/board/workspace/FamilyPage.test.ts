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
    open: vi.fn(), view: vi.fn(), seen: vi.fn(), waits: () => new Map(), shuttleBase: '', ...over,
  }
}
function made(at: KanbanCard, over: Partial<ViewFeeds> = {}, known = cards): { page: FamilyPage; feeds: ViewFeeds } {
  const feeds = feedsWith(over)
  const page = new FamilyPage(feeds, vi.fn())
  document.body.append(page.el)
  page.update(at, new ThreadIndex(known), now)
  return { page, feeds }
}
const threads = (page: FamilyPage) => [...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => [row.querySelector('.ov-slug')!.textContent, row.querySelector('.ov-want, .ov-word')?.textContent?.trim()])
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('a constitution\'s view', () => {
  it('heads with its slug, its run and whether it needs the human, then its threads as rows, what waits first with what it wants; no outcome anywhere', () => {
    const { page } = made(root)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('hub')
    // Its run at a glance, the whole of it on hover.
    const time = page.el.querySelector<HTMLElement>('.ov-head .ov-time')!
    expect([time.textContent, time.title]).toStrictEqual(['1h ago', 'worked 2h 0m · stopped 1h ago'])
    expect(page.el.querySelector('.ov-needs')).toBeNull()
    // The idle worker asked nothing: it works, and says nothing more. The tempered thread stands behind the quiet control.
    expect(threads(page)).toStrictEqual([['q', 'Which one?'], ['w', ''], ['mid', '']])
    expect([...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => row.dataset.attention)).toStrictEqual(['waiting', 'working', 'working'])
    const quiet = page.el.querySelector<HTMLButtonElement>('.ov-quiet')!
    expect(quiet.textContent).toBe('1 quiet')
    quiet.click()
    expect(threads(page)).toStrictEqual([['q', 'Which one?'], ['w', ''], ['mid', ''], ['d', '']])
    expect(page.el.querySelector('.ov-quiet')!.textContent).toBe('hide quiet')
    // A resting thread that waits on the human is never tucked away.
    const rested = card({ id: 'hub/r', name: 'Rested', orchestrator: 'hub', status: 'open', effectiveHorizon: 'stashed', column: 'resting', createdAt: when(30) })
    expect(rested.column).toBe('resting')
    const told = made(root, { waits: () => new Map([['hub/r', { id: 'p', at: now - hour, kind: 'post', text: 'Read this.' }]]) }, [...cards, rested]).page
    expect(threads(told).map(([name]) => name)).toContain('r')
    expect(threads(made(root, {}, [...cards, rested]).page).map(([name]) => name)).not.toContain('r')
    expect(page.el.textContent).not.toContain('came to this')
    expect(page.el.textContent).not.toContain('Needs a look')
    // Only its own threads: the leaf is mid's.
    expect(page.el.textContent).not.toContain('Leaf')
  })

  it('says what it last posted, then its tapestry at full width, which unfolds in place and steps on through its sent files; its head opens its pages', async () => {
    const { page, feeds } = made(mid)
    await settle()
    expect(page.el.querySelector('.ov-said-text')!.textContent!.trim()).toBe('Posted the cut.')
    expect(page.el.querySelector('.ov-said-text strong')!.textContent).toBe('cut')
    // Stacked: head, its words, its threads, then the preview.
    expect([...page.el.querySelector('.ov-main')!.children].map(part => part.classList[0])).toStrictEqual(['ov-head', 'ov-said', 'ov-threads', 'uf'])
    const cards = [...page.el.querySelectorAll<HTMLButtonElement>('.ov-unfold .uf-card')]
    expect(cards.map(card => card.title)).toStrictEqual(['Expand Tapestry'])
    cards[0].click()
    const bar = (): string[] => [...page.el.querySelectorAll('.uf-bar .uf-name, .uf-bar .uf-count')].map(part => part.textContent!)
    expect(bar()).toStrictEqual(['Tapestry', '1 / 3'])
    press(page.el.querySelector('.uf-page')!, 'ArrowRight')
    expect(bar()).toStrictEqual(['new.png', '2 / 3'])
    // Keys in the unfolded file stay there: ↓ does not jump to the rows.
    press(page.el.querySelector('.uf-page')!, 'ArrowDown')
    expect(document.activeElement).toBe(page.el.querySelector('.uf-page'))
    press(page.el.querySelector('.uf-page')!, 'Escape')
    expect(page.el.querySelector('.uf[data-unfolded]')).toBeNull()
    expect(document.activeElement).toBe(cards[0])
    expect(feeds.open).not.toHaveBeenCalled()
    const parts = [...page.el.querySelectorAll<HTMLElement>('.ov-head .ws-doc-button')].map(button => button.dataset.part)
    expect(parts).toStrictEqual(['constitution', 'tapestry', 'sends', 'edits'])
    page.el.querySelector<HTMLButtonElement>('.ov-head [data-part="sends"]')!.click()
    expect(feeds.open).toHaveBeenLastCalledWith(mid, sent[0].key)
  })

  it('counts the file its strip shows as seen, and only while it is new', async () => {
    const fresh = { ...sent[0], unread: true }
    const { feeds } = made(root, { lead: async () => undefined, files: c => c.id === 'hub' ? [fresh, sent[1]] : [] })
    await settle()
    expect(feeds.seen).toHaveBeenCalledExactlyOnceWith(fresh)
    const quiet = made(mid)
    await settle()
    expect(quiet.feeds.seen).not.toHaveBeenCalled()
  })

  it('says a question it waits on, gold, and leaves no band for words a constitution never said', () => {
    const { page } = made(asked)
    expect(page.el.querySelector('.ov-needs')!.textContent).toBe('asks')
    expect(made(root, { waits: () => new Map([['hub', { id: 'p', at: now, kind: 'post', text: 'Read this.' }]]) }).page.el.querySelector('.ov-needs')!.textContent).toBe('posted')
    expect(made(idle).page.el.querySelector<HTMLElement>('.ov-said')!.hidden).toBe(true)
  })

  it('draws beneath a thread every thread below it that waits on the human, the post the board names included; its orchestrators stand above it as strips', () => {
    const { page } = made(root, { waits: () => new Map([['hub/mid/a', { id: 'p', at: now - hour, kind: 'post', text: 'The leaf is cut.' }]]) })
    expect(threads(page)).toStrictEqual([['q', 'Which one?'], ['mid', ''], ['↳ a', 'The leaf is cut.'], ['w', '']])
    expect(page.el.querySelector<HTMLElement>('.ov-thread[data-fiber="hub/mid"] .ov-open')!.textContent).toBe('›')
    // Its orchestrators, one strip each above it, a rule per level down to its own.
    const strips = [...made(leaf).page.el.querySelectorAll<HTMLElement>('.ov-up .ov-ancestor')]
    expect(strips.map(strip => [strip.querySelector('.ov-slug')!.textContent, strip.getAttribute('title'), strip.querySelectorAll('.ov-rule').length, strip.querySelector('.ov-strip-said')!.textContent!.trim()]))
      .toStrictEqual([['hub', 'hub', 1, ''], ['mid', 'Mid', 2, 'Posted the cut.']])
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

  it('lands on its head, moves among the rows by j and k, opens one by Enter, and goes up by h, leaving the page from the top', () => {
    const { page, feeds } = made(mid)
    page.focus()
    // No row looks chosen, and a stray Enter opens nothing.
    expect(document.activeElement).toBe(page.el.querySelector('.ov-head'))
    press(document.activeElement!, 'Enter')
    expect(feeds.view).not.toHaveBeenCalled()
    press(document.activeElement!, 'j')
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

  it('opens its orchestrator\'s view quietly when pulled down past its top', () => {
    const { page, feeds } = made(mid)
    const scroller = page.el.querySelector('.ws-family-scroll')!
    const wheel = (at: number) => { const event = new WheelEvent('wheel', { deltaY: -50 }); Object.defineProperty(event, 'timeStamp', { value: at }); scroller.dispatchEvent(event) }
    // A scroll's momentum carried up to the top does not pull.
    scroller.scrollTop = 40
    wheel(1000); scroller.scrollTop = 0
    for (let n = 1; n < 6; n++) wheel(1000 + n * 50)
    expect(feeds.view).not.toHaveBeenCalled()
    // A gesture begun at the top does, moving neither Rex nor voice.
    for (let n = 0; n < 3; n++) wheel(2000 + n * 50)
    expect(feeds.view).toHaveBeenLastCalledWith(root, true)
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
    press(document.activeElement!, 'j')
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub/w')
    page.update(root, new ThreadIndex([...cards, card({ id: 'hub/new', name: 'New', orchestrator: 'hub', status: 'active', ask: { text: 'New?', at: when(0) } })]), now + 120_000)
    expect(threads(page).map(([name]) => name)).toContain('new')
    expect((document.activeElement as HTMLElement).dataset.fiber).toBe('hub/w')
  })
  it('keeps its head, its acts and its thumbnail across a repaint: what has focus there keeps it, and the thumbnail is never moved', async () => {
    const dock = new Dock('', vi.fn(), vi.fn(), undefined, { onRest: vi.fn() })
    const work = { ...mid, shuttleKind: 'oneshot' as const }
    const page = new FamilyPage(feedsWith(), vi.fn(), target => dock.actsFor(target))
    document.body.append(page.el)
    page.update(work, new ThreadIndex([root, work, leaf]), now)
    await settle()
    const head = page.el.querySelector('.ov-head'), thumb = page.el.querySelector('.uf-card')
    const act = page.el.querySelector<HTMLElement>('.ov-tools button:not(.ws-doc-button)')!
    act.focus()
    page.update(work, new ThreadIndex([root, work, leaf]), now + 2 * 60_000)
    await settle()
    expect([page.el.querySelector('.ov-head') === head, page.el.querySelector('.uf-card') === thumb, document.activeElement === act]).toStrictEqual([true, true, true])
    page.el.querySelector<HTMLElement>('.ov-head [data-part="constitution"]')!.focus()
    page.update(work, new ThreadIndex([root, work, leaf]), now + 4 * 60_000)
    expect((document.activeElement as HTMLElement).dataset.part).toBe('constitution')
    page.dispose()
  })
  it('tells its owner when its frame is evicted', () => {
    const disposed = vi.fn(), page = new FamilyPage(feedsWith(), disposed)
    disposeFileViewer(page.el)
    expect(disposed).toHaveBeenCalledOnce()
  })
})
