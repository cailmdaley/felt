// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, expectPinnedZone } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { docKey } from './documents.js'
import { Overview, overviewDayGroup, overviewHostMarks } from './Overview.js'

const rect = (top: number, left = 0, width = 176, height = 116): DOMRect => ({
  x: left, y: top, left, top, width, height, right: left + width, bottom: top + height, toJSON: () => ({}),
})
class Observer {
  static current: Observer
  readonly targets = new Set<Element>()
  readonly callback: IntersectionObserverCallback
  readonly options?: IntersectionObserverInit
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) { this.callback = callback; this.options = options; Observer.current = this }
  observe(el: Element): void { this.targets.add(el) }
  unobserve(el: Element): void { this.targets.delete(el) }
  disconnect(): void { this.targets.clear() }
  deliver(targets: Element[], visible = true): void {
    this.callback(targets.map(target => ({ target, isIntersecting: visible }) as IntersectionObserverEntry), this as unknown as IntersectionObserver)
  }
}
let overview: Overview
let cards: KanbanCard[]
let feed: { files: unknown[]; origins?: Record<string, unknown> }
let onOpen = vi.fn<(card: KanbanCard, doc?: string) => void>()
let onOrder = vi.fn<(cards: KanbanCard[]) => void>()
let fetchMock: ReturnType<typeof vi.fn>
let frames: Map<number, FrameRequestCallback>
let frameId = 0
const now = (): number => Date.now()
const receipt = (uid: string, path: string, at = now(), host = 'host-a', extra: Record<string, unknown> = {}): Record<string, unknown> => ({ uid, fullPath: path, timestamp: at, host, ...extra })
const settle = async (): Promise<void> => { for (let i = 0; i < 15; i++) await Promise.resolve() }
const draw = (): void => {
  const current = [...frames.values()]; frames.clear()
  for (const frame of current) frame(performance.now())
}
const refresh = async (): Promise<void> => { overview.refresh(); await settle() }
const folio = (uid: string): HTMLButtonElement => overview.el.querySelector<HTMLButtonElement>(`.ws-overview-folio[data-uid="${uid}"]`)!
const name = (uid: string): string => folio(uid).querySelector('.ws-overview-folio-title')!.textContent!
const groups = (): string[] => [...overview.el.querySelectorAll('.ws-overview-group')].filter(el => !(el as HTMLElement).hidden).map(el => el.querySelector('h2')!.firstChild!.textContent!)
const lens = (value: string): void => {
  overview.el.querySelector<HTMLButtonElement>(`.ws-overview-lens [data-lens="${value}"]`)!.click()
}
const find = (value: string): void => {
  const input = overview.el.querySelector<HTMLInputElement>('.ws-overview-find')!
  input.value = value; input.dispatchEvent(new Event('input'))
}
const activate = (elements = [...Observer.current.targets]): void => {
  Object.defineProperty(overview.el, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 0, 1000, 800) })
  elements.forEach((el, i) => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect(100 + i * 5, 100) }))
  Observer.current.deliver(elements); draw()
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 6, 15, 14))
  frames = new Map(); frameId = 0
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++frameId, cb); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('IntersectionObserver', Observer)
  vi.stubGlobal('ResizeObserver', undefined)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), clear: () => storage.clear() })
  document.body.replaceChildren()
  cards = [card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha result', path: '.felt/science/shear/alpha/alpha.md', originId: 'host-a', fiberDir: '/notes/alpha', outcome: 'A checked measurement.' }),
    card({ id: 'work/beta', uid: 'beta', name: 'Beta pipeline', path: '.felt/tools/pipeline/beta/beta.md', originId: 'host-b' })]
  feed = { files: [], origins: { 'host-b': {}, 'host-a': {} } }
  fetchMock = vi.fn(async (url: string) => new Response(url.includes('/sent-files/all/composite') ? JSON.stringify(feed) : 'safe text', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  onOpen = vi.fn(); onOrder = vi.fn()
  overview = new Overview({ shuttleBase: 'http://daemon', cards: () => cards, onOpen, onOrder })
  document.body.append(overview.el)
})
afterEach(() => { overview?.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Overview receipt membership and identity', () => {
  it('reads the raw 30-day feed, ignores invalid/old records, joins uid and dedupes normalized owner+path', async () => {
    feed.files = [receipt('alpha', '/notes/alpha/./report.html', now() - 1000), receipt('alpha', '/notes/alpha/report.html'),
      receipt('beta', '/notes/alpha/report.html', now(), 'host-b'), receipt('alpha', '/old.html', now() - 31 * 86400000),
      receipt('alpha', '/invalid.html', NaN), receipt('alpha', '/zero.html', 0), { uid: 'alpha' }]
    await refresh()
    expect(fetchMock.mock.calls[0][0]).toBe(`http://daemon/api/v1/sent-files/all/composite?since_ms=${now() - 30 * 86400000}`)
    expect(overview.el.querySelectorAll('.ws-overview-rib')).toHaveLength(2)
    expect(folio('alpha').querySelector('.ws-overview-footer')!.textContent).toContain('1 document')
    expect(name('alpha')).toBe('Alpha result')
    expect(overview.orderedCards().map(c => c.uid)).toEqual(['alpha', 'beta'])
    const first = overview.el.querySelector<HTMLButtonElement>('.ws-overview-rib')!
    first.click(); await settle()
    expect(onOpen).toHaveBeenCalledWith(cards[0], docKey('host-a', '/notes/alpha/report.html', 'host-a'))
    expect(folio('alpha').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(true)
  })

  it('takes twelve newest documents, not twelve sends, and deterministically breaks ties', async () => {
    feed.files = Array.from({ length: 15 }, (_, i) => receipt('alpha', `/file/${String(i).padStart(2, '0')}.html`, now() - i * 1000))
    feed.files.push(receipt('alpha', '/file/00.html', now() - 1000))
    await refresh()
    expect(overview.el.querySelectorAll('.ws-overview-rib')).toHaveLength(12)
    expect([...overview.el.querySelectorAll('.ws-overview-rib-label')].map(el => el.textContent)).toEqual(Array.from({ length: 12 }, (_, i) => `${String(i).padStart(2, '0')}.html`))
    const ribbon = [...overview.el.querySelectorAll('.ws-overview-rib')]
    feed.files.reverse(); await refresh()
    expect([...overview.el.querySelectorAll('.ws-overview-rib')]).toEqual(ribbon)
  })

  it('keeps session-opened fibers without receipts, marks visits persistently, and makes new receipts fresh', async () => {
    overview.opened(cards[1])
    expect(overview.orderedCards()).toEqual([cards[1]])
    expect(folio('beta').querySelector('.ws-overview-thumb-face')!.textContent).toContain('Fiber note')
    expect(folio('beta').querySelector('.ws-overview-footer')!.textContent).toContain('0 documents')
    expect(JSON.parse(localStorage.getItem('shuttle.workspace.overview.visits')!).beta).toBe(now())
    feed.files = [receipt('beta', '/new.html', now() + 1)]
    await refresh()
    expect(folio('beta').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(false)
    overview.dispose()
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el)
    feed.files = [receipt('beta', '/new.html', now() - 1)]
    await refresh()
    expect(folio('beta').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(true)
    feed.files = []; await refresh()
    expect(overview.orderedCards()).toEqual([]) // Session membership is not persisted.
  })

  it('resolves a missing fiber on click through the shared parser without changing the file owner', async () => {
    feed.files = [receipt('missing', '/remote/report.html', now(), 'bytes-host')]
    await refresh()
    expect(name('missing')).toBe('Other · missing')
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('/sent-files/') ? feed : {
      host: 'fiber-host', fibers: [{ origin: 'fiber-host', felt_store: '/store', path: '.felt/work/missing/missing.md', dir: '/store/.felt/work/missing',
        fiber: { id: 'missing', name: 'Resolved measurement', path: '/store/.felt/work/missing/missing.md', status: 'closed' } }],
    })))
    overview.el.querySelector<HTMLButtonElement>('.ws-overview-rib')!.click()
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/v1/fibers/missing?body=true&origin=bytes-host'))).toBe(true)
    expect(onOpen).toHaveBeenCalledOnce()
    const [opened, key] = onOpen.mock.calls[0]
    expect(opened.name).toBe('Resolved measurement')
    expect(opened.originId).toBe('fiber-host')
    expect(key).toBe('bytes-host:/remote/report.html')
  })

  it('still opens an owner-aware Other fallback when a missing fiber cannot be resolved', async () => {
    feed.files = [receipt('missing', '/remote/report.html', now(), 'bytes-host')]
    await refresh()
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    overview.el.querySelector<HTMLButtonElement>('.ws-overview-rib')!.click(); await settle()
    expect(onOpen.mock.calls[0][0]).toMatchObject({ uid: 'missing', originId: 'bytes-host', name: 'Other · missing' })
    expect(onOpen.mock.calls[0][1]).toBe('bytes-host:/remote/report.html')
  })

  it('coalesces refresh reads and retains the sheet on feed failure', async () => {
    feed.files = [receipt('alpha', '/report.html')]; await refresh()
    const original = folio('alpha')
    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    overview.refresh(); overview.refresh(); overview.refresh(); await settle()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(folio('alpha')).toBe(original)
    expect(overview.el.querySelector('[role=status]')!.textContent).toContain('last loaded sheet')
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(feed)))
    await refresh()
    expect(overview.el.querySelector('[role=status]')!.textContent).toBe('')
  })
})

