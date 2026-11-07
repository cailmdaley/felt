// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { card, conversations } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { MapFile } from '../family/model.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage, placeAt, type FamilyFeeds, type MapPlace } from './FamilyPage.js'

const now = 1_800_000_000_000, hour = 3_600_000
const when = (back: number): string => new Date(now - back * hour).toISOString()
const root = card({ id: 'hub', createdAt: when(300), status: 'active', outcome: 'The hub came to this.' })
const asked = card({ id: 'hub/q', name: 'Asked', orchestrator: 'hub', status: 'active', createdAt: when(10), ask: { text: 'Which one?', at: when(1) } })
const idle = card({ id: 'hub/w', name: 'Idle', orchestrator: 'hub', status: 'active', createdAt: when(10), workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 2 * hour, outcome: 'Needs a look', sessionUuid: 'session-idle' })
const mid = card({ id: 'hub/mid', name: 'Mid', orchestrator: 'hub', status: 'active', createdAt: when(40), workerState: 'running', runtimePhase: 'working', sessionUuid: 'session-mid', outcome: 'Mid came to this.' })
const leaf = card({ id: 'hub/mid/a', name: 'Leaf', orchestrator: 'hub/mid', status: 'active', createdAt: when(20), workerState: 'running', runtimePhase: 'waiting' })
const done = card({ id: 'hub/d', name: 'Done', orchestrator: 'hub', status: 'closed', tempered: true, createdAt: when(50), closedAt: when(5) })
const draft = card({ id: 'hub/draft', name: 'Draft', orchestrator: 'hub', status: 'open', createdAt: when(50) })
const cards = [root, asked, idle, mid, leaf, done, draft]

const file = (name: string, back: number, unread = false): MapFile => ({ key: `doc:${name}`, name, at: now - back * hour, unread })
/** Mid's sent files, newest first as the feed gives them. */
const sent = [file('new.png', 1, true), file('mid.md', 2), file('old.md', 3)]
const tapestry = file('Tapestry', 4)
const feeds: FamilyFeeds = { marks: () => undefined, files: c => c.id === 'hub/mid' ? sent : [], refresh: vi.fn(), lead: async c => c.id === 'hub/mid' ? tapestry : undefined, embed: () => ({ el: document.createElement('div'), dispose: () => {} }) }
const settled = async (): Promise<void> => { for (let n = 0; n < 4; n++) await Promise.resolve() }

interface Made { family: FamilyPage; reach: Mock; place: MapPlace; sighted: Mock }
function made(over: { feeds?: FamilyFeeds; place?: MapPlace; known?: KanbanCard[] } = {}): Made {
  const reach = vi.fn(async (_card: KanbanCard) => true), sighted = vi.fn()
  const place = over.place ?? { open: new Set<string>(), selected: null }
  const family = new FamilyPage({ reach }, over.feeds ?? feeds, place, vi.fn(), sighted)
  document.body.append(family.el)
  family.update(root, new ThreadIndex(over.known ?? cards), now)
  return { family, reach, place, sighted }
}
const row = (family: FamilyPage, name: string): HTMLElement => [...family.el.querySelectorAll<HTMLElement>('.fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')!.title === name)!
const said = (family: FamilyPage): string[] => [...family.el.querySelector('.fp-tree')!.children].map(el =>
  el.classList.contains('fp-section') ? `[${el.textContent}]` : el.classList.contains('fp-aside') ? `(${el.textContent})` : el.querySelector<HTMLElement>('.fp-name')!.title)
