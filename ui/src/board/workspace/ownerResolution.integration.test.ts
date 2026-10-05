// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { Dock } from './Dock.js'
import { Overview } from './Overview.js'
import { Workspace } from './Workspace.js'
import { readFiber } from './fiberSource.js'

const settle = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve() }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const envelope = (uid: string, host = 'owner', extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  host,
  fibers: [{ felt_store: '/notes/.felt', path: `work/${uid}/${uid}.md`, dir: `/notes/.felt/work/${uid}`,
    fiber: { id: `work/${uid}`, uid, name: `Resolved ${uid}`, body: 'An authoritative body.', outcome: 'Checked.' }, ...extra }],
})
const receipt = (uid: string, host = 'owner'): Record<string, unknown> => ({ uid, host, fullPath: `/files/${uid}.html`, timestamp: Date.now() })
let cards: KanbanCard[]
let files: Record<string, unknown>[]
let overview: Overview | undefined
let workspace: Workspace | undefined
let reads: ReturnType<typeof vi.fn<(url: string) => Promise<Response>>>
let opens: ReturnType<typeof vi.fn<(card: KanbanCard, doc?: string) => void>>
const fiberReads = (): string[] => reads.mock.calls.map(([url]) => url).filter(url => url.includes('/api/v1/fibers/'))
const folio = (uid: string): HTMLButtonElement | null => overview!.el.querySelector(`.ws-overview-folio[data-uid="${uid}"]`)
function sheet(): Overview {
  overview = new Overview({ shuttleBase: '', cards: () => cards, onOpen: opens })
  document.body.append(overview.el)
  return overview
}
function reader(hash = '#/board'): Workspace {
  window.history.replaceState(null, '', hash)
  workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Board', onVisibility: vi.fn(), dock: new Dock('', vi.fn()) })
  overview = workspace.overview
  return workspace
}
function link(id: string, owner: string): Promise<void> {
  // Exercise the wikilink resolver without coupling the test to markdown layout.
  return (workspace as unknown as { openFiber(id: string, owner: string): Promise<void> }).openFiber(id, owner)
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-07-15T12:00:00Z'))
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('IntersectionObserver', undefined)
  vi.stubGlobal('ResizeObserver', undefined)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), clear: () => storage.clear() })
  sessionStorage.clear(); document.body.replaceChildren()
  window.history.replaceState(null, '', '#/board')
  cards = []; files = []; opens = vi.fn()
  reads = vi.fn(async url => url.includes('/sent-files/all/') ? json({ files }) : json({}))
  vi.stubGlobal('fetch', reads)
})
afterEach(() => {
  workspace?.dispose()
  if (!workspace) overview?.dispose()
  workspace = undefined; overview = undefined
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('fiber source selection', () => {
  it('pins body reads, suppressing local self-routing and ignoring the hub envelope', async () => {
    reads.mockResolvedValue(json({ ...envelope('alpha', 'hub'), origins: { hub: {}, owner: {} } }))
    const entry = await readFiber('', 'alpha', 'owner')
    expect(entry.origin).toBe('owner')
    expect(fiberReads()).toEqual(['/api/v1/fibers/alpha?body=true&origin=owner&routed=1'])
  })
  it('discovers the serving host through a verbatim single-document relay', async () => {
    reads.mockResolvedValue(json(envelope('alpha', 'actual-owner')))
    expect((await readFiber('', 'alpha', 'starting-host', undefined, 'discover')).origin).toBe('actual-owner')
    expect(fiberReads()[0]).not.toContain('routed=1')
  })
  it('prefers an explicit row source to the composite hub', async () => {
    reads.mockResolvedValue(json({ ...envelope('alpha', 'hub', { origin: 'actual-owner' }), origins: { hub: {} } }))
    expect((await readFiber('', 'alpha', 'starting-host', undefined, 'discover')).origin).toBe('actual-owner')
  })
  it('never infers a source from an unstamped composite hub or a shuttle.host declaration', async () => {
    reads.mockResolvedValue(json({ ...envelope('alpha', 'hub', { fiber: { id: 'alpha', shuttle: { host: 'unverified-host' } } }), origins: { hub: {} } }))
    expect((await readFiber('', 'alpha', 'starting-host', undefined, 'discover')).origin).toBe('starting-host')
  })
  it('does not turn a malformed successful response into a confirmed miss', async () => {
    reads.mockResolvedValueOnce(json({ fibers: [{ fiber: { body: 'Incomplete metadata' } }] }))
    await expect(readFiber('', 'alpha', 'owner')).rejects.toThrow('owner is unreachable')
  })
  it.each([404, 200])('distinguishes confirmed missing (%s) from an unreachable source', async status => {
    reads.mockResolvedValueOnce(json({ fibers: [] }, status))
    await expect(readFiber('', 'alpha', 'owner')).rejects.toThrow('Fiber not found on owner')
    reads.mockResolvedValueOnce(json({}, 503))
    await expect(readFiber('', 'alpha', 'owner')).rejects.toThrow('owner is unreachable')
  })
})

describe('Overview metadata recovery and navigation', () => {
  it('backs off a 503, then a fresh refresh recovers without waiting for the timer', async () => {
    files = [receipt('alpha')]
    let healthy = false
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : healthy ? json(envelope('alpha')) : json({}, 503))
    sheet().refresh(); await settle()
    expect(fiberReads()).toHaveLength(1)
    for (let i = 0; i < 10; i++) overview!.cardsChanged()
    await settle()
    expect(fiberReads()).toHaveLength(1)
    expect(folio('alpha')?.textContent).toContain('Resolving fiber')
    expect(folio('other:owner')).toBeNull()
    healthy = true; overview!.refresh(); await settle()
    expect(fiberReads()).toHaveLength(2)
    expect(folio('alpha')?.textContent).toContain('Resolved alpha')
  })
  it('retries automatically with bounded exponential backoff rather than a failure loop', async () => {
    files = [receipt('alpha')]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json({}, 503))
    sheet().refresh(); await settle()
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const before = fiberReads().length
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(fiberReads()).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(fiberReads()).toHaveLength(before + 1)
    }
  })
  it('stops retry scheduling when the failed receipt leaves the sheet', async () => {
    files = [receipt('alpha')]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json({}, 503))
    sheet().refresh(); await settle()
    files = []; overview!.refresh(); await settle()
    const before = fiberReads().length
    await vi.advanceTimersByTimeAsync(60000)
    expect(fiberReads()).toHaveLength(before)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejoins confirmed-missing receipts when authoritative live metadata arrives', async () => {
    files = [receipt('alpha')]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json({ fibers: [] }))
    sheet().refresh(); await settle()
    expect(folio('alpha')).toBeNull()
    expect(folio('other:owner')?.textContent).toContain('Unfiled')
    cards = [card({ id: 'work/alpha', uid: 'alpha', name: 'Live alpha', originId: 'owner' })]
    overview!.cardsChanged(); await settle()
    expect(folio('other:owner')).toBeNull()
    expect(folio('alpha')?.textContent).toContain('Live alpha')
    expect(fiberReads()).toHaveLength(1)
  })
  it('fresh refresh retries even a confirmed miss whose folio has moved to Unfiled', async () => {
    files = [receipt('alpha')]
    let healthy = false
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : healthy ? json(envelope('alpha')) : json({ fibers: [] }))
    sheet().refresh(); await settle()
    expect(folio('other:owner')).not.toBeNull()
    healthy = true; overview!.refresh(); await settle()
    expect(folio('other:owner')).toBeNull()
    expect(folio('alpha')?.textContent).toContain('Resolved alpha')
    expect(fiberReads()).toHaveLength(2)
  })
  it('does not let a late missing response replace newer authoritative metadata', async () => {
    files = [receipt('alpha')]
    const pending = deferred<Response>()
    reads.mockImplementation(url => url.includes('/sent-files/all/') ? Promise.resolve(json({ files })) : pending.promise)
    sheet().refresh(); await settle()
    cards = [card({ id: 'alpha', uid: 'alpha', name: 'Live alpha', originId: 'owner' })]
    overview!.cardsChanged()
    pending.resolve(json({ fibers: [] })); await settle()
    expect(folio('alpha')?.textContent).toContain('Live alpha')
    expect(folio('other:owner')).toBeNull()
  })
  it('only opens the latest selection when A completes after B', async () => {
    files = [receipt('alpha'), receipt('beta')]
    const a = deferred<Response>(), b = deferred<Response>()
    reads.mockImplementation(url => url.includes('/sent-files/all/') ? Promise.resolve(json({ files })) : url.includes('/alpha?') ? a.promise : b.promise)
    sheet().refresh(); await settle()
    folio('alpha')!.click(); folio('beta')!.click()
    b.resolve(json(envelope('beta'))); await settle()
    expect(opens.mock.calls.map(([c]) => c.uid)).toEqual(['beta'])
    a.resolve(json(envelope('alpha'))); await settle()
    expect(opens.mock.calls.map(([c]) => c.uid)).toEqual(['beta'])
    expect(fiberReads()).toHaveLength(2)
  })
  it('prioritizes queued clicks over preloads within four reads and suppresses a superseded click', async () => {
    files = Array.from({ length: 7 }, (_, i) => receipt(`uid${i}`))
    const pending = new Map<string, ReturnType<typeof deferred<Response>>>()
    let active = 0, peak = 0
    reads.mockImplementation(url => {
      if (url.includes('/sent-files/all/')) return Promise.resolve(json({ files }))
      const uid = /\/fibers\/(uid\d)/.exec(url)![1]
      const item = deferred<Response>(); pending.set(uid, item)
      peak = Math.max(peak, ++active)
      return item.promise.finally(() => { active-- })
    })
    sheet().refresh(); await settle()
    expect([...pending.keys()]).toEqual(['uid0', 'uid1', 'uid2', 'uid3'])
    folio('uid5')!.click(); folio('uid6')!.click(); folio('uid6')!.click()
    expect(fiberReads()).toHaveLength(4)
    pending.get('uid0')!.resolve(json(envelope('uid0'))); await settle()
    expect([...pending.keys()]).toEqual(['uid0', 'uid1', 'uid2', 'uid3', 'uid6'])
    pending.get('uid6')!.resolve(json(envelope('uid6'))); await settle()
    expect(opens.mock.calls.map(([c]) => c.uid)).toEqual(['uid6'])
    expect(pending.has('uid5')).toBe(true)
    pending.get('uid5')!.resolve(json(envelope('uid5'))); await settle()
    expect(opens.mock.calls.map(([c]) => c.uid)).toEqual(['uid6'])
    for (const uid of ['uid1', 'uid2', 'uid3', 'uid4']) pending.get(uid)!.resolve(json(envelope(uid)))
    await settle()
    expect(peak).toBe(4)
    expect(active).toBe(0)
    expect(fiberReads()).toHaveLength(7)
    expect(new Set(fiberReads()).size).toBe(7)
  })
  it('keeps an unreachable clicked placeholder provisional and retryable', async () => {
    files = [receipt('alpha')]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json({}, 503))
    sheet().refresh(); await settle()
    folio('alpha')!.click(); await settle()
    expect(opens).toHaveBeenCalledTimes(1)
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json(envelope('alpha')))
    overview!.refresh(); await settle()
    expect(folio('alpha')?.textContent).toContain('Resolved alpha')
  })
  it('invalidates deferred navigation when the sheet is left', async () => {
    files = [receipt('alpha')]
    const pending = deferred<Response>()
    reads.mockImplementation(url => url.includes('/sent-files/all/') ? Promise.resolve(json({ files })) : pending.promise)
    sheet().refresh(); await settle(); folio('alpha')!.click(); overview!.hide()
    pending.resolve(json(envelope('alpha'))); await settle()
    expect(opens).not.toHaveBeenCalled()
  })
})

