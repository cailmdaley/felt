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
const feeds: FamilyFeeds = { marks: () => undefined, files: c => c.id === 'hub/mid' ? sent : [], refresh: vi.fn(), lead: async c => c.id === 'hub/mid' ? tapestry : undefined }
const settled = async (): Promise<void> => { for (let n = 0; n < 4; n++) await Promise.resolve() }

interface Made { family: FamilyPage; open: Mock; reach: Mock; converse: Mock; place: MapPlace; sighted: Mock }
function made(over: { feeds?: FamilyFeeds; place?: MapPlace; known?: KanbanCard[] } = {}): Made {
  const open = vi.fn(), reach = vi.fn(async (_card: KanbanCard) => true), converse = vi.fn((_card: KanbanCard) => true), sighted = vi.fn()
  const place = over.place ?? { open: new Set<string>(), selected: null }
  const family = new FamilyPage(open, { open: converse, reach }, over.feeds ?? feeds, place, vi.fn(), sighted)
  document.body.append(family.el)
  family.update(root, new ThreadIndex(over.known ?? cards), now)
  return { family, open, reach, converse, place, sighted }
}
const row = (family: FamilyPage, name: string): HTMLElement => [...family.el.querySelectorAll<HTMLElement>('.fp-row')].find(el => el.querySelector('.fp-name')!.textContent === name)!
const said = (family: FamilyPage): string[] => [...family.el.querySelector('.fp-tree')!.children].map(el =>
  el.classList.contains('fp-section') ? `[${el.textContent}]` : el.classList.contains('fp-aside') ? `(${el.textContent})` : el.querySelector('.fp-name')!.textContent!)
const held = (family: FamilyPage, name: string): string[] => [...row(family, name).querySelectorAll('.fp-held button')].map(el => el.querySelector('.fp-file-name')?.textContent ?? el.textContent!)
const click = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) }
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('the page', () => {
  it('heads with the constitution and its outcome, then its threads most urgent first, the set-aside behind one fold', () => {
    const { family } = made()
    expect(said(family)).toEqual(['hub', 'Asked', 'Mid', 'Idle', '(1 archived · 1 draft)'])
    expect(family.el.querySelector('.fp-head .fp-note')!.textContent).toBe('The hub came to this.')
    expect(row(family, 'Asked').querySelector('.fp-note')!.textContent).toBe('Which one?')
    expect(row(family, 'Idle').querySelector('.fp-note')!.textContent).toBe('Needs a look')
  })
  it('gives each row one mark, coloured by the most urgent thing it holds, and counts what asks under it', () => {
    const { family } = made()
    for (const el of family.el.querySelectorAll('.fp-row')) expect(el.querySelectorAll('svg')).toHaveLength(1)
    expect(row(family, 'Asked').dataset.standing).toBe('question')
    expect(row(family, 'Mid').dataset.standing).toBe('turn')
    expect(row(family, 'Mid').querySelector('.fp-meta')!.textContent).toMatch(/^new file/)
    expect(row(family, 'Mid').querySelector('.fp-count')!.textContent).toBe('1 of 1 ask')
  })
  it('counts what asks across the family', () => {
    const { family } = made()
    expect([...family.el.querySelectorAll('.ws-family-count')].map(el => el.textContent)).toEqual(['1 question', '2 your turn', '1 working'])
  })
  it('holds a lone constitution as its head alone, unfolded', async () => {
    const lone = card({ id: 'solo', status: 'active', shuttleKind: 'oneshot', sessionUuid: 's' })
    const family = new FamilyPage(vi.fn(), conversations(), feeds, placeAt(lone), vi.fn())
    family.update(lone, new ThreadIndex([lone]), now)
    await settled()
    expect(said(family)).toEqual(['solo'])
    expect([...family.el.querySelectorAll('.fp-head .fp-held button')].map(el => el.textContent)).toEqual(['Constitution', 'Open conversation'])
  })
})

