// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { card, conversations, settle } from '../testFixtures.js'
import { ThreadIndex } from '../threads.js'
import type { KanbanCard } from '../KanbanTypes.js'
import type { MapFile } from '../family/model.js'
import { disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { FamilyPage, placeAt, type FamilyFeeds, type MapPlace } from './FamilyPage.js'
import { Dock } from './Dock.js'
import { leadVerb, lifecycleVerbsFor, verbSpec } from './lifecycleVerbs.js'
import { offeredVerbs } from './testActs.js'

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
const feeds: FamilyFeeds = { marks: () => undefined, reach: () => 14 * 86_400_000, files: c => c.id === 'hub/mid' ? sent : [], refresh: vi.fn(), lead: async c => c.id === 'hub/mid' ? tapestry : undefined, embed: () => ({ el: document.createElement('div'), dispose: () => {} }), seen: () => {}, fiberAt: () => undefined, shuttleBase: '' }

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
/** A view segment in the notation the help sheet uses: ⌗ tapestry, ☰ constitution, ⧉ n sends. */
const segment = (el: Element): string => el.classList.contains('fp-lead') ? '⌗' : el.classList.contains('fp-constitution') ? '☰' : `⧉ ${el.textContent}`
const chips = (family: FamilyPage, name: string): string[] => [...row(family, name).querySelectorAll('.fp-docs button')].map(segment)
const files = (family: FamilyPage, name: string): string[] => [...row(family, name).querySelectorAll('.fp-file-name')].map(el => el.textContent!)
const click = (el: Element): void => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 })) }
const press = (el: Element, key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); el.dispatchEvent(event); return event }

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