describe('Workspace owner integration', () => {
  it('never accepts another host\'s matching slug instead of reading the requested host', async () => {
    cards = [card({ id: 'work/shared', uid: 'wrong-uid', name: 'Wrong host', originId: 'elsewhere' })]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json(envelope('right-uid', 'owner')))
    reader(); await link('work/shared', 'owner'); await settle()
    expect(fiberReads()[0]).toBe('/api/v1/fibers/work/shared?body=true&origin=owner')
    expect(window.location.hash).toContain('right-uid@owner')
    expect(overview!.orderedCards().some(c => c.name === 'Wrong host')).toBe(false)
  })
  it('allows cross-host lookup by intrinsic uid, not by a slug-shaped id fallback', async () => {
    cards = [card({ id: 'work/shared', uid: 'intrinsic-uid', originId: 'elsewhere' })]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json(envelope('intrinsic-uid', 'elsewhere')))
    reader(); await link('intrinsic-uid', 'owner'); await settle()
    expect(window.location.hash).toContain('intrinsic-uid@elsewhere')
    expect(fiberReads().every(url => url.includes('origin=elsewhere&routed=1'))).toBe(true)
  })
  it('prefers a same-host slug over a different-host row', async () => {
    cards = [card({ id: 'work/shared', uid: 'other-uid', originId: 'elsewhere' }), card({ id: 'work/shared', uid: 'right-uid', originId: 'owner' })]
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json(envelope('right-uid')))
    reader(); await link('work/shared', 'owner'); await settle()
    expect(window.location.hash).toContain('right-uid@owner')
    expect(fiberReads()[0]).toContain('origin=owner&routed=1')
  })
  it('opens a discovered redirected fiber on its actual serving host', async () => {
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : json(envelope('alpha', 'actual-owner')))
    reader(); await link('work/alpha', 'starting-host'); await settle()
    expect(window.location.hash).toContain('alpha@actual-owner')
    expect(fiberReads()[0]).toContain('origin=starting-host')
    expect(fiberReads()[1]).toContain('origin=actual-owner&routed=1')
    expect(overview!.orderedCards()[0].originId).toBe('actual-owner')
  })
  it('does not promote an unreachable Overview selection to known Workspace metadata', async () => {
    files = [receipt('alpha')]
    let healthy = false
    reads.mockImplementation(async url => url.includes('/sent-files/all/') ? json({ files }) : healthy ? json(envelope('alpha')) : json({}, 503))
    reader(); overview!.refresh(); await settle()
    overview!.el.querySelector<HTMLButtonElement>('.ws-overview-folio')!.click(); await settle()
    expect(workspace!.isActive).toBe(true)
    expect(overview!.hasMetadata(overview!.orderedCards()[0])).toBe(false)
    healthy = true; overview!.refresh(); await settle()
    expect(overview!.orderedCards()[0].name).toBe('Resolved alpha')
  })
  it('publishes cold-route body metadata to the sidebar without another visit or duplicate preload', async () => {
    files = [receipt('alpha')]
    const pending = deferred<Response>()
    reads.mockImplementation(url => url.includes('/sent-files/all/') ? Promise.resolve(json({ files })) : pending.promise)
    reader('#/board/alpha@owner'); await settle()
    expect(fiberReads()).toHaveLength(1)
    expect(overview!.orderedCards()[0].name).toBe('alpha')
    document.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!.click()
    expect(document.querySelector('.ws-sidebar')?.textContent).toContain('alpha')
    const visits = localStorage.getItem('shuttle.workspace.overview.visits')
    vi.setSystemTime(Date.now() + 500)
    pending.resolve(json(envelope('alpha', 'hub'))); await settle()
    expect(overview!.orderedCards()[0].name).toBe('Resolved alpha')
    expect(overview!.orderedCards()[0].originId).toBe('owner')
    expect(document.querySelector('.ws-sidebar')?.textContent).toContain('Resolved alpha')
    expect(localStorage.getItem('shuttle.workspace.overview.visits')).toBe(visits)
    expect(fiberReads()).toHaveLength(1)
  })
})
