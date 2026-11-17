// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { card, settle } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { MapFile } from '../family/model.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage, type ViewFeeds } from './FamilyPage.js'
import { lastActive } from '../attention.js'
import { instantStamp } from '../civilDay.js'
import { relative } from '../elements/time.js'
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
/** Each thread row: its slug (marked ↳ when drawn deep below another) and what it is doing. */
const threads = (page: FamilyPage) => [...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => [`${row.classList.contains('ov-deep') ? '↳ ' : ''}${row.querySelector('.thread-row-slug')!.textContent}`, row.querySelector('.thread-row-doing')!.textContent])
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('a constitution\'s view', () => {
  it('heads with its slug, its time and whether it needs the human, then its threads as rows, what waits first with what it wants, else the newer of what it said and its outcome', () => {
    const { page } = made(root)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('hub')
    // Quiet, its head is timed from when it last moved, in the elements' one grammar, the instant in full on hover.
    const time = page.el.querySelector<HTMLElement>('.ov-head .ov-time')!
    expect([time.classList.contains('el-time'), time.textContent, time.title]).toStrictEqual([true, relative(lastActive(root), now), instantStamp(lastActive(root))])
    // Working with nothing said, it is timed from its launch.
    const launched = made(card({ ...mid, id: 'solo', orchestrator: undefined, outcome: undefined, dispatchedAt: when(5) }), { said: () => undefined }).page
    expect(launched.el.querySelector('.ov-head .ov-time')!.textContent).toBe('5h ago')
    expect(page.el.querySelector('.ov-needs')).toBeNull()
    // Each says what it is doing: what it asks, else the newer of what it last said and its outcome, else its turn. The tempered thread stands behind the quiet control.
    expect(threads(page)).toStrictEqual([['q', 'Which one?'], ['w', 'Needs a look'], ['mid', 'Posted the cut.']])
    expect([...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => row.dataset.attention)).toStrictEqual(['waiting', 'working', 'working'])
    const quiet = page.el.querySelector<HTMLButtonElement>('.ov-quiet')!
    expect(quiet.textContent).toBe('1 quiet')
    quiet.click()
    expect(threads(page).slice(0, 3)).toStrictEqual([['q', 'Which one?'], ['w', 'Needs a look'], ['mid', 'Posted the cut.']])
    expect(threads(page).map(([slug]) => slug)).toStrictEqual(['q', 'w', 'mid', 'd'])
    expect(page.el.querySelector('.ov-quiet')!.textContent).toBe('hide quiet')
    // A resting thread that waits on the human is never tucked away.
    const rested = card({ id: 'hub/r', name: 'Rested', orchestrator: 'hub', status: 'open', effectiveHorizon: 'stashed', column: 'resting', createdAt: when(30) })
    expect(rested.column).toBe('resting')
    const told = made(root, { waits: () => new Map([['hub/r', { id: 'p', at: now - hour, kind: 'post', text: 'Read this.' }]]) }, [...cards, rested]).page
    expect(threads(told).map(([name]) => name)).toContain('r')
    expect(threads(made(root, {}, [...cards, rested]).page).map(([name]) => name)).not.toContain('r')
    // An outcome written after its last post is what it says.
    const rewrote = made(root, {}, cards.map(each => each === mid ? { ...mid, modifiedAt: new Date(now - 60_000).toISOString() } : each)).page
    const row = rewrote.el.querySelector<HTMLElement>('.ov-thread[data-fiber="hub/mid"]')!
    expect([row.querySelector('.thread-row-doing')!.textContent, row.querySelector('.thread-row-age')!.textContent, row.title]).toStrictEqual(['Mid came to this.', '1m ago', 'Mid — Mid came to this.'])
    // Only its own threads: the leaf is mid's.
    expect(page.el.textContent).not.toContain('Leaf')
  })

  it('lists only the threads that wait on the human or are working; a seat, a standing thread between runs, a draft and a rest join the quiet fold, which opens to them as the same rows', () => {
    const seat = card({ id: 'hub/seat', name: 'Seat', orchestrator: 'hub', status: 'open', column: 'roles', shuttleSeat: true, createdAt: when(30) })
    const weekly = card({ id: 'hub/weekly', name: 'Weekly', orchestrator: 'hub', status: 'active', column: 'resting', shuttleKind: 'standing', createdAt: when(30) })
    const draft = card({ id: 'hub/draft', name: 'Draft', orchestrator: 'hub', status: 'open', column: 'drafts', createdAt: when(30) })
    // A quiet thread with a wait below it stands with what waits.
    const quietParent = card({ id: 'hub/qp', name: 'Quiet parent', orchestrator: 'hub', status: 'open', column: 'drafts', createdAt: when(30) })
    const below = card({ id: 'hub/qp/ask', name: 'Below', orchestrator: 'hub/qp', status: 'active', createdAt: when(10), ask: { text: 'Go?', at: when(1) } })
    const { page } = made(root, {}, [...cards, seat, weekly, draft, quietParent, below])
    expect(threads(page).map(([name]) => name)).toStrictEqual(['q', 'qp', '↳ ask', 'w', 'mid'])
    const quiet = page.el.querySelector<HTMLButtonElement>('.ov-quiet')!
    expect(quiet.textContent).toBe('4 quiet')
    quiet.click()
    expect(threads(page).map(([name]) => name).slice(5).sort()).toStrictEqual(['d', 'draft', 'seat', 'weekly'])
    expect([...page.el.querySelectorAll<HTMLElement>('.ov-thread')].slice(5).every(row => row.classList.contains('thread-row') && row.dataset.attention === 'quiet')).toBe(true)
  })

  it('keeps a quiet thread in the list while a worker below it is working, so a working grandchild is never folded out of sight', () => {
    const quietParent = card({ id: 'hub/qp', name: 'Quiet parent', orchestrator: 'hub', status: 'open', column: 'drafts', createdAt: when(30) })
    const working = card({ id: 'hub/qp/run', name: 'Running', orchestrator: 'hub/qp', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'working', sessionUuid: 'session-run' })
    const { page } = made(root, {}, [...cards, quietParent, working])
    expect(threads(page).map(([name]) => name)).toContain('qp')
    expect(page.el.querySelector('.ov-quiet')!.textContent).toBe('1 quiet')
  })

  it('unfolds a quiet thread at the next update once a worker below it starts working', () => {
    const quietParent = card({ id: 'hub/qp', name: 'Quiet parent', orchestrator: 'hub', status: 'open', column: 'drafts', createdAt: when(30) })
    const run = card({ id: 'hub/qp/run', name: 'Running', orchestrator: 'hub/qp', status: 'active', createdAt: when(10) })
    const { page } = made(root, {}, [...cards, quietParent, run])
    expect(threads(page).map(([name]) => name)).not.toContain('qp')
    page.update(root, new ThreadIndex([...cards, quietParent, { ...run, workerState: 'running', runtimePhase: 'working', sessionUuid: 'session-run' }]), now)
    expect(threads(page).map(([name]) => name)).toContain('qp')
  })
  it('says what it last posted, then its tapestry at full width, which unfolds in place and steps on through its sent files; its head unfolds its files there and opens its other pages', async () => {
    const { page, feeds } = made(mid)
    await settle()
    expect(page.el.querySelector('.ov-said-text')!.textContent!.trim()).toBe('Posted the cut.')
    expect(page.el.querySelector('.ov-said-text strong')!.textContent).toBe('cut')
    // Stacked: head, its words, its threads, then the preview.
    expect([...page.el.querySelector('.ov-main')!.children].map(part => part.classList[0])).toStrictEqual(['ov-ink', 'ov-head', 'ov-said', 'ov-threads', 'uf'])
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
    // The count lists its files, newest first; a row unfolds its file here.
    page.el.querySelector<HTMLButtonElement>('.ov-head [data-part="sends"]')!.click()
    await settle()
    const rows = [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')]
    expect(rows.map(row => row.dataset.key)).toStrictEqual(sent.map(file => file.key))
    rows[0].closest('button')!.click()
    await settle(); await settle()
    expect(bar()).toStrictEqual(['new.png', '2 / 3'])
    // The tapestry's button unfolds it in the same place, in place of the file; pressed again, it folds.
    const tapestryButton = (): HTMLButtonElement => page.el.querySelector<HTMLButtonElement>('.ov-head [data-part="tapestry"]')!
    tapestryButton().click()
    expect(bar()).toStrictEqual(['Tapestry', '1 / 3'])
    tapestryButton().click()
    expect(page.el.querySelector('.uf[data-unfolded]')).toBeNull()
    // l does the same; the constitution's page still opens in the reader.
    page.openLead(); await settle()
    expect(bar()).toStrictEqual(['Tapestry', '1 / 3'])
    expect(feeds.open).not.toHaveBeenCalled()
    page.el.querySelector<HTMLButtonElement>('.ov-head [data-part="constitution"]')!.click()
    expect(feeds.open).toHaveBeenCalledExactlyOnceWith(mid, 'fiber:local:hub/mid')
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
    // A post it waits with needs no word: its words stand below the head.
    expect(made(root, { waits: () => new Map([['hub', { id: 'p', at: now, kind: 'post', text: 'Read this.' }]]) }).page.el.querySelector('.ov-needs')).toBeNull()
    expect(made(idle).page.el.querySelector<HTMLElement>('.ov-said')!.hidden).toBe(true)
  })

  it('draws beneath a thread every thread below it that waits on the human, the post the board names included; its orchestrators stand above it as strips', () => {
    const { page } = made(root, { waits: () => new Map([['hub/mid/a', { id: 'p', at: now - hour, kind: 'post', text: 'The leaf is cut.' }]]) })
    expect(threads(page)).toStrictEqual([['q', 'Which one?'], ['mid', 'Posted the cut.'], ['↳ a', 'The leaf is cut.'], ['w', 'Needs a look']])
    // Its orchestrators, one strip each above it, each in its own identity colour.
    const strips = [...made(leaf).page.el.querySelectorAll<HTMLElement>('.ov-up .ov-ancestor')]
    expect(strips.map(strip => [strip.querySelector('.thread-row-slug')!.textContent, strip.getAttribute('title'), !!strip.dataset.hue, strip.querySelector('.thread-row-doing')!.textContent]))
      .toStrictEqual([['hub', 'hub — The hub came to this.', true, 'The hub came to this.'], ['mid', 'Mid — Posted the cut.', true, 'Posted the cut.']])
  })

  it('opens a thread\'s view from its row, and its orchestrators\' from the heads above it', () => {
    const { page, feeds } = made(leaf)
    expect([...page.el.querySelectorAll('.ov-up .thread-row-slug')].map(el => el.textContent)).toStrictEqual(['hub', 'mid'])
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