const chips = (family: FamilyPage, name: string): string[] => [...row(family, name).querySelectorAll('.fp-docs button')].map(el => el.textContent!)
const files = (family: FamilyPage, name: string): string[] => [...row(family, name).querySelectorAll('.fp-file-name')].map(el => el.textContent!)
const click = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) }
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('the page', () => {
  it('heads with the constitution and its outcome, then its threads under one divider per kind, the set-aside behind one fold', () => {
    const { family } = made()
    expect(said(family)).toEqual(['hub', '[Questions]', 'Asked', '[Your turn]', 'Mid', 'Idle', '(1 archived · 1 draft)'])
    expect(family.el.querySelector('.fp-head .fp-note')!.textContent).toBe('The hub came to this.')
    expect(row(family, 'Asked').querySelector('.fp-note')!.textContent).toBe('Which one?')
    expect(row(family, 'Idle').querySelector('.fp-note')!.textContent).toBe('Needs a look')
  })
  it('gives each row one mark, coloured by the most urgent thing it holds, and counts what asks under it', () => {
    const { family } = made()
    for (const el of family.el.querySelectorAll('.fp-row')) expect(el.querySelectorAll('svg')).toHaveLength(1)
    expect(row(family, 'Asked').dataset.standing).toBe('question')
    expect(row(family, 'Mid').dataset.standing).toBe('turn')
    expect(row(family, 'Mid').querySelector('.fp-meta')!.textContent).toMatch(/^(now|\d+\w+)$/)
    expect(row(family, 'Mid').querySelector('.fp-count')!.textContent).toBe('1 of 1 ask')
  })
  it('holds a lone constitution as its head alone, unfolded', async () => {
    const lone = card({ id: 'solo', status: 'active', shuttleKind: 'oneshot', sessionUuid: 's' })
    const family = new FamilyPage(conversations(), feeds, placeAt(lone), vi.fn())
    family.update(lone, new ThreadIndex([lone]), now)
    await settled()
    expect(said(family)).toEqual(['solo'])
    expect(chips(family, 'solo')).toEqual(['☰'])
  })
})

describe('a row', () => {
  it('unfolds on a click and moves Rex quietly, and folds on a second click, leaving Rex be', async () => {
    const { family, reach, place } = made()
    click(row(family, 'Mid'))
    expect(reach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }))
    expect(said(family)).toContain('Leaf')
    expect(row(family, 'Mid').getAttribute('aria-expanded')).toBe('true')
    await settled()
    expect(row(family, 'Mid').hasAttribute('data-worker')).toBe(true)
    expect(place.worker).toContain('hub/mid')
    click(row(family, 'Mid'))
    expect(reach).toHaveBeenCalledTimes(1)
    expect(said(family)).not.toContain('Leaf')
  })
  it('rings the worker only when Rex moved', async () => {
    const { family, reach, place } = made()
    reach.mockResolvedValueOnce(false)
    click(row(family, 'Mid'))
    await settled()
    expect(place.worker).toBeUndefined()
    expect(row(family, 'Mid').hasAttribute('data-worker')).toBe(false)
  })
  it('shows glyph chips and lists sent files newest first', async () => {
    const { family, place } = made()
    await settled()
    expect(chips(family, 'Mid')).toEqual(['⌗', '☰', '⧉ 3'])
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-files')!.hidden).toBe(true)
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    expect(files(family, 'Mid')).toEqual(['new.png', 'mid.md', 'old.md'])
    expect(row(family, 'Mid').querySelector('.fp-sent')!.getAttribute('aria-expanded')).toBe('true')
    expect(place.open.has(`files:${row(family, 'Mid').dataset.thread}`)).toBe(true)
    expect(row(family, 'Mid').querySelector('[data-held="doc:new.png"]')!.hasAttribute('data-unread')).toBe(true)
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-files')!.hidden).toBe(true)
  })
  it('embeds a chip inline and disposes it on the second click', async () => {
    const dispose = vi.fn(), embedded = document.createElement('div')
    const embed = vi.fn(() => ({ el: embedded, dispose }))
    const { family, reach, sighted, place } = made({ feeds: { ...feeds, embed } })
    await settled()
    click(row(family, 'Mid').querySelector('.fp-lead')!)
    expect(embed).toHaveBeenCalledExactlyOnceWith(mid, 'doc:Tapestry')
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')
    expect(row(family, 'Mid').querySelector('.fp-doc')!.contains(embedded)).toBe(true)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-pressed')).toBe('true')
    expect(reach).toHaveBeenCalledExactlyOnceWith(mid)
    expect(sighted).toHaveBeenCalledOnce()
    click(row(family, 'Mid').querySelector('.fp-lead')!)
    expect(dispose).toHaveBeenCalledOnce()
    expect(place.docs!.size).toBe(0)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-pressed')).toBe('false')
  })
  it('names a sent tapestry as the lead when the fiber\'s directory holds none', async () => {
    const { family } = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? [file('tapestry.html', 1), ...sent] : [], lead: async () => undefined } })
    click(row(family, 'Mid'))
    await settled()
    expect(chips(family, 'Mid')).toEqual(['⌗', '☰', '⧉ 3'])
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-label')).toBe('Tapestry')
  })
  it('keeps the set-aside behind its fold until asked', () => {
    const { family } = made()
    expect(said(family)).not.toContain('Done')
    click(family.el.querySelector('.fp-aside')!)
    expect(said(family).slice(-2).sort()).toEqual(['Done', 'Draft'])
    expect(row(family, 'Done').dataset.standing).toBe('aside')
  })
})