describe('Overview stable lenses, visits, and DOM', () => {
  it('freezes civil groups and ordering on midnight/polls/metadata changes, but moves on a newer receipt', async () => {
    feed.files = [receipt('beta', '/beta.html', now() - 1000), receipt('alpha', '/alpha.html')]
    await refresh()
    const elements = [folio('alpha'), folio('beta')]
    expect(groups()).toEqual(['Today'])
    vi.setSystemTime(new Date(2026, 6, 16, 14))
    cards = cards.map(c => ({ ...c, modifiedAt: new Date().toISOString(), name: `Updated ${c.name}` }))
    feed.files.reverse(); await refresh()
    expect(groups()).toEqual(['Today'])
    expect(overview.orderedCards().map(c => c.uid)).toEqual(['alpha', 'beta'])
    expect([folio('alpha'), folio('beta')]).toEqual(elements)
    feed.files.push(receipt('beta', '/beta.html'))
    await refresh()
    expect(overview.orderedCards().map(c => c.uid)).toEqual(['beta', 'alpha'])
    expect(folio('beta')).toBe(elements[1])
  })

  it('groups by store subtree/host, persists the lens, and excludes Find from channel stepping order', async () => {
    feed.files = [receipt('beta', '/table.csv', now() - 1000, 'host-b'), receipt('alpha', '/result.html')]
    await refresh()
    lens('projects')
    expect(groups()).toEqual(['science / shear', 'tools / pipeline'])
    expect(localStorage.getItem('shuttle.workspace.overview.lens')).toBe('"projects"')
    find('table.csv')
    expect(folio('beta').hidden).toBe(false); expect(folio('alpha').hidden).toBe(true)
    expect(overview.orderedCards().map(c => c.uid)).toEqual(['alpha', 'beta'])
    expect(onOrder.mock.calls.at(-1)![0].map((c: KanbanCard) => c.uid)).toEqual(['alpha', 'beta'])
    find('.felt/science'); expect(folio('alpha').hidden).toBe(false)
    find('ALPHA RESULT'); expect(folio('alpha').hidden).toBe(false)
    find(''); lens('hosts'); expect(groups()).toEqual(['host-a', 'host-b'])
    overview.dispose(); overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el); await refresh()
    expect(overview.el.querySelector('.ws-overview-lens [aria-checked="true"]')?.getAttribute('data-lens')).toBe('hosts')
  })

  it('updates Projects/Hosts only on a newer receipt after metadata changes', async () => {
    feed.files = [receipt('alpha', '/result.html')]; await refresh()
    lens('projects'); expect(groups()).toEqual(['science / shear'])
    cards[0] = { ...cards[0], originId: 'host-c', path: '.felt/research/new/alpha/alpha.md' }
    await refresh(); expect(groups()).toEqual(['science / shear'])
    lens('hosts'); expect(groups()).toEqual(['host-a'])
    feed.files.push(receipt('alpha', '/result.html', now() + 1)); await refresh()
    expect(groups()).toEqual(['host-c'])
    lens('projects'); expect(groups()).toEqual(['research / new'])
  })

  it('preserves mounted report-lead thumbnails through polls, Find, and hide/show, including sheet/ribbon scroll', async () => {
    feed.files = [receipt('alpha', '/notes/alpha/report.html', now() - 1000), receipt('alpha', '/notes/alpha/newest.html')]
    await refresh(); activate()
    const thumbnail = folio('alpha').querySelector('.ws-overview-thumb')!
    const iframe = thumbnail.querySelector('iframe')!
    expect(iframe.src).toContain(encodeURIComponent('/notes/alpha/report.html'))
    expect(iframe.getAttribute('sandbox')).toBe('')
    expect(iframe.inert).toBe(true); expect(iframe.tabIndex).toBe(-1)
    iframe.dispatchEvent(new Event('load')); draw()
    const observer = new MutationObserver(() => {})
    observer.observe(overview.el.querySelector('.ws-overview-groups')!, { childList: true, subtree: true })
    await refresh()
    expect(observer.takeRecords().filter(r => r.type === 'childList')).toHaveLength(0)
    observer.disconnect()
    const parent = folio('alpha').parentElement
    find('unrelated'); expect(folio('alpha').isConnected).toBe(true)
    find(''); expect(folio('alpha').parentElement).toBe(parent)
    expect(thumbnail.querySelector('iframe')).toBe(iframe)
    overview.el.scrollTop = 432
    const ribbon = overview.el.querySelector<HTMLElement>('.ws-overview-ribbon')!; ribbon.scrollLeft = 100
    overview.setVisible(false)
    overview.el.scrollTop = 0
    overview.setVisible(true)
    expect(overview.el.scrollTop).toBe(432); expect(ribbon.scrollLeft).toBe(100)
    expect(thumbnail.querySelector('iframe')).toBe(iframe)
    expect(overview.el.hidden).toBe(false); expect(overview.el.inert).toBe(false)
  })
})