describe('a row', () => {
  it('unfolds on a click and moves Rex quietly, and folds on a second click, leaving Rex be', async () => {
    const { family, reach, converse, place } = made()
    click(row(family, 'Mid'))
    expect(reach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }))
    expect(converse).not.toHaveBeenCalled()
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
  it('shows what it holds in one order: tapestry, constitution, sent files oldest to newest, then the way to Rex', async () => {
    const { family } = made()
    click(row(family, 'Mid'))
    await settled()
    expect(held(family, 'Mid')).toEqual(['Tapestry', 'Constitution', 'old.md', 'mid.md', 'new.png', 'Open conversation'])
    expect(row(family, 'Mid').querySelector('[data-held="doc:new.png"]')!.hasAttribute('data-unread')).toBe(true)
  })
  it('folds the earlier files behind a count, which opens them', () => {
    const many = Array.from({ length: 11 }, (_, n) => file(`f${n}.md`, n + 1))
    const { family } = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? many : [], lead: async () => undefined } })
    click(row(family, 'Mid'))
    expect(held(family, 'Mid').slice(0, 4)).toEqual(['Constitution', '3 earlier', 'f7.md', 'f6.md'])
    click(row(family, 'Mid').querySelector('.fp-earlier')!)
    expect(held(family, 'Mid')).toHaveLength(13)
    expect(said(family)).toContain('Leaf')
  })
  it('opens a held page on the stage, with no word to Rex and no fold', async () => {
    const { family, open, reach } = made()
    click(row(family, 'Mid'))
    await settled()
    reach.mockClear()
    click(row(family, 'Mid').querySelector('[data-kind="lead"]')!)
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }), 'doc:Tapestry')
    click(row(family, 'Mid').querySelector('[data-kind="constitution"]')!)
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'hub/mid' }), expect.stringContaining('hub/mid'))
    expect(reach).not.toHaveBeenCalled()
    expect(said(family)).toContain('Leaf')
  })
  it('offers a folded row\'s tapestry in one click, without unfolding it or moving Rex', async () => {
    const { family, open, reach } = made()
    await settled()
    const lead = row(family, 'Mid').querySelector<HTMLButtonElement>('.fp-lead')!
    expect(lead.hidden).toBe(false)
    expect(lead.textContent).toBe('Tapestry')
    click(lead)
    expect(open).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }), 'doc:Tapestry')
    expect(reach).not.toHaveBeenCalled()
    expect(row(family, 'Mid').getAttribute('aria-expanded')).toBe('false')
    expect(row(family, 'Idle').querySelector<HTMLButtonElement>('.fp-lead')!.hidden).toBe(true)
  })
  it('opens a conversation only from its button', () => {
    const { family, converse } = made()
    click(row(family, 'Mid'))
    click(row(family, 'Mid').querySelector('.fp-converse')!)
    expect(converse).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }))
  })
  it('names a sent tapestry as the lead when the fiber\'s directory holds none', async () => {
    const { family } = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? [file('tapestry.html', 1), ...sent] : [], lead: async () => undefined } })
    click(row(family, 'Mid'))
    await settled()
    expect(held(family, 'Mid').slice(0, 3)).toEqual(['Tapestry', 'Constitution', 'old.md'])
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
  const at = (): string => (document.activeElement as HTMLElement).querySelector('.fp-name')?.textContent ?? document.activeElement!.textContent!
  const keys = (...names: string[]): void => { for (const name of names) press(document.activeElement!, name) }
  it('step through one level with j and k, go down with l and up with h, and leave Rex be', async () => {
    const { family, reach } = made()
    await settled()
    family.focus()
    expect(at()).toBe('hub')
    keys('j')
    expect(at()).toBe('Constitution')
    keys('j', 'j')
    expect(at()).toBe('Mid')
    keys('j', 'k')
    expect(at()).toBe('Mid')
    keys('l')
    expect(said(family)).toContain('Leaf')
    expect(at()).toBe('Tapestry')
    keys('j', 'j', 'j', 'j', 'j')
    expect(at()).toBe('Open conversation')
    keys('j')
    expect(at()).toBe('Leaf')
    keys('h')
    expect(at()).toBe('Mid')
    keys('h')
    expect(said(family)).not.toContain('Leaf')
    expect(at()).toBe('hub')
    keys('ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown')
    expect(at()).toBe('1 archived · 1 draft')
    keys('l')
    expect(at()).toBe('Done')
    expect(reach).not.toHaveBeenCalled()
  })
  it('do what a click does on Enter; Escape folds the open row around the selection', () => {
    const { family, reach } = made()
    family.focus()
    keys('j', 'j', 'j')
    expect(at()).toBe('Mid')
    keys('Enter')
    expect(reach).toHaveBeenCalledOnce()
    keys('l')
    keys('k')
    expect(family.foldOut()).toBe(true)
    expect(said(family)).not.toContain('Leaf')
    expect(at()).toBe('Mid')
    expect(family.foldOut()).toBe(false)
  })
})