describe('keys', () => {
  const at = (): string => (document.activeElement as HTMLElement).querySelector<HTMLElement>('.fp-name')?.title || document.activeElement!.textContent!
  const keys = (...names: string[]): void => { for (const name of names) press(document.activeElement!, name) }
  it('moves the highlight without entering; l enters the thread and focuses its first chip', async () => {
    const { family, reach, sighted } = made()
    await settled()
    family.focus()
    keys('j', 'j', 'j', 'k')
    expect(at()).toBe('Mid')
    expect(family.selection?.id).toBe('hub/mid')
    expect(family.settled?.id).toBe('hub')
    expect(sighted).not.toHaveBeenCalled()
    expect(reach).not.toHaveBeenCalled()
    keys('l')
    expect(at()).toBe('⌗')
    expect(family.settled?.id).toBe('hub/mid')
    expect(sighted).toHaveBeenCalledOnce()
    expect(reach).toHaveBeenCalledExactlyOnceWith(mid)
  })
  it('steps through chips and files, unfolds a document, and goes back out with h', async () => {
    const { family } = made()
    const leave = vi.fn(); family.leave = leave
    await settled()
    family.focus()
    keys('j', 'j', 'l', 'j', 'j')
    expect(at()).toBe('⧉ 3')
    keys('l')
    expect(at()).toContain('new.png')
    keys('j')
    expect(at()).toContain('mid.md')
    keys('l')
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    keys('h')
    expect(at()).toBe('Mid')
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-files')!.hidden).toBe(true)
    keys('h')
    expect(leave).toHaveBeenCalledOnce()
  })
  it('does what a click does on Enter; Escape folds the open row around the selection', () => {
    const { family, reach } = made()
    family.focus()
    keys('j', 'j')
    expect(at()).toBe('Mid')
    keys('Enter')
    expect(reach).toHaveBeenCalledOnce()
    expect(said(family)).toContain('Leaf')
    keys('j')
    expect(at()).toBe('Leaf')
    expect(family.foldOut()).toBe(true)
    expect(said(family)).not.toContain('Leaf')
    expect(at()).toBe('Mid')
    expect(family.foldOut()).toBe(false)
  })
})

describe('landing', () => {
  it('lands on a fiber\'s row, unfolded and selected, opening what hides it', () => {
    const { family, sighted, reach } = made({ place: placeAt(leaf) })
    expect(said(family)).toContain('Leaf')
    expect(row(family, 'Leaf').getAttribute('aria-selected')).toBe('true')
    expect(row(family, 'Leaf').getAttribute('aria-expanded')).toBe('true')
    expect(family.settled?.id).toBe('hub/mid/a')
    expect(sighted).toHaveBeenCalled()
    expect(reach).not.toHaveBeenCalled()
  })
  it('lands again once the family grows the orchestrator above it, and not on every repaint', () => {
    const family = new FamilyPage(conversations(), feeds, placeAt(leaf), vi.fn())
    family.update(leaf, new ThreadIndex([leaf]), now)
    family.update(leaf, new ThreadIndex(cards), now)
    expect(said(family)).toContain('Leaf')
    click(row(family, 'Mid'))
    family.update(leaf, new ThreadIndex(cards), now + 120_000)
    expect(said(family)).not.toContain('Leaf')
  })
  it('comes to the thread Rex moved to without speaking to Rex, and refuses one of another family', () => {
    const { family, reach, place } = made()
    expect(family.flyTo(leaf)).toBe(true)
    expect(row(family, 'Leaf').getAttribute('aria-selected')).toBe('true')
    expect(row(family, 'Leaf').hasAttribute('data-worker')).toBe(true)
    expect(place.worker).toContain('hub/mid/a')
    expect(family.flyTo(card({ id: 'elsewhere' }))).toBe(false)
    expect(reach).not.toHaveBeenCalled()
  })
})