describe('the page', () => {
  it('heads with the constitution and its outcome, then its threads under one divider per kind, the set-aside behind one fold', () => {
    const { family } = made()
    expect(said(family)).toEqual(['hub', '[Questions]', 'Asked', '[Your turn]', 'Mid', 'Idle', '(1 draft · 1 archived)'])
    expect(family.el.querySelector('.fp-head .fp-note')!.textContent).toBe('The hub came to this.')
    expect(row(family, 'Asked').querySelector('.fp-note')!.textContent).toBe('Which one?')
    expect(row(family, 'Idle').querySelector('.fp-note')!.textContent).toBe('Needs a look')
  })
  it('gives each row one mark for its own state, files it under the most urgent thing it holds, and draws what is under it', () => {
    const { family } = made()
    for (const el of family.el.querySelectorAll('.fp-row')) expect(el.querySelectorAll('.fp-title > svg')).toHaveLength(1)
    expect(row(family, 'Asked').dataset.standing).toBe('question')
    expect(row(family, 'Asked').querySelector('.fp-mark title')!.textContent).toBe('question')
    expect(row(family, 'Asked').querySelector('.fp-word')!.textContent, 'the mark says it; no word repeats it').toBe('')
    expect(row(family, 'Mid').dataset.standing).toBe('working')
    const lines = said(family)
    expect(lines.slice(0, lines.indexOf('Mid')).filter(line => line.startsWith('[')).at(-1), 'Mid sits with Your turn, for the leaf under it').toBe('[Your turn]')
    expect(row(family, 'Mid').querySelector('.fp-meta')!.textContent).toMatch(/^(now|\d+\w+)$/)
    const tally = row(family, 'Mid').querySelector<HTMLElement>('.fp-count')!
    expect(tally.getAttribute('aria-label')).toBe('1 of 1 ask')
    expect([...tally.querySelectorAll<HTMLElement>('.fp-tally-mark')].map(mark => mark.dataset.standing)).toEqual(['turn'])
  })
  it('names the threads set aside on one fold at the end, resting first, then drafts and seats, archived last', () => {
    const resting = card({ id: 'hub/r', name: 'Resting', orchestrator: 'hub', status: 'open', effectiveHorizon: 'stashed', createdAt: when(60) })
    const discarded = card({ id: 'hub/x', name: 'Discarded', orchestrator: 'hub', status: 'closed', tempered: false, createdAt: when(70), closedAt: when(1) })
    const { family } = made({ known: [...cards, resting, discarded] })
    expect(said(family).at(-1)).toBe('(1 resting · 1 draft · 2 archived)')
    expect(family.el.querySelector('.fp-aside')!.getAttribute('aria-expanded')).toBe('false')
  })
  it('counts only the live threads under a row, never those set aside', () => {
    const archived = card({ id: 'hub/mid/old', name: 'Old', orchestrator: 'hub/mid', status: 'closed', tempered: true, createdAt: when(60), closedAt: when(30) })
    const { family } = made({ known: [...cards, archived] })
    const tally = row(family, 'Mid').querySelector<HTMLElement>('.fp-count')!
    expect(tally.getAttribute('aria-label')).toBe('1 of 1 ask')
    expect(tally.textContent).toBe('')
    expect(tally.querySelectorAll('.fp-tally-mark')).toHaveLength(1)
  })
  it('holds a lone constitution as its head alone, unfolded', async () => {
    const lone = card({ id: 'solo', status: 'active', shuttleKind: 'oneshot', sessionUuid: 's' })
    const family = new FamilyPage(conversations(), feeds, placeAt(lone), vi.fn())
    family.update(lone, new ThreadIndex([lone]), now)
    await settle()
    expect(said(family)).toEqual(['solo'])
    expect(chips(family, 'solo')).toEqual(['☰'])
  })
  it('opens a lone constitution on its tapestry, unfolded under its head, and a fold then holds', async () => {
    const lone = card({ id: 'solo', status: 'active', shuttleKind: 'oneshot', sessionUuid: 's', outcome: 'Solo came to this.' })
    const embed = vi.fn(() => ({ el: document.createElement('div'), dispose: () => {} }))
    const place = placeAt(lone), index = new ThreadIndex([lone])
    const family = new FamilyPage(conversations(), { ...feeds, lead: async () => tapestry, embed }, place, vi.fn())
    family.update(lone, index, now)
    await settle()
    const head = row(family, 'solo')
    expect(head.querySelector('.fp-note')!.textContent).toBe('Solo came to this.')
    expect(embed).toHaveBeenCalledExactlyOnceWith(lone, 'doc:Tapestry')
    expect(head.querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    click(head.querySelector('.fp-lead')!)
    family.update(lone, index, now + 120_000)
    expect(head.querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(embed).toHaveBeenCalledOnce()
  })
  it('leaves a constitution with threads folded until asked', async () => {
    const embed = vi.fn(() => ({ el: document.createElement('div'), dispose: () => {} }))
    made({ feeds: { ...feeds, lead: async () => tapestry, embed } })
    await settle()
    expect(embed).not.toHaveBeenCalled()
  })
})

describe('a row', () => {
  it('unfolds on a click and moves Rex quietly, and folds on a second click, leaving Rex be', async () => {
    const { family, reach, place } = made()
    click(row(family, 'Mid'))
    expect(reach).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'hub/mid' }))
    expect(said(family)).toContain('Leaf')
    expect(row(family, 'Mid').getAttribute('aria-expanded')).toBe('true')
    await settle()
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
    await settle()
    expect(place.worker).toBeUndefined()
    expect(row(family, 'Mid').hasAttribute('data-worker')).toBe(false)
  })
  it('shows glyph chips and lists sent files newest first', async () => {
    const { family, place } = made()
    await settle()
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
  it('folds a sent file open from the list when the list folds, and returns the cursor to ⧉ n', async () => {
    const dispose = vi.fn()
    const { family, place } = made({ feeds: { ...feeds, embed: () => ({ el: document.createElement('div'), dispose }) } })
    await settle()
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    click(row(family, 'Mid').querySelector<HTMLElement>('.fp-file')!)
    row(family, 'Mid').querySelector<HTMLElement>('.fp-back')!.focus()
    expect(place.docs!.size).toBe(1)
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    expect(place.docs!.size).toBe(0)
    expect(dispose).toHaveBeenCalledOnce()
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(document.activeElement).toBe(row(family, 'Mid').querySelector('.fp-sent'))
  })
  it('embeds a chip inline and disposes it on the second click', async () => {
    const dispose = vi.fn(), embedded = document.createElement('div')
    const embed = vi.fn(() => ({ el: embedded, dispose }))
    const { family, reach, sighted, place } = made({ feeds: { ...feeds, embed } })
    await settle()
    click(row(family, 'Mid').querySelector('.fp-lead')!)
    expect(embed).toHaveBeenCalledExactlyOnceWith(mid, 'doc:Tapestry')
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')
    expect(row(family, 'Mid').querySelector('.fp-doc')!.contains(embedded)).toBe(true)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-pressed')).toBe('true')
    expect(reach).toHaveBeenCalledExactlyOnceWith(mid)
    expect(sighted).toHaveBeenCalledOnce()
    expect(family.selection, 'what `c` opens is the thread whose document is open').toBe(mid)
    place.entered = null
    click(row(family, 'Mid').querySelector('.fp-lead')!)
    expect(reach, 'folding a document never touches Rex').toHaveBeenCalledOnce()
    expect(sighted).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
    expect(place.docs!.size).toBe(0)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-pressed')).toBe('false')
  })
  it('counts a thread\'s sent files seen once their list has been open, without a click on each', async () => {
    let mine = [file('new.png', 1, true), file('also.png', 2, true), file('old.md', 3)]
    const seen = vi.fn((files: readonly MapFile[]) => { mine = mine.map(f => files.some(s => s.key === f.key) ? { ...f, unread: false } : f) })
    const { family } = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? mine : [], lead: async () => undefined, seen } })
    await settle()
    expect(row(family, 'Mid').querySelector('.fp-sent')!.hasAttribute('data-unread')).toBe(true)
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    expect(seen).toHaveBeenCalledExactlyOnceWith([mine[0], mine[1]].map(f => ({ ...f, unread: true })))
    expect(row(family, 'Mid').querySelector('.fp-sent')!.hasAttribute('data-unread')).toBe(false)
    expect(row(family, 'Mid').hasAttribute('data-fresh'), 'a new file is the chip\'s mark, never the row\'s').toBe(false)
  })
  it('counts a document seen when it unfolds', async () => {
    const seen = vi.fn()
    const { family } = made({ feeds: { ...feeds, lead: async c => c.id === 'hub/mid' ? { ...tapestry, unread: true } : undefined, seen } })
    await settle()
    click(row(family, 'Mid').querySelector('.fp-lead')!)
    expect(seen).toHaveBeenCalledExactlyOnceWith([expect.objectContaining({ key: tapestry.key })])
    expect(row(family, 'Mid').querySelector('.fp-lead')!.hasAttribute('data-unread')).toBe(false)
  })
  it('names a sent tapestry as the lead when the fiber\'s directory holds none', async () => {
    const { family } = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? [file('tapestry.html', 1), ...sent] : [], lead: async () => undefined } })
    click(row(family, 'Mid'))
    await settle()
    expect(chips(family, 'Mid')).toEqual(['⌗', '☰', '⧉ 3'])
    expect(row(family, 'Mid').querySelector('.fp-lead')!.getAttribute('aria-label')).toBe('Tapestry')
  })
  it('draws each fiber\'s acts on its row, the head\'s included, as the lifecycle offers them; a click acts without unfolding', () => {
    const work = { ...mid, shuttleKind: 'oneshot' as const }, review = { ...done, tempered: undefined, column: 'awaitingReview' as const, shuttleKind: 'oneshot' as const }
    const transition = vi.fn(), reach = vi.fn(async () => true)
    const dock = new Dock('', vi.fn(), transition, undefined, { onRest: vi.fn() })
    const family = new FamilyPage({ reach }, feeds, { open: new Set(), selected: null }, vi.fn(), vi.fn(), vi.fn(), target => dock.actsFor(target))
    family.update(root, new ThreadIndex([root, work, review]), now)
    const verbs = (name: string): string[] => offeredVerbs(row(family, name).querySelector('.fp-verbs')!)
    for (const [name, card] of [['Mid', work], ['Done', review], ['hub', root]] as const) {
      const offered = lifecycleVerbsFor(card, true), lead = leadVerb(card, offered)
      expect(verbs(name), name).toEqual([...lead ? [lead] : [], ...offered.filter(verb => verb !== lead)].map(verb => verbSpec(verb, card).label))
      expect(row(family, name).querySelector('.fp-verbs .ws-acts-settings'), name).not.toBeNull()
      expect(row(family, name).querySelector<HTMLElement>('.fp-verbs .ws-fiber-acts')!.dataset.verdictKey, name).toBeTruthy()
    }
    const close = row(family, 'Mid').querySelector<HTMLButtonElement>('.kbn-ctl-review')!
    vi.stubGlobal('confirm', () => true)
    click(close)
    vi.unstubAllGlobals()
    expect(transition).toHaveBeenCalledExactlyOnceWith(work, 'awaitingReview')
    expect(family.selection).toEqual(work)
    expect(row(family, 'Mid').getAttribute('aria-expanded')).toBe('false')
    expect(reach).not.toHaveBeenCalled()
    family.dispose()
  })
  it('keeps the set-aside behind its fold until asked', () => {
    const { family } = made()
    expect(said(family)).not.toContain('Done')
    click(family.el.querySelector('.fp-aside')!)
    expect(said(family).slice(-4)).toEqual(['[Drafts]', 'Draft', '[Archived]', 'Done'])
    expect(row(family, 'Done').dataset.standing).toBe('quiet')
  })
})

