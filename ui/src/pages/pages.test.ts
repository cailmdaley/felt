// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addThreadFixtures } from '../../harness/thread-fixtures.js'
import { WORKSPACE_HOST, WORKSPACE_UID, workspaceExample } from '../../harness/workspace-fixtures.js'
import { servedFeed, settle } from '../board/testFixtures.js'
import { PageFeed, POLL_MS, SENDS_POLL_MS } from './feed.js'
import { parsePageRoute, threadHref } from './route.js'
import { AUTO_ADVANCE_IDLE_MS, ThreadPage } from './ThreadPage.js'

describe('a page\'s address', () => {
  it('is its path\'s one segment when served, and the page parameter over file://', () => {
    expect(parsePageRoute({ protocol: 'http:', pathname: '/thread', search: '?f=01KV@umber&in=rex' }))
      .toStrictEqual({ page: 'thread', fiber: { uid: '01KV', host: 'umber' }, inRex: true })
    expect(parsePageRoute({ protocol: 'file:', pathname: '/x/harness-board-dist/index.html', search: '?example=threads&page=thread&f=01KV@umber' }))
      .toStrictEqual({ page: 'thread', fiber: { uid: '01KV', host: 'umber' }, inRex: false })
    // An `f` without both halves names no fiber.
    for (const f of ['01KV', '@umber', '01KV@', '']) expect(parsePageRoute({ protocol: 'http:', pathname: '/thread', search: `?f=${f}` }).fiber).toBeUndefined()
  })

  it('opens another fiber\'s thread page keeping the rest of the address', () => {
    expect(threadHref('http://127.0.0.1:4000/thread?f=a@h&in=rex', { uid: 'b', host: 'g' })).toBe('http://127.0.0.1:4000/thread?f=b%40g&in=rex')
    expect(threadHref('http://127.0.0.1:4000/desk', { uid: 'b', host: 'g' })).toBe('http://127.0.0.1:4000/thread?f=b%40g')
    expect(threadHref('file:///d/index.html?example=threads&page=thread&f=a@h', { uid: 'b', host: 'g' })).toBe('file:///d/index.html?example=threads&page=thread&f=b%40g')
  })
})