describe('landing', () => {
  it('lands on a fiber\'s row, unfolded and selected, opening what hides it', () => {
    const { family, sighted } = made({ place: placeAt(leaf) })
    expect(said(family)).toContain('Leaf')
    expect(row(family, 'Leaf').getAttribute('aria-selected')).toBe('true')
    expect(row(family, 'Leaf').getAttribute('aria-expanded')).toBe('true')
    expect(family.settled?.id).toBe('hub/mid/a')
    expect(sighted).toHaveBeenCalled()
  })
  it('lands again once the family grows the orchestrator above it, and not on every repaint', () => {
    const family = new FamilyPage(vi.fn(), conversations(), feeds, placeAt(leaf), vi.fn())
    family.update(leaf, new ThreadIndex([leaf]), now)
    family.update(leaf, new ThreadIndex(cards), now)
    expect(said(family)).toContain('Leaf')
    click(row(family, 'Mid'))
    family.update(leaf, new ThreadIndex(cards), now + 120_000)
    expect(said(family)).not.toContain('Leaf')
  })
  it('comes to the thread Rex moved to without speaking to Rex, and refuses one of another family', () => {
    const { family, reach, converse, place } = made()
    expect(family.flyTo(leaf)).toBe(true)
    expect(row(family, 'Leaf').getAttribute('aria-selected')).toBe('true')
    expect(row(family, 'Leaf').hasAttribute('data-worker')).toBe(true)
    expect(place.worker).toContain('hub/mid/a')
    expect(family.flyTo(card({ id: 'elsewhere' }))).toBe(false)
    expect(reach).not.toHaveBeenCalled()
    expect(converse).not.toHaveBeenCalled()
  })
})

describe('`l`', () => {
  const leading = async (family: FamilyPage): Promise<string | undefined> => { let doc: string | undefined; family.leading(lead => { doc = lead?.doc }); await settled(); return doc }
  it('names the selected thread\'s tapestry, else its newest file, reading each thread once', async () => {
    const reads = vi.fn(feeds.lead), { family } = made({ feeds: { ...feeds, lead: reads } })
    expect(await leading(family)).toBeUndefined()
    click(row(family, 'Mid'))
    expect(await leading(family)).toBe('doc:Tapestry')
    expect(reads.mock.calls.filter(([thread]) => thread.id === 'hub/mid')).toHaveLength(1)
    const { family: other } = made({ feeds: { ...feeds, lead: async () => undefined } })
    click(row(other, 'Mid'))
    expect(await leading(other)).toBe('doc:new.png')
  })
  it('waits for a tapestry still being read, and drops it if the selection moves on', async () => {
    const landing: Array<() => void> = []
    const slow = (thread: KanbanCard): Promise<MapFile | undefined> => new Promise(resolve => landing.push(() => { void feeds.lead(thread).then(resolve) }))
    const { family } = made({ feeds: { ...feeds, lead: slow } })
    click(row(family, 'Mid'))
    let doc: string | undefined
    family.leading(lead => { doc = lead?.doc })
    await settled()
    expect(doc).toBeUndefined()
    landing.splice(0).forEach(land => land())
    await settled()
    expect(doc).toBe('doc:Tapestry')
    doc = undefined
    click(row(family, 'Idle'))
    family.leading(lead => { doc = lead?.doc })
    click(row(family, 'Mid'))
    landing.splice(0).forEach(land => land())
    await settled()
    expect(doc).toBeUndefined()
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
    for (let n = 0; n < 4; n++) press(document.activeElement!, 'ArrowDown')
    const before = row(family, 'Idle')
    expect(document.activeElement).toBe(before)
    family.update(root, new ThreadIndex([...cards, card({ id: 'hub/new', name: 'New', orchestrator: 'hub', status: 'active', ask: { text: 'New?', at: when(0) } })]), now + 120_000)
    expect(said(family)).toContain('New')
    expect(row(family, 'Idle')).toBe(before)
    expect(document.activeElement).toBe(before)
  })
  it('tells its owner when its frame is evicted', () => {
    const disposed = vi.fn(), family = new FamilyPage(vi.fn(), conversations(), feeds, placeAt(root), disposed)
    disposeFileViewer(family.el)
    expect(disposed).toHaveBeenCalledOnce()
  })
})