describe('keys', () => {
  const at = (): string => { const active = document.activeElement as HTMLElement; return active.querySelector<HTMLElement>('.fp-name')?.title || (active.closest('.fp-docs') ? segment(active) : active.textContent!) }
  const keys = (...names: string[]): void => { for (const name of names) press(document.activeElement!, name) }
  it('moves the highlight without entering; l enters the thread and focuses its first chip', async () => {
    const { family, reach, sighted } = made()
    await settle()
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
  it('unfolds a row\'s first document with l, the next in its place with l again, and goes back out with h', async () => {
    const { family, reach, place } = made()
    const leave = vi.fn(); family.leave = leave
    await settle()
    family.focus()
    const doc = (): HTMLElement => row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!
    keys('j', 'j', 'l')
    expect(at()).toBe('⌗')
    expect(doc().hidden).toBe(false)
    expect(reach).toHaveBeenCalledOnce()
    keys('l')
    expect(at()).toBe('☰')
    expect(doc().hidden).toBe(false)
    const open = (): string | undefined => place.docs!.get(row(family, 'Mid').dataset.thread!)
    keys('l')
    expect(at(), 'an open sent file rests on its way back').toBe('← sends')
    expect(open()).toBe('doc:new.png')
    expect(doc().hidden).toBe(false)
    keys('l')
    expect(open()).toBe('doc:mid.md')
    keys('h')
    expect(at(), 'back to the list, on the file just open').toContain('mid.md')
    expect(doc().hidden).toBe(true)
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-files')!.hidden).toBe(false)
    keys('h')
    expect(at()).toBe('Mid')
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-files')!.hidden).toBe(true)
    keys('h')
    expect(leave).toHaveBeenCalledOnce()
  })
  it('moves among the rows with a document unfolded, which stays under its own row', async () => {
    const { family, place } = made()
    await settle()
    family.focus()
    const doc = (): HTMLElement => row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!
    keys('j', 'j', 'l')
    expect(at()).toBe('⌗')
    keys('j')
    expect(at()).toBe('Idle')
    expect(family.selection?.id).toBe('hub/w')
    expect(doc().hidden).toBe(false)
    keys('k', 'k')
    expect(at()).toBe('Asked')
    expect(place.docs!.size).toBe(1)
  })
  it('folds what the page has unfolded with h from any row before h leaves, as on a return that lands elsewhere', async () => {
    const leave = vi.fn(), { family, place } = made()
    await settle()
    family.focus()
    keys('j', 'j', 'l')
    family.dispose()
    const back = new FamilyPage({ reach: vi.fn(async () => true) }, feeds, Object.assign(place, placeAt(root)), vi.fn())
    back.leave = leave
    document.body.replaceChildren(back.el)
    back.update(root, new ThreadIndex(cards), now)
    await settle()
    back.focus()
    expect(at()).toBe('hub')
    expect(row(back, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    keys('h')
    expect(row(back, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(at()).toBe('hub')
    expect(leave).not.toHaveBeenCalled()
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

describe('choose', () => {
  it('highlights a thread of the family, and ignores one of another', () => {
    const { family } = made()
    family.choose(idle)
    expect(family.selection).toBe(idle)
    family.choose(card({ id: 'elsewhere' }))
    expect(family.selection).toBe(idle)
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
    family.toggleLead(); await settle()
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')
    family.toggleLead(); await settle()
    expect(place.docs!.size).toBe(0)
    expect(reads.mock.calls.filter(([thread]) => thread.id === 'hub/mid')).toHaveLength(1)
    const { family: other, place: otherPlace } = made({ feeds: { ...feeds, lead: async () => undefined } })
    click(row(other, 'Mid'))
    other.toggleLead(); await settle()
    expect(otherPlace.docs!.get(row(other, 'Mid').dataset.thread!)).toBe('doc:new.png')
  })
  it('waits for the lead read and ignores it if the selection moves', async () => {
    const landing: Array<() => void> = []
    const slow = (thread: KanbanCard): Promise<MapFile | undefined> => new Promise(resolve => landing.push(() => { void feeds.lead(thread).then(resolve) }))
    const { family, place } = made({ feeds: { ...feeds, lead: slow } })
    click(row(family, 'Mid'))
    family.toggleLead()
    await settle()
    expect(place.docs!.size).toBe(0)
    landing.splice(0).forEach(land => land())
    await settle()
    expect(place.docs!.get(row(family, 'Mid').dataset.thread!)).toBe('doc:Tapestry')

    const pending: Array<() => void> = []
    const { family: other, place: otherPlace } = made({ feeds: { ...feeds, lead: thread => new Promise(resolve => pending.push(() => { void feeds.lead(thread).then(resolve) })) } })
    click(row(other, 'Mid'))
    other.toggleLead()
    click(row(other, 'Idle'))
    pending.splice(0).forEach(land => land())
    await settle()
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

describe('sends', () => {
  /** Mid's sends: eight moments, the newest carrying a page from another fiber's directory, a script and two figures. */
  const at = (n: number): number => now - n * hour
  const sentAt = (path: string, back: number): MapFile => ({ key: `host-a:${path}`, name: path.split('/').pop()!, at: at(back), unread: false })
  const sends = [
    sentAt('/loom/gc/report.html', 1), sentAt('/work/fits/fit.py', 1), sentAt('/work/plots/a.png', 1), sentAt('/work/plots/b.png', 1),
    ...Array.from({ length: 7 }, (_, n) => sentAt(`/loom/meet-${n}/report.html`, n + 2)),
  ]
  const fibers = (path: string): string | undefined => /^\/loom\/(gc|meet-\d)\//.exec(path)?.[1]
  const open = async (): Promise<Made> => {
    const made_ = made({ feeds: { ...feeds, files: c => c.id === 'hub/mid' ? sends : [], fiberAt: fibers } })
    await settle()
    click(row(made_.family, 'Mid').querySelector('.fp-sent')!)
    return made_
  }
  const lines = (family: FamilyPage): string[] => [...row(family, 'Mid').querySelectorAll('.fp-send')].map(line =>
    [line.querySelector('.fp-send-age')!.textContent, ...[...line.querySelectorAll('.fp-file')].map(item => item.getAttribute('aria-label'))].join(' '))

  it('draws one line per send, its age once, its files named by their fiber or directory, figures as thumbnails, the older sends folded', async () => {
    const { family } = await open()
    expect(lines(family)).toEqual(['1h gc fits/fit.py plots/a.png plots/b.png', '2h meet-0', '3h meet-1', '4h meet-2', '5h meet-3'])
    const first = row(family, 'Mid').querySelector('.fp-send')!
    expect([...first.querySelectorAll<HTMLElement>('.fp-file-glyph')].map(glyph => glyph.dataset.mark)).toEqual(['page', 'code'])
    expect(first.querySelectorAll('.fp-file-image .fp-thumb')).toHaveLength(2)
    const older = row(family, 'Mid').querySelector<HTMLElement>('.fp-older')!
    expect(older.textContent).toBe('3 older sends')
    click(older)
    expect(lines(family)).toHaveLength(8)
    expect(document.activeElement).toBe(row(family, 'Mid').querySelector('.fp-older'))
    expect(row(family, 'Mid').querySelector('.fp-older')!.textContent).toBe('fewer')
  })
  it('opens a file in the list\'s place, steps through the files from there, and goes back to the list on that file', async () => {
    const { family, place } = await open()
    const shown = (): string | undefined => place.docs!.get(row(family, 'Mid').dataset.thread!)
    click(row(family, 'Mid').querySelector('[aria-label="fits/fit.py"]')!)
    expect(shown()).toBe('host-a:/work/fits/fit.py')
    expect(row(family, 'Mid').querySelectorAll('.fp-send')).toHaveLength(0)
    expect(row(family, 'Mid').querySelector('.fp-open')!.textContent).toBe('← sendsfits/fit.py1h‹2 of 11›')
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(false)
    click(row(family, 'Mid').querySelector('.fp-step:last-of-type')!)
    expect(shown()).toBe('host-a:/work/plots/a.png')
    row(family, 'Mid').querySelector<HTMLElement>('.fp-back')!.focus()
    for (let n = 0; n < 6; n++) press(document.activeElement!, 'l')
    expect(shown(), 'l steps on to older files, into the folded sends').toBe('host-a:/loom/meet-4/report.html')
    press(document.activeElement!, 'h')
    expect(shown()).toBeUndefined()
    expect(row(family, 'Mid').querySelector<HTMLElement>('.fp-doc')!.hidden).toBe(true)
    expect(lines(family), 'the folded sends unfold to show the file').toHaveLength(8)
    expect(document.activeElement!.getAttribute('aria-label')).toBe('meet-4')
    press(document.activeElement!, 'l')
    expect(shown(), 'l on a listed file opens that file').toBe('host-a:/loom/meet-4/report.html')
    click(row(family, 'Mid').querySelector('.fp-back')!)
    expect(document.activeElement!.getAttribute('aria-label')).toBe('meet-4')
  })
  it('steps through the open files on left and right, from the row or its bar, while h and l keep the tree', async () => {
    const { family, place } = await open()
    const mid = (): HTMLElement => row(family, 'Mid'), shown = (): string | undefined => place.docs!.get(mid().dataset.thread!)
    mid().focus()
    expect(press(mid(), 'ArrowRight').defaultPrevented).toBe(true)
    expect(shown(), 'with no sent file open, right goes in as l does').toBe('doc:Tapestry')
    expect(document.activeElement).toBe(mid().querySelector('.fp-docs button'))
    click(mid().querySelector('[aria-label="fits/fit.py"]')!)
    mid().focus()
    press(mid(), 'ArrowRight')
    expect(shown(), 'right steps to the older file').toBe('host-a:/work/plots/a.png')
    expect(document.activeElement, 'the row keeps the cursor').toBe(mid())
    press(mid(), 'ArrowLeft')
    press(mid(), 'ArrowLeft')
    expect(shown(), 'left steps to the newer file').toBe('host-a:/loom/gc/report.html')
    press(mid(), 'ArrowLeft')
    expect(shown(), 'the newest stays').toBe('host-a:/loom/gc/report.html')
    mid().querySelector<HTMLElement>('.fp-back')!.focus()
    press(document.activeElement!, 'ArrowRight')
    expect(shown()).toBe('host-a:/work/fits/fit.py')
    expect(document.activeElement, 'the redrawn bar takes the cursor').toBe(mid().querySelector('.fp-back'))
    press(document.activeElement!, 'h')
    expect(shown(), 'h goes back to the list').toBeUndefined()
    expect(document.activeElement!.getAttribute('aria-label')).toBe('fits/fit.py')
    press(document.activeElement!, 'ArrowLeft')
    expect(mid().querySelector<HTMLElement>('.fp-files')!.hidden, 'with the file closed, left goes out as h does').toBe(true)
  })
  it('lets go of its thumbnails when the list folds', async () => {
    const { family } = await open()
    expect(document.querySelectorAll('.fp-thumb')).toHaveLength(2)
    click(row(family, 'Mid').querySelector('.fp-sent')!)
    expect(document.querySelectorAll('.fp-thumb')).toHaveLength(0)
  })
})