describe('Overview thumbnail budget and safe content', () => {
  it('uses nearest-first <=4 loaders, <=16 live bodies, then evicts unseen bodies to make room', async () => {
    cards = Array.from({ length: 24 }, (_, i) => card({ id: `fiber${i}`, uid: `fiber${i}`, originId: 'host-a' }))
    feed.files = cards.map((c, i) => receipt(c.uid!, `/reports/${i}.html`, now() - i))
    await refresh()
    expect(Observer.current.options).toMatchObject({ root: overview.el, rootMargin: '300px' })
    const thumbs = [...Observer.current.targets]
    Object.defineProperty(overview.el, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 0, 1000, 800) })
    thumbs.forEach((el, i) => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect(i === 5 ? 342 : 10, i === 5 ? 412 : 10) }))
    Observer.current.deliver(thumbs); draw()
    expect(overview.el.querySelectorAll('iframe')).toHaveLength(4)
    expect(thumbs[5].querySelector('iframe')).not.toBeNull()
    for (let round = 0; round < 6; round++) {
      for (const iframe of overview.el.querySelectorAll('iframe')) iframe.dispatchEvent(new Event('load'))
      draw()
      expect(overview.el.querySelectorAll('iframe').length).toBeLessThanOrEqual(16)
    }
    expect(overview.el.querySelectorAll('iframe')).toHaveLength(16)
    const live = thumbs.filter(t => t.querySelector('iframe'))
    live.forEach(el => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect(-2000) }))
    Observer.current.deliver(live, false); draw()
    expect(overview.el.querySelectorAll('iframe').length).toBeLessThanOrEqual(16)
    expect(live.filter(t => t.querySelector('iframe')).length).toBeLessThan(16)
  })

  it('settles when the loading ring holds more thumbnails than the budget', async () => {
    cards = Array.from({ length: 30 }, (_, i) => card({ id: `fiber${i}`, uid: `fiber${i}`, originId: 'host-a' }))
    feed.files = cards.map((c, i) => receipt(c.uid!, `/reports/${i}.html`, now() - i))
    await refresh()
    const thumbs = [...Observer.current.targets]
    Object.defineProperty(overview.el, 'getBoundingClientRect', { configurable: true, value: () => rect(0, 0, 1000, 800) })
    // Inside the ring, below the visible sheet: near, never on screen.
    thumbs.forEach((el, i) => Object.defineProperty(el, 'getBoundingClientRect', { configurable: true, value: () => rect(820 + i, 10) }))
    Observer.current.deliver(thumbs); draw()
    const loadAll = (): void => { for (const iframe of overview.el.querySelectorAll('iframe')) iframe.dispatchEvent(new Event('load')); draw() }
    for (let round = 0; round < 8; round++) loadAll()
    const settled = [...overview.el.querySelectorAll('iframe')]
    expect(settled).toHaveLength(16)
    for (let round = 0; round < 8; round++) { Observer.current.deliver(thumbs); loadAll() }
    expect([...overview.el.querySelectorAll("iframe")].filter(f => !settled.includes(f)).length).toBe(0)
  })

  it('renders text as inert textContent, owner-routes images, and leaves unsupported files as faces', async () => {
    feed.files = [receipt('alpha', '/notes/a.txt'), receipt('beta', '/remote/image.png', now(), 'host-b'), receipt('beta', '/remote/archive.zip')]
    fetchMock.mockImplementation(async (url: string) => new Response(url.includes('/sent-files/') ? JSON.stringify(feed) : '<script>alert(1)</script><img src=x onerror=alert(1)>'))
    await refresh(); activate(); await settle(); draw()
    const pre = overview.el.querySelector('pre')!
    expect(pre.textContent).toContain('<script>alert(1)</script>')
    expect(pre.querySelector('script,img')).toBeNull()
    expect(pre.inert).toBe(true)
    const image = overview.el.querySelector('img')!
    expect(image.src).toContain('origin=host-b')
    expect(image.alt).toBe('')
    const opaque = [...overview.el.querySelectorAll('.ws-overview-rib')].find(el => el.textContent!.includes('archive.zip'))!
    expect(opaque.querySelector('iframe,img,pre')).toBeNull()
  })

  it('stops new loads while hidden and cancels pending thumbnail/feed work on disposal', async () => {
    feed.files = [receipt('alpha', '/a.txt')]; await refresh()
    overview.hide(); activate()
    expect(overview.el.querySelectorAll('iframe,pre,img')).toHaveLength(0)
    let signal: AbortSignal | undefined
    fetchMock.mockImplementation((_url: string, options: RequestInit) => { signal = options.signal as AbortSignal; return new Promise<Response>(() => {}) })
    overview.show(); draw()
    expect(signal?.aborted).toBe(false)
    overview.dispose()
    expect(signal?.aborted).toBe(true)
    expect(Observer.current.targets.size).toBe(0)
    expect(overview.el.isConnected).toBe(false)
    expect(frames.size).toBe(0)
  })
})

