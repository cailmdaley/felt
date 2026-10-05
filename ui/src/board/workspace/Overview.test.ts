// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card, expectPinnedZone, ownerFiberResponse } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { docKey } from './documents.js'
import { cacheDocumentTitle } from './DocumentTitles.js'
import { Overview, overviewDayGroup, overviewHostMarks } from './Overview.js'
import type { ChannelThemes } from './ChannelThemes.js'

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
const receiptOrigins = (remoteAt = now(), stale = false): Record<string, unknown> => ({
  'host-a': { kind: 'local', stale: false, last_polled_at: null },
  'host-b': { kind: 'remote', stale, last_polled_at: new Date(remoteAt).toISOString() },
})
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
  feed = { files: [], origins: receiptOrigins() }
  fetchMock = vi.fn(async (url: string) => url.includes('/sent-files/all/composite')
    ? new Response(JSON.stringify(feed), { status: 200 })
    : url.includes('/api/v1/file?') && /\.html/.test(decodeURIComponent(url)) ? new Response('<p>Preview text</p>') : new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  onOpen = vi.fn(); onOrder = vi.fn()
  overview = new Overview({ shuttleBase: 'http://daemon', cards: () => cards, onOpen, onOrder })
  document.body.append(overview.el)
})
afterEach(() => { overview?.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('Overview receipt membership and identity', () => {
  it('binds retained news and folio roots by channel, releasing them on hide, removal and disposal', async () => {
    overview.dispose()
    const bound = new Map<HTMLElement, KanbanCard>()
    const themes = { bind: vi.fn((el: HTMLElement, card: KanbanCard) => bound.set(el, card)),
      unbind: vi.fn((el: HTMLElement) => bound.delete(el)) } as unknown as ChannelThemes
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen, themes })
    document.body.append(overview.el)
    feed.files = [receipt('alpha', '/report.html')]
    await refresh()
    const news = overview.el.querySelector<HTMLElement>('[data-part="since-row"]')!
    const face = folio('alpha')
    expect(bound.get(news)).toBe(cards[0]); expect(bound.get(face)).toBe(cards[0])
    expect(news.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect(face.hasAttribute('data-ws-theme-boundary')).toBe(true)
    expect(face.dataset.density).toBe('full')
    cards = [{ ...cards[0], outcome: 'Revised outcome' }]
    overview.cardsChanged()
    expect(overview.el.querySelector('[data-part="since-row"]')).toBe(news)
    expect(bound.get(news)).toBe(cards[0])
    overview.hide(); expect(bound.size).toBe(0)
    overview.show(); expect(bound.get(news)).toBe(cards[0]); expect(bound.get(face)).toBe(cards[0])
    overview.opened(cards[0])
    expect(news.isConnected).toBe(false); expect(bound.has(news)).toBe(false)
    overview.dispose(); expect(bound.size).toBe(0)
  })

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

  it('marks only receipts newer than the last time the sheet was left', async () => {
    overview.dispose()
    localStorage.setItem('shuttle.workspace.overview.seen', JSON.stringify(now() - 30000))
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el)
    feed.files = [receipt('alpha', '/old.html', now() - 60000)]
    await refresh()
    expect(folio('alpha').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(true)
    feed.files.push(receipt('alpha', '/new.html', now() + 1000)); await refresh()
    expect(folio('alpha').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(false)
    vi.setSystemTime(now() + 5000); overview.hide()
    overview.dispose()
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el); await refresh()
    expect(folio('alpha').querySelector<HTMLElement>('.ws-overview-fresh')!.hidden).toBe(true)
  })

  it('increments from a safe per-origin watermark, merges identities, and keeps the overlap on failures', async () => {
    const started = now()
    const remoteAt = started - 5 * 60_000
    const kept = receipt('alpha', '/report.html', started - 1000, 'host-b', { sessionId: 'session-a' })
    feed.origins = receiptOrigins(remoteAt, true)
    feed.files = [kept]
    await refresh()
    expect(fetchMock.mock.calls[0][0]).toBe(`http://daemon/api/v1/sent-files/all/composite?since_ms=${started - 30 * 86400000}`)

    vi.setSystemTime(started + 5000)
    feed.files = [kept,
      receipt('alpha', '/report.html', started + 4000, 'host-b', { sessionId: 'session-b' }),
      receipt('alpha', '/report.html', started + 4000, 'host-a', { sessionId: 'session-b' })]
    await refresh()
    const incremental = new URL(fetchMock.mock.calls[1][0])
    expect(incremental.searchParams.get('since_ms')).toBe(String(remoteAt - 60_000))
    const retained = (overview as unknown as { files: Array<{ uid?: string; host?: string; fullPath: string; timestamp: number; sessionId?: string }> }).files
    expect(retained.map(({ host, uid, fullPath, timestamp, sessionId }) => [host, uid, fullPath, timestamp, sessionId])).toEqual([
      ['host-b', 'alpha', '/report.html', started - 1000, 'session-a'],
      ['host-b', 'alpha', '/report.html', started + 4000, 'session-b'],
      ['host-a', 'alpha', '/report.html', started + 4000, 'session-b'],
    ])

    vi.setSystemTime(started + 6000)
    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }))
    overview.refresh(); await settle()
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('since_ms')).toBe(String(remoteAt - 60_000))
    expect((overview as unknown as { files: unknown[] }).files).toHaveLength(3)

    feed.origins = receiptOrigins(started + 7000, false)
    feed.files = [...feed.files, receipt('alpha', '/recovered.html', started + 8000, 'host-b', { sessionId: 'session-c' })]
    await refresh()
    expect(new URL(fetchMock.mock.calls[3][0]).searchParams.get('since_ms')).toBe(String(remoteAt - 60_000))
    expect((overview as unknown as { files: unknown[] }).files).toHaveLength(4)

    vi.setSystemTime(started + 31 * 86400000)
    feed.origins = receiptOrigins(now(), false)
    feed.files = [receipt('alpha', '/fresh.html', now(), 'host-a')]
    await refresh()
    expect(new URL(fetchMock.mock.calls[4][0]).searchParams.get('since_ms')).toBe(String(now() - 30 * 86400000))
    expect((overview as unknown as { files: Array<{ fullPath: string }> }).files.map(file => file.fullPath)).toEqual(['/fresh.html'])
  })

  it('backfills the rolling window when a new origin joins after the cursor advanced', async () => {
    const started = now()
    const local = { 'host-a': { kind: 'local', stale: false, last_polled_at: null } }
    const grown = { ...local, 'host-c': { kind: 'remote', stale: true, last_polled_at: new Date(started - 3 * 86400000).toISOString() } }
    const historical = receipt('alpha', '/new-host/history.html', started - 2 * 86400000, 'host-c')
    let reads = 0
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.includes('/sent-files/all/composite')) return new Response('', { status: 404 })
      reads++
      const body = reads === 1 ? { files: [], origins: local }
        : reads === 2 ? { files: [], origins: grown }
          : { files: [historical], origins: grown }
      return new Response(JSON.stringify(body))
    })
    await refresh()
    vi.setSystemTime(started + 10_000)
    await refresh()

    expect(reads).toBe(3)
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get('since_ms')).toBe(String(started - 60_000))
    expect(new URL(fetchMock.mock.calls[2][0]).searchParams.get('since_ms')).toBe(String(now() - 30 * 86400000))
    expect((overview as unknown as { files: Array<{ fullPath: string }> }).files.map(file => file.fullPath)).toEqual(['/new-host/history.html'])
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
    expect(overview.orderedCards()).toEqual([cards[1]]) // An empty incremental page does not erase receipts.
    overview.dispose()
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el); await refresh()
    expect(overview.orderedCards()).toEqual([]) // Session membership is not persisted.
  })

  it('resolves an unknown fiber from a complete owner response and preserves the receipt byte owner', async () => {
    feed.files = [receipt('missing', '/remote/report.html', now(), 'bytes-host')]
    fetchMock.mockImplementation(async (url: string) => url.includes('/sent-files/')
      ? new Response(JSON.stringify(feed))
      : new Response(JSON.stringify(ownerFiberResponse({
        id: 'missing', uid: 'missing', owner: 'bytes-host', name: 'Resolved measurement', body: 'The owner serves this note.',
      }))))
    await refresh()
    expect(name('missing')).toBe('Resolved measurement')
    overview.el.querySelector<HTMLButtonElement>('.ws-overview-rib')!.click()
    await settle()
    expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/v1/fibers/missing?body=true&origin=bytes-host'))).toBe(true)
    expect(onOpen).toHaveBeenCalledOnce()
    const [opened, key] = onOpen.mock.calls[0]
    expect(opened.name).toBe('Resolved measurement')
    expect(opened.originId).toBe('bytes-host')
    expect(key).toBe('bytes-host:/remote/report.html')
  })

  it('groups a confirmed missing receipt as Unfiled on its byte-owning host', async () => {
    feed.files = [receipt('missing', '/remote/report.html', now(), 'bytes-host')]
    await refresh()
    expect(name('other:bytes-host')).toBe('Unfiled · bytes-host')
    expect(overview.orderedCards().map(c => c.uid)).toEqual(['other:bytes-host'])
    overview.el.querySelector<HTMLButtonElement>('.ws-overview-rib')!.click(); await settle()
    expect(onOpen.mock.calls[0][0]).toMatchObject({ uid: 'other:bytes-host', originId: 'bytes-host', name: 'Unfiled · bytes-host' })
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

  it('names and groups a folio placed before the board metadata arrived', async () => {
    const known = cards
    cards = []
    feed.files = [receipt('alpha', '/result.html')]
    fetchMock.mockImplementation(async (url: string) => url.includes('/sent-files/')
      ? new Response(JSON.stringify(feed)) : new Response('', { status: 503 }))
    await refresh()
    expect(name('alpha')).toBe('Resolving fiber · host-a')
    cards = known; overview.cardsChanged()
    expect(name('alpha')).toContain('Alpha result')
    lens('projects'); expect(groups()).toEqual(['science / shear'])
    cards = [{ ...known[0], path: '.felt/research/new/alpha/alpha.md' }]; overview.cardsChanged()
    expect(groups()).toEqual(['science / shear'])
  })

  it('preserves mounted report-lead thumbnails through polls, Find, and hide/show, including sheet/ribbon scroll', async () => {
    feed.files = [receipt('alpha', '/notes/alpha/report.html', now() - 1000), receipt('alpha', '/notes/alpha/newest.html')]
    await refresh(); activate(); await settle()
    const thumbnail = folio('alpha').querySelector('.ws-overview-thumb')!
    const iframe = thumbnail.querySelector('iframe')!
    expect(iframe.src).toContain('/api/v1/file-assets/host-a/notes/alpha/report.html')
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
      await settle()
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
    const loadAll = async (): Promise<void> => { await settle(); for (const iframe of overview.el.querySelectorAll('iframe')) iframe.dispatchEvent(new Event('load')); draw() }
    for (let round = 0; round < 8; round++) await loadAll()
    const settled = [...overview.el.querySelectorAll('iframe')]
    expect(settled).toHaveLength(16)
    for (let round = 0; round < 8; round++) { Observer.current.deliver(thumbs); await loadAll() }
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

describe('Overview news, visits and graduated density', () => {
  const visitKey = 'shuttle.workspace.overview.seen'
  const reset = (at?: number): void => {
    overview.dispose()
    if (at !== undefined) localStorage.setItem(visitKey, JSON.stringify(at))
    overview = new Overview({ shuttleBase: 'http://daemon', cards: () => cards, onOpen, onOrder })
    document.body.append(overview.el)
  }
  it('leads a first visit with thirty-day news without writing a visit on load', async () => {
    cards[0] = { ...cards[0], status: 'closed', closedAt: new Date(now() - 60000).toISOString() }
    feed.files = [receipt('alpha', '/one.html', now() - 5000), receipt('alpha', '/two.mp3', now() - 4000)]
    await refresh()
    expect(overview.el.querySelector('.ws-overview-summary')?.textContent).toBe('The last 30 days: 2 documents in 1 constitution; 1 await your review.')
    expect(localStorage.getItem(visitKey)).toBeNull()
    expect(overview.el.querySelectorAll('.ws-overview-change')).toHaveLength(1)
    expect(overview.el.querySelector('.ws-overview-change-summary')?.textContent).toContain('→ awaiting review')
    expect(folio('alpha').classList.contains('ws-overview-unseen')).toBe(true)
    expect(overview.el.querySelector<HTMLDetailsElement>('.ws-overview-latest')?.open).toBe(false)
  })
  it('preserves a visit through an early reload, advances after thirty seconds or on internal departure', async () => {
    const previous = now() - 3 * 3600000
    reset(previous); await refresh()
    expect(localStorage.getItem(visitKey)).toBe(JSON.stringify(previous))
    vi.advanceTimersByTime(30000)
    expect(localStorage.getItem(visitKey)).toBe(JSON.stringify(previous))
    reset(); await refresh()
    expect(localStorage.getItem(visitKey)).toBe(JSON.stringify(previous))
    vi.advanceTimersByTime(30001)
    expect(localStorage.getItem(visitKey)).toBe(JSON.stringify(now()))
    vi.advanceTimersByTime(1000); overview.hide()
    expect(localStorage.getItem(visitKey)).toBe(JSON.stringify(now()))
  })
  it('does not record an overview visit when it never mounted', () => {
    reset(); overview.el.remove(); overview.hide()
    expect(localStorage.getItem(visitKey)).toBeNull()
  })
  it('compares outcome text and review transitions, including fibers with no documents', async () => {
    reset(now() - 3600000); await refresh()
    cards[0] = { ...cards[0], modifiedAt: new Date().toISOString() }
    overview.cardsChanged()
    expect(overview.el.querySelectorAll('.ws-overview-change')).toHaveLength(0)
    cards[0] = { ...cards[0], outcome: 'A different checked measurement.' }
    cards[1] = { ...cards[1], status: 'closed' }
    overview.cardsChanged()
    const rows = [...overview.el.querySelectorAll<HTMLElement>('.ws-overview-change')]
    expect(rows.map(r => r.dataset.uid)).toEqual(['beta', 'alpha'])
    expect(rows[0].textContent).toContain('→ awaiting review')
    expect(rows[1].textContent).toContain('outcome changed')
    expect(overview.el.querySelectorAll('.ws-overview-folio')).toHaveLength(0)
    overview.opened(cards[0])
    expect(overview.el.querySelector('.ws-overview-change[data-uid="alpha"]')).toBeNull()
    expect(JSON.parse(localStorage.getItem('shuttle.workspace.overview.visits')!).alpha).toBe(now())
    reset(); await refresh()
    expect(overview.el.querySelector('.ws-overview-change[data-uid="alpha"]')).toBeNull()
    expect(overview.el.querySelector('.ws-overview-change[data-uid="beta"]')).not.toBeNull()
  })
  it('puts awaiting review ahead of Needs-you ahead of newest work, and bounds new-document previews', async () => {
    reset(now() - 3600000)
    cards.push(card({ id: 'gamma', uid: 'gamma', originId: 'host-a', status: 'active', shuttleKind: 'oneshot' }))
    cards[0] = { ...cards[0], status: 'closed' }
    cards[1] = { ...cards[1], status: 'active', shuttleKind: 'oneshot', runtimePhase: 'waiting' }
    feed.files = [receipt('gamma', '/working.html', now()), receipt('beta', '/needs.html', now() - 1000),
      ...Array.from({ length: 6 }, (_, i) => receipt('alpha', `/report-${i}.html`, now() - 2000 - i, 'host-a', { sessionId: 'one-batch' }))]
    await refresh()
    const rows = [...overview.el.querySelectorAll<HTMLElement>('.ws-overview-change')]
    expect(rows.map(r => r.dataset.uid)).toEqual(['alpha', 'beta', 'gamma'])
    expect(rows[0].querySelectorAll('.ws-overview-change-doc')).toHaveLength(4)
    expect(rows[0].querySelector('.ws-overview-change-more')?.textContent).toBe('+2')
    rows[0].querySelector<HTMLButtonElement>('.ws-overview-change-open')!.click(); await settle()
    expect(onOpen).toHaveBeenLastCalledWith(cards[0], 'host-a:/report-0.html')
    expect(overview.el.querySelector('.ws-overview-change[data-uid="alpha"]')).toBeNull()
    expect(folio('alpha').classList.contains('ws-overview-seen')).toBe(true)
  })
  it('counts the Desk review surface, excluding resting, cycles and folded cards', async () => {
    cards = [card({ id: 'a', status: 'closed' }), card({ id: 'b', status: 'closed', tempered: true }),
      card({ id: 'c', status: 'closed', effectiveHorizon: 'stashed' }), card({ id: 'd', status: 'closed', foldedUnder: 'a' }),
      card({ id: 'e', status: 'closed', tags: ['cycle'], isCycle: true })]
    await refresh()
    expect(overview.el.querySelector('.ws-overview-summary')?.textContent).toMatch(/; 1 await your review\.$/)
  })
  it('finds declared titles without body reads and starts keyboard order at the change band', async () => {
    reset(now() - 3600000)
    feed.files = [receipt('alpha', '/unique-title-report.html'), receipt('beta', '/old.html', now() - 2 * 3600000)]
    await refresh()
    cacheDocumentTitle('host-a:/unique-title-report.html', '/unique-title-report.html', '<title>The measured universe</title>')
    find('measured universe')
    expect(folio('alpha').hidden).toBe(false)
    expect(folio('beta').hidden).toBe(true)
    find('')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', bubbles: true }))
    expect(overview.el.querySelector('.ws-key-selected')?.classList.contains('ws-overview-change-open')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle()
    expect(onOpen).toHaveBeenLastCalledWith(cards[0], 'host-a:/unique-title-report.html')
  })
  it('assigns full, compact and line densities with a temporal boundary', async () => {
    reset(now() - 3 * 3600000)
    cards = ['today', 'yesterday', 'week', 'earlier'].map(uid => card({ id: uid, uid }))
    feed.files = cards.map((c, i) => receipt(c.uid!, `/${c.uid}.html`, now() - [0, 86400000, 3 * 86400000, 10 * 86400000][i]))
    await refresh()
    expect(cards.map(c => folio(c.uid!).dataset.density)).toEqual(['full', 'full', 'compact', 'line'])
    expect(overview.el.querySelector('.ws-overview-boundary')?.textContent).toBe('— you were here 3 h ago —')
    lens('projects')
    expect(cards.every(c => folio(c.uid!).dataset.density === 'compact')).toBe(true)
    expect(overview.el.querySelector('.ws-overview-boundary')).toBeNull()
  })
  it('survives storage denial for reads and writes', async () => {
    overview.dispose()
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen })
    document.body.append(overview.el)
    feed.files = [receipt('alpha', '/report.html')]
    await refresh()
    overview.opened(cards[0]); overview.hide(); overview.show(); lens('hosts')
    expect(folio('alpha').isConnected).toBe(true)
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