describe('`l` outside the tree', () => {
  it('toggles the selected thread\'s tapestry, else its newest file, reading each thread once', async () => {
    const reads = vi.fn(feeds.lead), { family, place } = made({ feeds: { ...feeds, lead: reads } })
    click(row(family, 'Mid'))
    family.toggleLead(); await settled()
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')
    family.toggleLead(); await settled()
    expect(place.docs!.size).toBe(0)
    expect(reads.mock.calls.filter(([thread]) => thread.id === 'hub/mid')).toHaveLength(1)
    const { family: other, place: otherPlace } = made({ feeds: { ...feeds, lead: async () => undefined } })
    click(row(other, 'Mid'))
    other.toggleLead(); await settled()
    expect(otherPlace.docs!.get(row(other, 'Mid').dataset.thread!)).toBe('doc:new.png')
  })
  it('waits for the lead read and ignores it if the selection moves', async () => {
    const landing: Array<() => void> = []
    const slow = (thread: KanbanCard): Promise<MapFile | undefined> => new Promise(resolve => landing.push(() => { void feeds.lead(thread).then(resolve) }))
    const { family, place } = made({ feeds: { ...feeds, lead: slow } })
    click(row(family, 'Mid'))
    family.toggleLead()
    await settled()
    expect(place.docs!.size).toBe(0)
    landing.splice(0).forEach(land => land())
    await settled()
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')

    const pending: Array<() => void> = []
    const { family: other, place: otherPlace } = made({ feeds: { ...feeds, lead: thread => new Promise(resolve => pending.push(() => { void feeds.lead(thread).then(resolve) })) } })
    click(row(other, 'Mid'))
    other.toggleLead()
    click(row(other, 'Idle'))
    pending.splice(0).forEach(land => land())
    await settled()
    expect(otherPlace.docs!.size).toBe(0)
  })
})

describe('its frame', () => {
  it('reads and repaints nothing parked, and catches up when selected again', () => {
    const refresh = vi.fn(), { family } = made({ feeds: { ...feeds, refresh } })
    const asks = refresh.mock.calls.length
    suspendFileViewer(family.el)
    family.update(root, new ThreadIndex(cards.map(c => c === asked ? { ...asked, name: 'Asked again' } : c)), now + hour)
    expect(refresh.mock.calls.length).toBe(asks)
    expect(said(family)).toContain('Asked')
    resumeFileViewer(family.el)
    expect(said(family)).toContain('Asked again')
  })
  it('keeps each row\'s element and the focus across a repaint', () => {
    const { family } = made()
    family.focus()
    for (let n = 0; n < 3; n++) press(document.activeElement!, 'ArrowDown')
    const before = row(family, 'Idle')
    expect(document.activeElement).toBe(before)
    family.update(root, new ThreadIndex([...cards, card({ id: 'hub/new', name: 'New', orchestrator: 'hub', status: 'active', ask: { text: 'New?', at: when(0) } })]), now + 120_000)
    expect(said(family)).toContain('New')
    expect(row(family, 'Idle')).toBe(before)
    expect(document.activeElement).toBe(before)
  })
  it('tells its owner when its frame is evicted', () => {
    const disposed = vi.fn(), family = new FamilyPage(conversations(), feeds, placeAt(root), disposed)
    disposeFileViewer(family.el)
    expect(disposed).toHaveBeenCalledOnce()
  })
})