describe('Overview civil days and fleet shapes', () => {
  it('runs under both pinned non-UTC zones', () => { expectPinnedZone() })
  it('uses local midnight and calendar strides across DST, including the seven-day boundary', () => {
    const anchor = new Date(2026, 2, 30, 0, 10).getTime()
    expect(overviewDayGroup(new Date(2026, 2, 30, 0, 1).getTime(), anchor)).toBe('Today')
    expect(overviewDayGroup(new Date(2026, 2, 29, 23, 59).getTime(), anchor)).toBe('Yesterday')
    expect(overviewDayGroup(new Date(2026, 2, 24, 23, 59).getTime(), anchor)).toBe('This week')
    expect(overviewDayGroup(new Date(2026, 2, 23, 23, 59).getTime(), anchor)).toBe('Earlier')
    const fall = new Date(2026, 10, 2, 0, 10).getTime()
    expect(overviewDayGroup(new Date(2026, 10, 1, 0, 1).getTime(), fall)).toBe('Yesterday')
    expect(overviewDayGroup(NaN, anchor)).toBe('Earlier')
  })
  it('assigns the five marks by sorted fleet identity, independent of feed ordering', () => {
    expect([...overviewHostMarks(['e', 'c', 'a', 'b', 'd', 'a'])]).toEqual([
      ['a', '○'], ['b', '■'], ['c', '▲'], ['d', '◇'], ['e', '◐'],
    ])
  })
})