describe('the thread page', () => {
  const now = Date.now()
  let requests: Array<{ url: string; method: string; body?: string; headers: Headers }>
  let go: { went: boolean; place: string }
  let serveFiles: ((url: string, method: string, headers: Headers) => Response) | undefined
  let sentFiles: Array<{ fullPath: string; basename: string; timestamp: number; sessionId: string; uid: string; host: string; show?: boolean; caption?: string }>
  let feeds: PageFeed[]
  let pages: ThreadPage[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(now)
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() })
    const example = workspaceExample(now)
    addThreadFixtures(example, now)
    const composite = servedFeed(example.feed, now)
    requests = []
    sentFiles = []
    feeds = []
    serveFiles = undefined
    pages = []
    go = { went: true, place: 'live' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET', headers = new Headers(init.headers)
      requests.push({ url, method, body: init.body as string | undefined, headers })
      const json = (body: unknown, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } })
      if (url.startsWith('/api/v1/fibers/composite')) return headers.get('If-None-Match') === '"v1"' ? new Response(null, { status: 304 }) : json(composite, { ETag: '"v1"' })
      if (url.startsWith('/api/v1/board/family')) return json({ family: WORKSPACE_UID, records: [], waiting: {}, reach_ms: 14 * 86_400_000 })
      if (url.startsWith('/api/v1/sent-files/all/composite')) return json({ files: sentFiles, origins: {} })
      if (url.startsWith('/api/v1/file') && serveFiles) return serveFiles(url, method, headers)
      if (url === '/api/v1/go' && method === 'POST') return json(go)
      return new Response('{}', { status: 404 })
    }))
  })
  afterEach(() => {
    for (const page of pages) page.dispose()
    for (const feed of feeds) feed.stop()
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  async function open(search: string, navigate = vi.fn()): Promise<{ page: ThreadPage; feed: PageFeed; navigate: typeof navigate }> {
    const route = parsePageRoute({ protocol: 'http:', pathname: '/thread', search })
    const feed = new PageFeed('', route.fiber)
    feeds.push(feed)
    const page = new ThreadPage(feed, { base: '', route, navigate })
    pages.push(page)
    document.body.append(page.el)
    feed.start()
    for (let i = 0; i < 4; i++) await settle()
    return { page, feed, navigate }
  }
  const rows = (page: ThreadPage): string[] => [...page.el.querySelectorAll<HTMLElement>('.ov-thread')].map(row => row.dataset.fiber!)
  const row = (page: ThreadPage, fiber: string): HTMLElement => page.el.querySelector<HTMLElement>(`.ov-thread[data-fiber="${fiber}"]`)!
  const posts = () => requests.filter(each => each.method === 'POST')

  it('draws one constitution from the board\'s feed, lists no tempered or discarded thread, and touches neither voice nor Rex focus', async () => {
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('calibration-report')
    expect(rows(page)).toContain('thread-analysis')
    page.el.querySelector<HTMLButtonElement>('.ov-quiet')!.click()
    const all = rows(page)
    expect(all).toContain('thread-draft')
    expect(all).not.toContain('thread-archive')
    expect(all).not.toContain('thread-discard')
    // Its head shows its pages but no lifecycle verbs, and no edits, which only the board's reader bakes.
    expect([...page.el.querySelectorAll<HTMLElement>('.ov-tools [data-part]')].map(each => each.dataset.part)).not.toContain('edits')
    expect(page.el.querySelector('.ws-fiber-acts')).toBeNull()
    expect(requests.map(each => new URL(each.url, 'http://d').pathname).filter(path => /voice|attach|terminal/.test(path))).toStrictEqual([])
  })

  it('a tempered thread\'s own page still draws it', async () => {
    const { page } = await open(`?f=thread-archive@${WORKSPACE_HOST}`)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('archive')
  })

  it('in a Rex pane, a row asks the owner to go there and the page stays; a fiber with no worker is said to be not running, one Rex could not show is said so', async () => {
    const { page, navigate } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}&in=rex`)
    row(page, 'thread-analysis').click()
    await settle()
    expect(posts().map(each => [each.url, JSON.parse(each.body!)])).toStrictEqual([['/api/v1/go', { fiber_id: 'thread-analysis', origin: WORKSPACE_HOST }]])
    expect(page.el.querySelector<HTMLElement>('.pg-said')!.hidden).toBe(true)
    go = { went: false, place: 'none' }
    row(page, 'thread-review').click()
    await settle(); await settle()
    const said = page.el.querySelector<HTMLElement>('.pg-said')!
    expect([said.hidden, said.textContent]).toStrictEqual([false, 'review is not running.'])
    // A live worker Rex could not show is not said to be not running.
    go = { went: false, place: 'live' }
    row(page, 'thread-analysis').click()
    await settle(); await settle()
    expect([said.hidden, said.textContent]).toStrictEqual([false, 'Rex could not show analysis.'])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('in a browser, a row opens that fiber\'s page and moves no Rex', async () => {
    const { page, navigate } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    row(page, 'thread-analysis').click()
    expect(navigate).toHaveBeenCalledWith(`${window.location.origin}/thread?f=thread-analysis%40${WORKSPACE_HOST}`)
    expect(posts()).toStrictEqual([])
  })

  it('pulling a thread\'s page down past its top goes nowhere', async () => {
    const { page, navigate } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    page.el.querySelector('.ws-family-scroll')!.dispatchEvent(new WheelEvent('wheel', { deltaY: -400 }))
    expect(navigate).not.toHaveBeenCalled()
  })

  it('unfolds the tapestry at full height below the thread rows instead of a folded preview, and respects a manual fold', async () => {
    const html = '<!doctype html><p>Full tapestry</p>'
    serveFiles = url => {
      if (!url.includes('tapestry.html')) return new Response('{}', { status: 404 })
      if (url.startsWith('/api/v1/file-info')) return new Response(JSON.stringify({ exists: true, size: html.length, modified_at: Math.floor(now / 1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const unfold = page.el.querySelector<HTMLElement>('.ov-unfold')!
    expect(unfold.hasAttribute('data-unfolded')).toBe(true)
    expect(unfold.querySelector('.uf-card')).toBeNull()
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('Tapestry')
    expect(unfold.querySelector<HTMLElement>('.uf-page')!.dataset.kind).toBe('html')
    expect(unfold.querySelector('.kbn-fileview-frame')).not.toBeNull()
    // Folding manually stays folded across subsequent polls.
    unfold.querySelector<HTMLButtonElement>('.uf-fold')!.click()
    expect(unfold.hasAttribute('data-unfolded')).toBe(false)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.hasAttribute('data-unfolded')).toBe(false)
  })

  it('its constitution unfolds in place, beside its files, and folds when asked for again', async () => {
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    page.el.querySelector<HTMLButtonElement>('.ov-tools [data-part="constitution"]')!.click()
    for (let i = 0; i < 4; i++) await settle()
    const unfold = page.el.querySelector<HTMLElement>('.ov-unfold')!
    expect([unfold.hasAttribute('data-unfolded'), unfold.querySelector('.uf-name')!.textContent]).toStrictEqual([true, 'Constitution'])
    expect(unfold.querySelector<HTMLElement>('.uf-page')!.dataset.key).toMatch(/:\/fixture-store\/workspace\/.*\/calibration-report\.md$/)
    // Asked for again, it folds.
    page.el.querySelector<HTMLButtonElement>('.ov-tools [data-part="constitution"]')!.click()
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.hasAttribute('data-unfolded')).toBe(false)
  })

  it('reads the board again only while it is visible, revalidating what it holds', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const reads = () => requests.filter(each => each.url.startsWith('/api/v1/fibers/composite'))
    expect(reads().map(each => each.headers.get('If-None-Match'))).toStrictEqual([null])
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(reads().map(each => each.headers.get('If-None-Match'))).toStrictEqual([null, '"v1"'])
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(reads()).toHaveLength(2)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(reads()).toHaveLength(3)
  })

  it('polls sent-files every 10s while visible and pauses when hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const sendsReads = () => requests.filter(each => each.url.startsWith('/api/v1/sent-files/all/composite'))
    expect(sendsReads()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    expect(sendsReads()).toHaveLength(2)
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS * 3)
    expect(sendsReads()).toHaveLength(2)
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(sendsReads()).toHaveLength(3)
  })

  it('auto-advances to a newly shown file when idle without stealing focus, and never yanks a file already present on mount or while active', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const html = '<!doctype html><p>Tapestry</p>'
    serveFiles = url => {
      if (!url.includes('tapestry.html')) return new Response('{}', { status: 404 })
      if (url.startsWith('/api/v1/file-info')) return new Response(JSON.stringify({ exists: true, size: html.length, modified_at: Math.floor(now / 1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    sentFiles = [{ fullPath: '/tmp/initial.png', basename: 'initial.png', timestamp: now - 5_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: true }]
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const unfold = page.el.querySelector<HTMLElement>('.ov-unfold')!
    // Tapestry unfolds on mount; the pre-existing show:true file does not yank away from it.
    expect([unfold.hasAttribute('data-unfolded'), unfold.querySelector('.uf-name')!.textContent]).toStrictEqual([true, 'Tapestry'])

    // New show:true arrives while idle -> auto-advances to it without stealing focus.
    sentFiles = [
      ...sentFiles,
      { fullPath: '/tmp/fresh.png', basename: 'fresh.png', timestamp: now + 10_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: true },
    ]
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect([unfold.hasAttribute('data-unfolded'), unfold.querySelector('.uf-name')!.textContent]).toStrictEqual([true, 'fresh.png'])
    expect(document.activeElement).not.toBe(unfold.querySelector('.uf-page'))

    // User interacts (pointerdown): a newer show:true within 60s must NOT yank, and lights the unread dot.
    document.dispatchEvent(new Event('pointerdown'))
    sentFiles = [
      ...sentFiles,
      { fullPath: '/tmp/later.png', basename: 'later.png', timestamp: now + 20_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: true },
    ]
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('fresh.png')
    expect(page.el.querySelector('.ov-tools [data-part="sends"]')!.hasAttribute('data-unread')).toBe(true)
    expect(unfold.querySelector('.uf-count')!.hasAttribute('data-unread')).toBe(true)

    // After 60s of idleness, a brand-new show:true auto-advances again.
    await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_IDLE_MS)
    sentFiles = [
      ...sentFiles,
      { fullPath: '/tmp/after-idle.png', basename: 'after-idle.png', timestamp: Date.now() + 1_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: true },
    ]
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('after-idle.png')
  })

  it('does not auto-advance for a new sent file without show: true', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const html = '<!doctype html><p>Tapestry</p>'
    serveFiles = url => {
      if (!url.includes('tapestry.html')) return new Response('{}', { status: 404 })
      if (url.startsWith('/api/v1/file-info')) return new Response(JSON.stringify({ exists: true, size: html.length, modified_at: Math.floor(now / 1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const unfold = page.el.querySelector<HTMLElement>('.ov-unfold')!
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('Tapestry')
    sentFiles = [{ fullPath: '/tmp/quiet.png', basename: 'quiet.png', timestamp: now + 10_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: false }]
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('Tapestry')
  })

  it('does not schedule further polls after stop()', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { feed } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const before = requests.length
    feed.stop()
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(requests.length).toBe(before)
  })
})
