// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addThreadFixtures } from '../../harness/thread-fixtures.js'
import { WORKSPACE_HOST, WORKSPACE_UID, workspaceExample } from '../../harness/workspace-fixtures.js'
import { saveConversationOpening } from '../board/conversationOpening.js'
import { servedFeed, settle } from '../board/testFixtures.js'
import { DeskPage } from './DeskPage.js'
import { PageFeed, POLL_MS, SENDS_POLL_MS } from './feed.js'
import { mountPage } from './mount.js'
import { deskHref, parsePageRoute, threadHref } from './route.js'
import { AUTO_ADVANCE_IDLE_MS, ThreadPage } from './ThreadPage.js'

/** Waits in real time: a viewer's first dynamic import takes as long as the machine is loaded. */
const waitUntil = async (fn: () => boolean): Promise<void> => {
  const until = performance.now() + 4_000
  while (!fn() && performance.now() < until) await settle()
}

describe('a page\'s address', () => {
  it('is its path\'s one segment when served, and the page parameter over file://', () => {
    expect(parsePageRoute({ protocol: 'http:', pathname: '/thread', search: '?f=01KV@umber&in=rex' }))
      .toStrictEqual({ page: 'thread', fiber: { uid: '01KV', host: 'umber' }, inRex: true })
    expect(parsePageRoute({ protocol: 'file:', pathname: '/x/harness-board-dist/index.html', search: '?example=threads&page=thread&f=01KV@umber' }))
      .toStrictEqual({ page: 'thread', fiber: { uid: '01KV', host: 'umber' }, inRex: false })
    expect(parsePageRoute({ protocol: 'http:', pathname: '/desk', search: '?in=rex' }))
      .toStrictEqual({ page: 'desk', fiber: undefined, inRex: true })
    expect(parsePageRoute({ protocol: 'file:', pathname: '/x/harness-board-dist/index.html', search: '?page=desk' }))
      .toStrictEqual({ page: 'desk', fiber: undefined, inRex: false })
    expect(parsePageRoute({ protocol: 'http:', pathname: '/map', search: '?in=rex' }))
      .toStrictEqual({ page: 'map', fiber: undefined, inRex: true })
    expect(parsePageRoute({ protocol: 'file:', pathname: '/x/harness-board-dist/index.html', search: '?page=map' }))
      .toStrictEqual({ page: 'map', fiber: undefined, inRex: false })
    // An `f` without both halves names no fiber.
    for (const f of ['01KV', '@umber', '01KV@', '']) expect(parsePageRoute({ protocol: 'http:', pathname: '/thread', search: `?f=${f}` }).fiber).toBeUndefined()
  })

  it('opens another fiber\'s thread page keeping the rest of the address, and returns to Desk dropping f', () => {
    expect(threadHref('http://127.0.0.1:4000/thread?f=a@h&in=rex', { uid: 'b', host: 'g' })).toBe('http://127.0.0.1:4000/thread?f=b%40g&in=rex')
    expect(threadHref('http://127.0.0.1:4000/desk', { uid: 'b', host: 'g' })).toBe('http://127.0.0.1:4000/thread?f=b%40g')
    expect(threadHref('file:///d/index.html?example=threads&page=thread&f=a@h', { uid: 'b', host: 'g' })).toBe('file:///d/index.html?example=threads&page=thread&f=b%40g')
    expect(deskHref('http://127.0.0.1:4000/thread?f=a@h')).toBe('http://127.0.0.1:4000/desk')
    expect(deskHref('file:///d/index.html?example=threads&page=thread&f=a@h')).toBe('file:///d/index.html?example=threads&page=desk')
  })
})

describe('the thread page', () => {
  const now = Date.now()
  let requests: Array<{ url: string; method: string; body?: string; headers: Headers }>
  let go: { went: boolean; place: string }
  let serveFiles: ((url: string, method: string, headers: Headers) => Response) | undefined
  let boardRecords: Array<{ id: string; kind: string; fiber: string; by: { fiber?: string; label?: string }; to?: { label?: string; fiber?: string }; text?: string; timestamp: number; originName: string }>
  let sentFiles: Array<{ fullPath: string; basename: string; timestamp: number; sessionId: string; uid: string; host: string; show?: boolean; caption?: string }>
  let usageResponse: Record<string, unknown> | null
  let voiceResponse: Record<string, unknown>
  let example: ReturnType<typeof workspaceExample>
  let transitionError: string | undefined
  let feeds: PageFeed[]
  let pages: ThreadPage[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(now)
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() })
    transitionError = undefined
    example = workspaceExample(now)
    addThreadFixtures(example, now)
    const composite = () => servedFeed(example.feed, now)
    requests = []
    boardRecords = []
    sentFiles = []
    usageResponse = null
    voiceResponse = {
      available: true,
      enabled: false,
      muted: false,
      state: 'off',
      follow: true,
      system_audio: false,
      sources: ['desktop'],
      source: 'desktop',
      launch: null,
      target: null,
      destination: null,
      last: null,
      error: null,
    }
    feeds = []
    serveFiles = undefined
    pages = []
    go = { went: true, place: 'live' }
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET', headers = new Headers(init.headers)
      requests.push({ url, method, body: init.body as string | undefined, headers })
      const json = (body: unknown, extra: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } })
      if (url.startsWith('/api/v1/fibers/composite')) return headers.get('If-None-Match') === '"v1"' ? new Response(null, { status: 304 }) : json(composite(), { ETag: '"v1"' })
      if (url.startsWith('/api/v1/board/family')) return json({ family: WORKSPACE_UID, records: boardRecords, waiting: {}, reach_ms: 14 * 86_400_000 })
      if (url.startsWith('/api/v1/channels/dismissed')) return json({ dismissed: [], reach_ms: 14 * 86_400_000 })
      if (url === '/api/v1/channels/dismiss' && method === 'POST') return json({ ok: true })
      if (url.startsWith('/api/v1/sent-files/all/composite')) return json({ files: sentFiles, origins: {} })
      if (url.startsWith('/api/v1/transcript/usage')) return usageResponse ? json(usageResponse) : new Response('{}', { status: 404 })
      if (url.split('?')[0] === '/api/v1/voice') {
        if (method === 'POST') {
          const patch = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
          voiceResponse = { ...voiceResponse, ...patch, state: (patch.enabled ?? voiceResponse.enabled) ? 'listening' : 'off' }
        }
        return json(voiceResponse)
      }
      if (url.startsWith('/api/v1/file') && serveFiles) return serveFiles(url, method, headers)
      if (url.startsWith('/api/v1/agents') && method === 'GET') {
        return json([
          { id: 'claude-opus', cli: 'claude', model: 'claude-opus', default: true, effort_levels: ['low', 'medium', 'high'], default_effort: 'medium', chrome_capable: true },
          { id: 'codex-5', cli: 'codex', model: 'codex-5', default: false, effort_levels: ['medium', 'high'], default_effort: 'high', chrome_capable: false },
        ])
      }
      if (url === '/api/v1/lifecycle' && method === 'POST') return json({ ok: true })
      if (url === '/api/v1/transition' && method === 'POST') return transitionError ? new Response(JSON.stringify({ error: transitionError }), { status: 409, headers: { 'Content-Type': 'application/json' } }) : json({ invoked: true })
      if (url === '/api/v1/felt-edit' && method === 'POST') return json({ ok: true })
      if (url === '/api/v1/go' && method === 'POST') return json(go)
      if (url === '/api/v1/attach' && method === 'POST') return json({ attached: true, session: 'resumed-session' })
      if (url === '/api/v1/dispatch' && method === 'POST') return json({ dispatched: true, tmux_session: 'started-session' })
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

  it('draws one constitution from the board\'s feed, lists no tempered or discarded thread, and never touches Rex focus', async () => {
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    expect(page.el.querySelector('.ov-name')!.textContent).toBe('calibration-report')
    expect(rows(page)).toContain('thread-analysis')
    page.el.querySelector<HTMLButtonElement>('.ov-quiet')!.click()
    const all = rows(page)
    expect(all).toContain('thread-draft')
    expect(all).not.toContain('thread-archive')
    expect(all).not.toContain('thread-discard')
    // Its head shows its pages, its lifecycle acts standing in the bar above, and no edits, which only the board's reader bakes.
    expect([...page.el.querySelectorAll<HTMLElement>('.ov-tools [data-part]')].map(each => each.dataset.part)).not.toContain('edits')
    expect(page.el.querySelector('.ws-fiber-acts')).toBeNull()
    expect(requests.map(each => new URL(each.url, 'http://d').pathname).filter(path => /voice\/target|attach|terminal/.test(path))).toStrictEqual([])
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

  it('unfolds the lead tapestry full-bleed with no fold control or bar when alone, and keeps the file switcher accessible when other files exist', async () => {
    const html = '<!doctype html><p>Full tapestry</p>'
    serveFiles = url => {
      if (!url.includes('tapestry.html')) return new Response('{}', { status: 404 })
      if (url.startsWith('/api/v1/file-info')) return new Response(JSON.stringify({ exists: true, size: html.length, modified_at: Math.floor(now / 1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
    }
    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const unfold = page.el.querySelector<HTMLElement>('.ov-unfold')!
    expect(unfold.hasAttribute('data-unfolded')).toBe(true)
    expect(unfold.hasAttribute('data-pinned-file')).toBe(true)
    expect(unfold.querySelector('.uf-card')).toBeNull()
    expect(unfold.querySelector('.uf-name')!.textContent).toBe('Tapestry')
    expect(unfold.querySelector<HTMLElement>('.uf-page')!.dataset.kind).toBe('html')
    expect(unfold.querySelector('.kbn-fileview-frame')).not.toBeNull()
    // Lead tapestry alone: fold control and bar are hidden, and Escape does not fold it.
    expect(unfold.querySelector<HTMLButtonElement>('.uf-fold')!.hidden).toBe(true)
    expect(unfold.querySelector<HTMLElement>('.uf-bar')!.hidden).toBe(true)
    unfold.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(unfold.hasAttribute('data-unfolded')).toBe(true)

    // With another shown file, the file switcher bar appears while the fold control stays hidden on the lead tapestry.
    sentFiles = [{ fullPath: '/tmp/plot.png', basename: 'plot.png', timestamp: now - 1_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST, show: true }]
    await vi.advanceTimersByTimeAsync(SENDS_POLL_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(unfold.querySelector<HTMLElement>('.uf-bar')!.hidden).toBe(false)
    expect(unfold.querySelector<HTMLElement>('.uf-steps')!.hidden).toBe(false)
    expect(unfold.querySelector<HTMLButtonElement>('.uf-fold')!.hidden).toBe(true)
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

  it('does not schedule further polls after stop() and dispose()', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const { page, feed } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const feedReads = () => requests.filter(each => each.url.startsWith('/api/v1/fibers/') || each.url.startsWith('/api/v1/sent-files/')).length
    const beforeFeed = feedReads()
    feed.stop()
    await vi.advanceTimersByTimeAsync(POLL_MS * 2)
    expect(feedReads()).toBe(beforeFeed)
    const beforeDispose = requests.length
    page.dispose()
    await vi.advanceTimersByTimeAsync(POLL_MS * 4)
    expect(requests.length).toBe(beforeDispose)
  })

  it('shows the docked footer on live, quiet, and archived threads, and dispatches send/resume and new session', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    // Live worker: docked footer is visible; sending a message uses continue, and New session with a message uses fresh.
    const { page: livePage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    expect(livePage.el.hasAttribute('data-dock')).toBe(true)
    const liveDock = livePage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(liveDock.classList.contains('ws-stage-band')).toBe(true)
    expect(liveDock.querySelector('.ws-dock')).not.toBeNull()
    expect(liveDock.hidden).toBe(false)
    const liveMsg = liveDock.querySelector<HTMLElement>('.ws-worker-message')!
    const livePrimary = liveDock.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    const liveFresh = liveDock.querySelector<HTMLButtonElement>('.ws-worker-fresh')!
    expect(livePrimary.disabled).toBe(true)
    liveMsg.textContent = 'Check the residuals'
    liveMsg.dispatchEvent(new Event('input'))
    expect(livePrimary.disabled).toBe(false)
    livePrimary.click()
    await settle(); await settle()
    const liveSend = JSON.parse(posts().filter(each => each.url === '/api/v1/dispatch').at(-1)!.body!) as Record<string, unknown>
    expect(liveSend.resume_mode).toBe('continue')
    expect(liveSend.user_message).toBe('Check the residuals')
    expect(liveSend.origin).toBe(WORKSPACE_HOST)

    liveMsg.textContent = 'Start fresh with new seed'
    liveMsg.dispatchEvent(new Event('input'))
    expect(liveFresh.hidden).toBe(false)
    liveFresh.click()
    await settle(); await settle()
    expect(confirmSpy).toHaveBeenCalled()
    const liveNew = JSON.parse(posts().filter(each => each.url === '/api/v1/dispatch').at(-1)!.body!) as Record<string, unknown>
    expect(liveNew.resume_mode).toBe('fresh')
    expect(liveNew.user_message).toBe('Start fresh with new seed')

    // Tempered and discarded threads also show the docked footer so a fresh session can be started, while staying in Tapestry / Files mode (Posts hidden; Changes visible when project_dir is set).
    const { page: temperedPage } = await open(`?f=thread-archive@${WORKSPACE_HOST}`)
    const temperedDock = temperedPage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(temperedDock.hidden).toBe(false)
    expect(temperedPage.el.hasAttribute('data-dock')).toBe(true)
    expect(temperedPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="posts"]')!.hidden).toBe(true)
    expect(temperedPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!.hidden).toBe(false)
    expect(temperedPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)

    const { page: discardedPage } = await open(`?f=thread-discard@${WORKSPACE_HOST}`)
    const discardedDock = discardedPage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(discardedDock.hidden).toBe(false)
    expect(discardedPage.el.hasAttribute('data-dock')).toBe(true)
    expect(discardedPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="posts"]')!.hidden).toBe(true)
    expect(discardedPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!.hidden).toBe(false)
    expect(discardedPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)

    // Quiet thread (awaiting review, no live worker): docked footer offers Resume and New session.
    const { page: quietPage } = await open(`?f=thread-review@${WORKSPACE_HOST}&in=rex`)
    const quietDock = quietPage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(quietDock.hidden).toBe(false)
    const primary = quietDock.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    expect(primary.hidden).toBe(false)
    const beforeQuiet = posts().filter(each => each.url === '/api/v1/dispatch').length
    primary.click()
    await settle(); await settle()
    const dispatches = posts().filter(each => each.url === '/api/v1/dispatch')
    expect(dispatches).toHaveLength(beforeQuiet + 1)
    const body = JSON.parse(dispatches.at(-1)!.body!) as Record<string, unknown>
    expect(body.force).toBe(true)
    expect(body.ad_hoc).toBe(true)
    expect(body.origin).toBe(WORKSPACE_HOST)
    expect(['previous', 'continue']).toContain(body.resume_mode)

    const fresh = quietDock.querySelector<HTMLButtonElement>('.ws-worker-fresh')!
    if (!fresh.hidden) {
      fresh.click()
      await settle(); await settle()
      const latest = JSON.parse(posts().filter(each => each.url === '/api/v1/dispatch').at(-1)!.body!) as Record<string, unknown>
      expect(latest.resume_mode).toBe('fresh')
    }
  })

  it('seats ListenControl and VoiceStrip in the docked footer and toggles Listen through /api/v1/voice', async () => {
    const { page } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    const dock = page.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    const mic = dock.querySelector<HTMLButtonElement>('.listen-mic')!
    const dropdown = dock.querySelector<HTMLButtonElement>('.listen-dropdown')!
    const strip = dock.querySelector<HTMLElement>('[data-part="voice-strip"]')!
    expect(mic).not.toBeNull()
    expect(dropdown).not.toBeNull()
    expect(strip.hidden).toBe(true)
    expect(mic.disabled).toBe(false)
    expect(mic.getAttribute('aria-label')).toBe('Listen')

    mic.click()
    await settle(); await settle()
    const voicePosts = posts().filter(each => each.url.split('?')[0] === '/api/v1/voice')
    expect(voicePosts).toHaveLength(1)
    expect(JSON.parse(voicePosts[0]!.body!)).toMatchObject({ enabled: true, muted: false, source: 'desktop' })
    expect(mic.classList.contains('listen-on')).toBe(true)
    expect(mic.getAttribute('aria-label')).toBe('Mute')
  })

  it('renders chevron prompt with inline context/cache meter placeholder that hides while typing', async () => {
    // Warm cache: shows chevron prompt, no "Message ..." placeholder, formatted token count, and warm cache pie inside the box.
    usageResponse = { context: 142_000, window: 1_000_000, cache_warm_until: now + 180_000, cache_ttl: 300_000 }
    const { page: warmPage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    const warmDock = warmPage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(warmDock.querySelector('.ws-band-head')).toBeNull()
    expect(warmDock.querySelector('.ws-worker-prompt')?.textContent).toBe('›')
    const warmMsg = warmDock.querySelector<HTMLElement>('.ws-worker-message')!
    expect(warmMsg.dataset.placeholder).toBeUndefined()
    const warmHint = warmDock.querySelector<HTMLElement>('[data-part="worker-hint"]')!
    const warmMeter = warmHint.querySelector<HTMLElement>('[data-part="context-meter"]')!
    const warmCtx = warmHint.querySelector<HTMLElement>('[data-part="context"]')!
    const warmCache = warmHint.querySelector<HTMLElement>('[data-part="cache"]')!
    expect(warmHint.hidden).toBe(false)
    expect(warmMeter.hidden).toBe(false)
    expect(warmCtx.hidden).toBe(false)
    expect(warmCtx.textContent).toBe('142k')
    expect(warmCache.hidden).toBe(false)
    expect(warmCache.dataset.cache).toBe('warm')
    expect(warmCache.getAttribute('aria-label')).toMatch(/^Cache warm until /)

    // Typing hides the inline meter placeholder immediately; clearing brings it back.
    warmMsg.textContent = 'h'
    warmMsg.dispatchEvent(new Event('input'))
    expect(warmHint.hidden).toBe(true)
    warmMsg.textContent = ''
    warmMsg.dispatchEvent(new Event('input'))
    expect(warmHint.hidden).toBe(false)

    // Cold cache: shows formatted token count and cold cache state.
    usageResponse = { context: 42_500, window: 1_000_000, cache_warm_until: now - 60_000, cache_ttl: 300_000 }
    const { page: coldPage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    const coldMeter = coldPage.el.querySelector<HTMLElement>('[data-part="thread-dock"] [data-part="context-meter"]')!
    const coldCtx = coldPage.el.querySelector<HTMLElement>('[data-part="thread-dock"] [data-part="context"]')!
    const coldCache = coldPage.el.querySelector<HTMLElement>('[data-part="thread-dock"] [data-part="cache"]')!
    expect(coldMeter.hidden).toBe(false)
    expect(coldCtx.textContent).toBe('42.5k')
    expect(coldCache.dataset.cache).toBe('cold')
    expect(coldCache.getAttribute('aria-label')).toMatch(/^Cache cold since /)

    // A thread with no session hides the meter while keeping the docked footer visible.
    const { page: noSessionPage } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
    expect(noSessionPage.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!.hidden).toBe(false)
    expect(noSessionPage.el.querySelector<HTMLElement>('[data-part="thread-dock"] [data-part="context-meter"]')!.hidden).toBe(true)
  })

  it('defaults a family root to Posts mode, renders its stream, routes post clicks through go/navigate, toggles to Tapestry/Files, and sends composer messages via dispatch', async () => {
    boardRecords = [
      { id: 'rec-1', kind: 'post', fiber: 'thread-analysis', by: { fiber: 'thread-analysis' }, to: { label: 'human' }, text: 'Analysis finished at 9 sigma.', timestamp: now - 10_000, originName: WORKSPACE_HOST },
      { id: 'rec-archived', kind: 'post', fiber: 'thread-archive', by: { fiber: 'thread-archive' }, to: { label: 'human' }, text: 'Should not show.', timestamp: now - 5_000, originName: WORKSPACE_HOST },
    ]
    const { page, navigate } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}&in=rex`)
    const modes = page.el.querySelector<HTMLElement>('.pg-modes')!
    const postsPane = page.el.querySelector<HTMLElement>('.pg-posts')!
    const familyPane = page.el.querySelector<HTMLElement>('.ws-family-page')!
    const postsTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="posts"]')!
    const filesTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="files"]')!

    expect(modes.hidden).toBe(false)
    expect(postsTab.getAttribute('aria-selected')).toBe('true')
    expect(postsPane.hidden).toBe(false)
    expect(familyPane.hidden).toBe(true)

    // Renders non-archived family post and excludes tempered fiber's post.
    const items = [...postsPane.querySelectorAll<HTMLElement>('.kbn-ch-item')]
    const analysisItem = items.find(each => each.textContent?.includes('Analysis finished at 9 sigma.'))
    expect(analysisItem).toBeDefined()
    expect(postsPane.textContent).not.toContain('Should not show.')

    // Clicking a post link in Rex mode posts /api/v1/go.
    analysisItem!.querySelector<HTMLButtonElement>('[data-item]')!.click()
    await settle()
    expect(posts().filter(each => each.url === '/api/v1/go').map(each => JSON.parse(each.body!)))
      .toStrictEqual([{ fiber_id: 'thread-analysis', origin: WORKSPACE_HOST }])
    expect(navigate).not.toHaveBeenCalled()

    // Checking off a post clears it from the stream and persists via /api/v1/channels/dismiss.
    const checkBtn = analysisItem!.querySelector<HTMLButtonElement>('.kbn-ch-clear')!
    expect(checkBtn).not.toBeNull()
    checkBtn.click()
    await settle(); await settle()
    expect(postsPane.textContent).not.toContain('Analysis finished at 9 sigma.')
    const dismissPosts = posts().filter(each => each.url === '/api/v1/channels/dismiss')
    expect(dismissPosts).toHaveLength(1)
    expect(JSON.parse(dismissPosts[0]!.body!)).toMatchObject({ fiber: 'thread-analysis' })

    // Unified docked footer sends user_message to the family root via /api/v1/dispatch with no duplicate message box.
    expect(page.el.querySelectorAll('.ws-worker-message')).toHaveLength(1)
    expect(page.el.querySelector('.pg-composer')).toBeNull()
    const dock = page.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    expect(dock.hidden).toBe(false)
    const input = dock.querySelector<HTMLElement>('.ws-worker-message')!
    const sendBtn = dock.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    input.textContent = 'Check the null tests'
    input.dispatchEvent(new Event('input'))
    sendBtn.click()
    await settle(); await settle()
    const dispatches = posts().filter(each => each.url === '/api/v1/dispatch')
    expect(dispatches).toHaveLength(1)
    const dispatchBody = JSON.parse(dispatches[0]!.body!) as Record<string, unknown>
    expect(dispatchBody.user_message).toBe('Check the null tests')
    expect(dispatchBody.resume_mode).toBe('continue')
    expect(dispatchBody.origin).toBe(WORKSPACE_HOST)
    expect(input.textContent).toBe('')

    // Toggling to Tapestry / Files hides Posts, shows FamilyPage, and keeps the same floating bottom bar visible.
    filesTab.click()
    expect(filesTab.getAttribute('aria-selected')).toBe('true')
    expect(postsPane.hidden).toBe(true)
    expect(familyPane.hidden).toBe(false)
    expect(dock.hidden).toBe(false)

    // In a browser (no in=rex), clicking a post link navigates instead of calling /api/v1/go.
    const { page: browserPage, navigate: browserNav } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const browserAnalysis = [...browserPage.el.querySelectorAll<HTMLElement>('.pg-posts .kbn-ch-item')].find(each => each.textContent?.includes('Analysis finished at 9 sigma.'))!
    browserAnalysis.querySelector<HTMLButtonElement>('[data-item]')!.click()
    expect(browserNav).toHaveBeenCalledWith(`${window.location.origin}/thread?f=thread-analysis%40${WORKSPACE_HOST}`)

    // A non-root thread with project_dir hides Posts, keeps Changes beside Tapestry / Files, and stays on Tapestry / Files.
    const { page: subPage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    expect(subPage.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(false)
    expect(subPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="posts"]')!.hidden).toBe(true)
    expect(subPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!.hidden).toBe(false)
    expect(subPage.el.querySelector<HTMLElement>('.pg-posts')!.hidden).toBe(true)
    expect(subPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)

    // A non-root thread without project_dir (and no .change.json sends) hides the mode bar and Posts pane.
    const { page: draftPage } = await open(`?f=thread-draft@${WORKSPACE_HOST}`)
    expect(draftPage.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(true)
    expect(draftPage.el.querySelector<HTMLElement>('.pg-posts')!.hidden).toBe(true)
    expect(draftPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)
  })

  it('opens thread settings popover lazily from the docked footer, fetches /api/v1/agents on click, and commits agent, effort, chrome, and due edits', async () => {
    const { page } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    const dock = page.el.querySelector<HTMLElement>('[data-part="thread-dock"]')!
    const gear = dock.querySelector<HTMLButtonElement>('.ws-thread-settings')!
    expect(gear).not.toBeNull()
    expect(gear.getAttribute('aria-label')).toBe('Settings')
    // Zero-cost before open: /api/v1/agents is not fetched until clicked.
    expect(requests.filter(each => each.url.startsWith('/api/v1/agents'))).toHaveLength(0)

    gear.click()
    for (let i = 0; i < 4; i++) await settle()
    const agentFetches = requests.filter(each => each.url.startsWith('/api/v1/agents'))
    expect(agentFetches.map(each => each.url)).toStrictEqual([`/api/v1/agents?origin=${encodeURIComponent(WORKSPACE_HOST)}`])

    const panel = dock.querySelector<HTMLElement>('.ws-settings-menu')!
    expect(panel).not.toBeNull()
    expect(panel.getAttribute('side')).toBe('top')

    const agentSelect = panel.querySelector<HTMLSelectElement>('.kbn-ctl-agent-select')!
    const effortSelect = panel.querySelector<HTMLSelectElement>('.kbn-ctl-effort-select')!
    const chromeInput = panel.querySelector<HTMLInputElement>('.kbn-ctl-chrome input')!
    const dueInput = panel.querySelector<HTMLInputElement>('.kbn-ctl-date')!
    const facts = panel.querySelector<HTMLElement>('.ws-header-facts')!
    expect([...agentSelect.options].map(o => o.value)).toContain('claude-opus')
    expect([...agentSelect.options].map(o => o.value)).toContain('codex-5')
    expect([...effortSelect.options].map(o => o.value)).toStrictEqual(['low', 'medium', 'high'])
    expect(facts.textContent).toContain(WORKSPACE_HOST)

    // Changing effort posts set-agent with only the changed axis.
    effortSelect.value = 'high'
    effortSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(); await settle()
    const effortPost = JSON.parse(posts().filter(each => each.url === '/api/v1/lifecycle').at(-1)!.body!) as Record<string, unknown>
    expect(effortPost).toMatchObject({ action: 'set-agent', origin: WORKSPACE_HOST, effort: 'high' })

    // Toggling Chrome posts set-agent with chrome: true.
    chromeInput.checked = true
    chromeInput.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(); await settle()
    const chromePost = JSON.parse(posts().filter(each => each.url === '/api/v1/lifecycle').at(-1)!.body!) as Record<string, unknown>
    expect(chromePost).toMatchObject({ action: 'set-agent', origin: WORKSPACE_HOST, chrome: true })

    // Changing agent to codex-5 disables/hides Chrome and posts the changed axes together.
    agentSelect.value = 'codex-5'
    agentSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(); await settle()
    const agentPost = JSON.parse(posts().filter(each => each.url === '/api/v1/lifecycle').at(-1)!.body!) as Record<string, unknown>
    expect(agentPost).toMatchObject({ action: 'set-agent', origin: WORKSPACE_HOST, agent: 'codex-5', chrome: false })
    expect(chromeInput.parentElement!.hidden).toBe(true)

    // Re-rendering with the same feed card reference does not clobber optimistic saved settings.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    page.render()
    expect(agentSelect.value).toBe('codex-5')
    expect(effortSelect.value).toBe('high')

    // Setting due date posts /api/v1/felt-edit.
    dueInput.value = '2026-12-01'
    dueInput.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(); await settle()
    const duePost = JSON.parse(posts().filter(each => each.url === '/api/v1/felt-edit').at(-1)!.body!) as Record<string, unknown>
    expect(duePost).toMatchObject({ origin: WORKSPACE_HOST, due: '2026-12-01' })
  })

  it('draws a single header console button visible across Posts, Tapestry/Files, and Changes that attaches a live worker, reopens a closed session, or opens Rex/Claude on phone', async () => {
    type RawRow = { fiber: { uid?: string; shuttle?: Record<string, unknown> }; runtime?: Record<string, unknown> | null }
    const rows = example.feed.fibers as unknown as RawRow[]
    const rootRow = rows.find(r => r.fiber.uid === WORKSPACE_UID)
    if (rootRow) rootRow.runtime = { ...(rootRow.runtime ?? {}), state: 'running', tmux_session: 'shuttle-root', terminal: 'rex', rex_session: 'calibration-report', session_link: 'https://claude.ai/code/session_01Root' }
    const analysisRow = rows.find(r => r.fiber.uid === 'thread-analysis')
    if (analysisRow?.runtime) analysisRow.runtime.tmux_session = 'shuttle-analysis'
    const reviewRow = rows.find(r => r.fiber.uid === 'thread-review')
    if (reviewRow) reviewRow.fiber.shuttle = { ...reviewRow.fiber.shuttle, runtime: { session_uuid: '11111111-1111-4111-8111-111111111111' } }

    // 1. Live worker (thread-analysis): console button sits in header bar (never duplicated in .ov-tools) and attaches via /api/v1/attach.
    const { page: livePage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}&in=rex`)
    expect(livePage.el.querySelectorAll('[data-part="console"]')).toHaveLength(1)
    expect(livePage.el.querySelector('.ov-tools [data-part="console"]')).toBeNull()
    const liveConsole = livePage.el.querySelector<HTMLAnchorElement>('[data-part="console"]')!
    expect(liveConsole.hidden).toBe(false)
    liveConsole.click()
    await settle()
    const liveAttach = posts().filter(each => each.url === '/api/v1/attach')
    expect(liveAttach).toHaveLength(1)
    expect(JSON.parse(liveAttach[0].body!)).toMatchObject({ tmux_session: 'shuttle-analysis', shuttle_host: WORKSPACE_HOST })

    // 2. Done session with no live worker (thread-review has sessionUuid but no live worker): reopens via /api/v1/attach with { session, shuttle_host }.
    requests.length = 0
    const { page: donePage } = await open(`?f=thread-review@${WORKSPACE_HOST}&in=rex`)
    const doneConsole = donePage.el.querySelector<HTMLAnchorElement>('[data-part="console"]')!
    expect(doneConsole.hidden).toBe(false)
    expect(doneConsole.getAttribute('aria-label')).toContain('Reopen')
    doneConsole.click()
    await settle()
    const reopenAttach = posts().filter(each => each.url === '/api/v1/attach')
    expect(reopenAttach).toHaveLength(1)
    expect(JSON.parse(reopenAttach[0].body!)).toEqual({ session: '11111111-1111-4111-8111-111111111111', shuttle_host: WORKSPACE_HOST })

    // 3. Draft with no session (thread-draft): console button stays hidden, and the bar stands for the thread's acts when in=rex.
    const { page: draftPage } = await open(`?f=thread-draft@${WORKSPACE_HOST}&in=rex`)
    const draftConsole = draftPage.el.querySelector<HTMLAnchorElement>('[data-part="console"]')!
    expect(draftConsole.hidden).toBe(true)
    expect(draftPage.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(false)
    expect(draftPage.el.querySelector<HTMLElement>('.pg-modes > .pg-actions')!.hidden).toBe(false)

    // 4. Standalone phone (!inRex): ← Desk button is visible and navigates to /desk; Console stays visible across Posts, Files, and Changes and updates immediately when destination changes.
    vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const { page: phonePage, navigate } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const nav = phonePage.el.querySelector<HTMLElement>('.pg-nav')!
    const back = phonePage.el.querySelector<HTMLButtonElement>('.pg-back')!
    const phoneConsole = nav.querySelector<HTMLAnchorElement>('[data-part="console"]')!
    expect(nav.hidden).toBe(false)
    expect(back.textContent).toBe('← Desk')
    expect(nav.querySelector('.pg-bar-title')!.textContent).toBe('calibration-report')
    // Visible on Posts (default for family root), Tapestry/Files, AND Changes!
    expect(phonePage.el.querySelector<HTMLElement>('.pg-posts')!.hidden).toBe(false)
    expect(phoneConsole.hidden).toBe(false)
    expect(phoneConsole.getAttribute('href')).toBe('https://claude.ai/code/session_01Root')
    phonePage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="files"]')!.click()
    expect(phoneConsole.hidden).toBe(false)
    phonePage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!.click()
    expect(phoneConsole.hidden).toBe(false)
    // Switching destination preference to Rex updates href immediately.
    saveConversationOpening('rex')
    expect(phoneConsole.getAttribute('href')).toBe('shortcuts://run-shortcut?name=Rex&input=text&text=calibration-report')
    // Tapping ← Desk navigates to /desk.
    back.click()
    expect(navigate).toHaveBeenCalledWith(`${window.location.origin}/desk`)
    // When in=rex, .pg-nav (← Desk) is hidden.
    expect(livePage.el.querySelector<HTMLElement>('.pg-nav')!.hidden).toBe(true)
  })

  it('mounts the baked Changes view lazily on non-root threads with projectDir, sends reviews to the live worker, and disposes cleanly', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
    const bundle = {
      version: 2,
      title: 'Response fit update',
      repo: { name: 'spectra', dir: '/fixture-project', forge_url: null },
      base: 'a'.repeat(40),
      head: 'b'.repeat(40),
      base_ref: 'main',
      head_ref: 'fit-update',
      commits: [{ sha: 'b'.repeat(40), subject: 'Update response fit' }],
      files: [{
        path: 'src/fit.py',
        status: 'modified',
        additions: 1,
        deletions: 1,
        role: 'implementation',
        header: '--- a/src/fit.py\n+++ b/src/fit.py\n',
        lines: [
          { kind: 'deletion', old: 1, new: 0, text: 'x = 1' },
          { kind: 'addition', old: 0, new: 1, text: 'x = 2' },
        ],
        hunks: [{
          file: 'src/fit.py',
          old_from: 1,
          old_lines: 1,
          new_from: 1,
          new_lines: 1,
          windows: [{ old_from: 1, old_lines: 1, new_from: 1, new_lines: 1, start: 0, rows: 2 }],
        }],
        remaining: [],
      }],
      story: null,
    }
    const bakedPath = '/cache/changes/thread-analysis/baked.change.json'
    const baseFetch = globalThis.fetch as unknown as (url: string, init?: RequestInit) => Promise<Response>
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url === '/api/v1/fibers/thread-analysis/change' && init.method === 'POST') {
        requests.push({ url, method: 'POST', body: init.body as string | undefined, headers: new Headers(init.headers) })
        return new Response(JSON.stringify({ path: bakedPath }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.startsWith('/api/v1/file') && decodeURIComponent(url).includes(bakedPath)) {
        requests.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers) })
        return new Response(JSON.stringify(bundle), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return baseFetch(url, init)
    }))

    const { page } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    const modes = page.el.querySelector<HTMLElement>('.pg-modes')!
    const postsTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="posts"]')!
    const changesTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!
    const changesPane = page.el.querySelector<HTMLElement>('.pg-changes')!

    expect(modes.hidden).toBe(false)
    expect(postsTab.hidden).toBe(true)
    expect(changesTab.hidden).toBe(false)
    expect(changesPane.hidden).toBe(true)
    // Lazy: no bake request until the user switches to Changes.
    expect(posts().filter(each => each.url === '/api/v1/fibers/thread-analysis/change')).toHaveLength(0)

    changesTab.click()
    await waitUntil(() => changesPane.querySelector('.change-reader') !== null)
    expect(changesTab.getAttribute('aria-selected')).toBe('true')
    expect(changesPane.hidden).toBe(false)
    expect(page.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(true)
    expect(posts().filter(each => each.url === '/api/v1/fibers/thread-analysis/change')).toHaveLength(1)
    expect(changesPane.querySelector('.change-reader')).not.toBeNull()
    expect(changesPane.querySelector('.change-heading h1')!.textContent).toBe('Response fit update')

    // Submitting a review note from ChangeReader's dock dispatches to the live worker.
    const overall = changesPane.querySelector<HTMLTextAreaElement>('.change-overall')!
    overall.value = 'Looks clean; ship after checking edge case.'
    overall.dispatchEvent(new Event('input', { bubbles: true }))
    const sendReviewBtn = [...changesPane.querySelectorAll<HTMLButtonElement>('.change-send > button')][0]!
    expect(sendReviewBtn.disabled).toBe(false)
    sendReviewBtn.click()
    for (let i = 0; i < 4; i++) await settle()
    const reviewDispatch = posts().filter(each => each.url === '/api/v1/dispatch').at(-1)!
    expect(reviewDispatch).toBeDefined()
    const reviewBody = JSON.parse(reviewDispatch.body!) as Record<string, unknown>
    expect(reviewBody.resume_mode).toBe('previous')
    expect(reviewBody.existing_only).toBe(true)
    expect(String(reviewBody.user_message)).toContain('Looks clean; ship after checking edge case.')

    page.dispose()
    expect(changesPane.querySelector('.change-reader')).toBeNull()
  })

  it('opens a clicked .change.json sent file or tapestry link in Changes mode instead of opening raw JSON via window.open', async () => {
    vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} unobserve() {} })
    const windowOpen = vi.spyOn(window, 'open').mockReturnValue(null)
    const makeBundle = (title: string) => JSON.stringify({
      version: 2,
      title,
      repo: { name: 'spectra', dir: '/fixture-project', forge_url: null },
      base: 'c'.repeat(40),
      head: 'd'.repeat(40),
      base_ref: 'main',
      head_ref: 'pr-branch',
      commits: [],
      files: [],
      story: null,
    })
    const sentChangePath = '/tmp/pr-42.change.json'
    const tapestryHtml = '<!doctype html><a href="pr-7.change.json">PR 7</a>'
    sentFiles = [
      { fullPath: sentChangePath, basename: 'pr-42.change.json', timestamp: now - 1_000, sessionId: 's1', uid: WORKSPACE_UID, host: WORKSPACE_HOST },
    ]
    serveFiles = url => {
      const decoded = decodeURIComponent(url)
      if (decoded.includes('tapestry.html')) {
        if (url.startsWith('/api/v1/file-info')) return new Response(JSON.stringify({ exists: true, size: tapestryHtml.length, modified_at: Math.floor(now / 1000) }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        return new Response(tapestryHtml, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      }
      if (decoded.includes('pr-42.change.json')) return new Response(makeBundle('PR 42 Sent Bundle'), { status: 200, headers: { 'Content-Type': 'application/json' } })
      if (decoded.includes('pr-7.change.json')) return new Response(makeBundle('PR 7 Tapestry Link'), { status: 200, headers: { 'Content-Type': 'application/json' } })
      return new Response('{}', { status: 404 })
    }

    const { page } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const filesTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="files"]')!
    const changesTab = page.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="changes"]')!
    const changesPane = page.el.querySelector<HTMLElement>('.pg-changes')!

    // 1. Clicking a .change.json sent file from Sent Files opens it in Changes mode without window.open.
    filesTab.click()
    for (let i = 0; i < 4; i++) await settle()
    page.el.querySelector<HTMLButtonElement>('.ov-tools [data-part="sends"]')!.click()
    await settle()
    const sentItem = [...document.querySelectorAll<HTMLElement>('.uf-file-row')].find(el => el.textContent?.includes('pr-42.change.json'))!
    expect(sentItem).toBeDefined()
    sentItem.closest<HTMLElement>('button, [role="menuitem"]')!.click()
    await waitUntil(() => (changesPane.textContent ?? '').includes('No changes:'))
    expect(windowOpen).not.toHaveBeenCalled()
    expect(changesTab.getAttribute('aria-selected')).toBe('true')
    expect(changesPane.hidden).toBe(false)
    expect(changesPane.querySelector<HTMLElement>('.pg-changes-bar')!.hidden).toBe(false)
    expect(changesPane.querySelector('.pg-changes-name')!.textContent).toBe('pr-42.change.json')
    expect(changesPane.querySelector('.kbn-fileview-change')).not.toBeNull()
    expect(changesPane.textContent).toContain('No changes:')

    // 2. Clicking a relative .change.json link inside the unfolded tapestry iframe opens it in Changes mode without window.open.
    filesTab.click()
    for (let i = 0; i < 4; i++) await settle()
    const iframe = page.el.querySelector<HTMLIFrameElement>('.ov-unfold .kbn-fileview-frame')!
    expect(iframe).not.toBeNull()
    window.dispatchEvent(new MessageEvent('message', {
      data: { protocol: 'shuttle-document', version: 1, type: 'ready', payload: {} },
      source: iframe.contentWindow,
    }))
    window.dispatchEvent(new MessageEvent('message', {
      data: { protocol: 'shuttle-document', version: 1, type: 'navigate', payload: { href: 'pr-7.change.json' } },
      source: iframe.contentWindow,
    }))
    await waitUntil(() => requests.some(req => decodeURIComponent(req.url).includes('/pr-7.change.json')))
    expect(windowOpen).not.toHaveBeenCalled()
    expect(changesTab.getAttribute('aria-selected')).toBe('true')
    expect(changesPane.hidden).toBe(false)
    expect(changesPane.querySelector('.pg-changes-name')!.textContent).toBe('pr-7.change.json')
    expect(requests.some(req => decodeURIComponent(req.url).includes('/pr-7.change.json'))).toBe(true)
  })

  describe('its lifecycle acts', () => {
    type Row = { fiber: Record<string, unknown> & { shuttle: Record<string, unknown> }; runtime?: Record<string, unknown> | null }
    const raw = (uid: string): Row => (example.feed.fibers as unknown as Row[]).find(each => each.fiber.uid === uid)!
    /** thread-review as a standing constitution whose run ended on a question, with no worker. */
    const standingAsk = (): void => {
      const row = raw('thread-review')
      Object.assign(row.fiber, { status: 'active', tempered: undefined, horizon: undefined })
      Object.assign(row.fiber.shuttle, { kind: 'standing', schedule: { expr: '0 9 * * *', tz: 'UTC' }, ask: { text: 'Keep the cut?', at: new Date(now).toISOString() } })
      row.runtime = null
    }
    const chord = (code: string, target: EventTarget = document): KeyboardEvent => {
      // Option changes the character: ⌥⌘T types †.
      const event = new KeyboardEvent('keydown', { key: '†', code, metaKey: true, altKey: true, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event
    }
    const bare = (key: string, target: EventTarget = document): void => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    const sent = () => posts().filter(each => /transition|lifecycle|dispatch$/.test(each.url)).map(each => [each.url, JSON.parse(each.body!) as Record<string, unknown>] as const)
    const said = (page: ThreadPage): string => page.el.querySelector('.pg-said')!.textContent!
    const face = (page: ThreadPage): HTMLButtonElement => page.el.querySelector<HTMLButtonElement>('.pg-actions .ws-verb-face')!
    const menu = async (page: ThreadPage): Promise<Array<[string, string | null]>> => {
      page.el.querySelector<HTMLButtonElement>('.pg-actions .ws-verb-more')!.click()
      for (let i = 0; i < 3; i++) await settle()
      return [...document.querySelectorAll<HTMLElement>('.kbn-verb-menu [data-action-index]')].map(item => [item.getAttribute('aria-label')!, item.getAttribute('aria-keyshortcuts')])
    }
    const reads = (): number => requests.filter(each => each.url.startsWith('/api/v1/fibers/composite')).length

    it('a standing run waiting with no worker leads with Temper run, whose button and ⌥⌘T temper it and read the board again', async () => {
      standingAsk()
      const { page } = await open(`?f=thread-review@${WORKSPACE_HOST}&in=rex`)
      expect(page.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(false)
      expect(face(page).textContent).toBe('Temper run')
      const before = reads()
      face(page).click()
      for (let i = 0; i < 4; i++) await settle()
      expect(sent()).toStrictEqual([['/api/v1/transition', { fiber_id: raw('thread-review').fiber.id, target: 'tempered', origin: WORKSPACE_HOST }]])
      expect(said(page)).toBe('Run tempered: review')
      expect(reads()).toBe(before + 1)
      expect(chord('KeyT').defaultPrevented).toBe(true)
      for (let i = 0; i < 4; i++) await settle()
      expect(sent()).toHaveLength(2)
    })

    it('lists every act with its keys, and Clear question withdraws the ask', async () => {
      standingAsk()
      const { page } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
      expect(page.el.querySelector('.pg-nav > .pg-actions')).not.toBeNull()
      expect(await menu(page)).toStrictEqual([
        ['Temper run', '⌥⌘T t'], ['Pause schedule', '⌥⌘S s'], ['Retire', '⌥⌘X x'], ['Clear question', null], ['New session', '⌥⌘N'],
      ])
      document.querySelectorAll<HTMLElement>('.kbn-verb-menu [data-action-index]')[3].click()
      for (let i = 0; i < 6; i++) await settle()
      expect(sent()).toStrictEqual([['/api/v1/lifecycle', { action: 'ask-clear', fiber: raw('thread-review').fiber.id, origin: WORKSPACE_HOST }]])
    })

    it.each([['active', 'rest'], ['open', 'resume']])('s on an %s schedule writes %s at once, with no popover', async (status, action) => {
      standingAsk()
      raw('thread-review').fiber.status = status
      await open(`?f=thread-review@${WORKSPACE_HOST}`)
      bare('s')
      await settle()
      expect(document.querySelector('.kbn-rest-popover')).toBeNull()
      expect(sent()).toStrictEqual([['/api/v1/lifecycle', { action, fiber: raw('thread-review').fiber.id, origin: WORKSPACE_HOST, actor: 'board' }]])
    })

    it('⌥⌘S then Enter rests a oneshot with no date, from inside the message box too', async () => {
      const { page } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
      const box = page.el.querySelector<HTMLElement>('.ws-worker-message')!
      chord('KeyS', box)
      await settle()
      const panel = document.querySelector<HTMLElement>('.kbn-rest-popover')!
      expect(panel.querySelector('.kbn-rest-headline')!.textContent).toMatch(/^No date/)
      // Its own keys are the dialog's while it is open.
      bare('x', panel)
      bare('Enter', panel)
      for (let i = 0; i < 4; i++) await settle()
      expect(sent()).toStrictEqual([['/api/v1/lifecycle', { action: 'rest', fiber: raw('thread-review').fiber.id, origin: WORKSPACE_HOST, until: '', actor: 'board' }]])
    })

    it('bare keys act outside the message box only, and only where the verb is offered', async () => {
      const { page } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
      const box = page.el.querySelector<HTMLElement>('.ws-worker-message')!
      for (const key of ['t', 's', 'a', 'x']) bare(key, box)
      // Work already awaiting review is not closed for review again: a key is nothing, a chord says so.
      bare('a')
      await settle()
      expect([sent(), document.querySelector('.kbn-rest-popover')]).toStrictEqual([[], null])
      chord('KeyA')
      expect(said(page)).toBe('review does not offer that now.')
      bare('x')
      for (let i = 0; i < 4; i++) await settle()
      expect(sent().map(([, body]) => body.target)).toStrictEqual(['composted'])
    })

    it('asks before stopping a live worker, and ⌥⌘N before cutting one', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockClear().mockReturnValue(false)
      await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
      chord('KeyA'); chord('KeyN')
      await settle()
      expect([confirm.mock.calls.length, sent()]).toStrictEqual([2, []])
      confirm.mockReturnValue(true)
      chord('KeyN')
      for (let i = 0; i < 4; i++) await settle()
      expect(sent()).toMatchObject([['/api/v1/dispatch', { fiber_id: raw('thread-analysis').fiber.id, origin: WORKSPACE_HOST, force: true, resume_mode: 'fresh' }]])
      chord('KeyA')
      for (let i = 0; i < 4; i++) await settle()
      expect(sent().at(-1)![1]).toMatchObject({ target: 'awaitingReview' })
    })

    it('says why the daemon refused, and writes one act at a time', async () => {
      transitionError = 'the store is wedged'
      const { page } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
      bare('t'); bare('t')
      for (let i = 0; i < 4; i++) await settle()
      expect(sent()).toHaveLength(1)
      expect(said(page)).toContain('Temper failed on review')
      expect(said(page)).toContain('the store is wedged')
    })
  })
})

describe('the desk page', () => {
  const now = Date.now()
  let requests: Array<{ url: string; method: string; body?: string; headers: Headers }>
  let goAnswer: { went: boolean; place: string }
  let paletteItems: Array<{ id: string; kind: string; title: string; subtitle?: string | null; detail?: string | null; fiber_id?: string | null; origin?: string | null }>
  let captureStatus: number
  let feeds: PageFeed[]
  let pages: DeskPage[]

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(now)
    const example = workspaceExample(now)
    addThreadFixtures(example, now)
    const composite = servedFeed(example.feed, now)
    requests = []
    feeds = []
    pages = []
    goAnswer = { went: true, place: 'live' }
    captureStatus = 200
    paletteItems = [
      { id: 'desk', kind: 'desk', title: 'Desk', subtitle: 'All threads across the fleet', detail: 'desk', fiber_id: null, origin: null },
      { id: 'new_thread', kind: 'new_thread', title: 'New thread…', subtitle: 'Start a capture session from a prompt', detail: 'capture', fiber_id: null, origin: null },
      { id: `channel:${WORKSPACE_HOST}:${WORKSPACE_UID}`, kind: 'channel', title: 'Calibration Report', subtitle: `calibration-report · ${WORKSPACE_HOST}`, detail: 'channel', fiber_id: WORKSPACE_UID, origin: WORKSPACE_HOST },
      { id: `thread:${WORKSPACE_HOST}:thread-analysis`, kind: 'thread', title: 'Analysis Run', subtitle: `analysis · ${WORKSPACE_HOST}`, detail: 'live', fiber_id: 'thread-analysis', origin: WORKSPACE_HOST },
      { id: `thread:${WORKSPACE_HOST}:thread-archive`, kind: 'thread', title: 'Old Archive', subtitle: `archive · ${WORKSPACE_HOST}`, detail: 'tempered', fiber_id: 'thread-archive', origin: WORKSPACE_HOST },
      { id: 'thread:orphan:no-origin', kind: 'thread', title: 'Orphan Archive', subtitle: 'orphan', detail: 'tempered', fiber_id: 'thread-orphan', origin: '' },
    ]
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET', headers = new Headers(init.headers)
      requests.push({ url, method, body: init.body as string | undefined, headers })
      const json = (body: unknown, extra: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } })
      if (url.startsWith('/api/v1/fibers/composite')) return json(composite, { ETag: '"d1"' })
      if (url.startsWith('/api/v1/board/family')) return json({ records: [], waiting: {}, reach_ms: 14 * 86_400_000 })
      if (url === '/api/v1/palette' && method === 'GET') return json({ focused: null, default_project_dir: '/stores/loom', items: paletteItems })
      if (url === '/api/v1/capture' && method === 'POST') {
        return new Response(JSON.stringify(captureStatus === 200 ? { spawned: true } : { error: 'capture failed' }), {
          status: captureStatus,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url === '/api/v1/go' && method === 'POST') return json(goAnswer)
      if (/^\/api\/v1\/(transition|lifecycle)$/.test(url) && method === 'POST') return json({ ok: true })
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

  async function openDesk(search = '', navigate = vi.fn()): Promise<{ page: DeskPage; feed: PageFeed; navigate: typeof navigate }> {
    const route = parsePageRoute({ protocol: 'http:', pathname: '/desk', search })
    const feed = new PageFeed('')
    feeds.push(feed)
    const page = new DeskPage(feed, { base: '', route, navigate })
    pages.push(page)
    document.body.append(page.el)
    feed.start()
    for (let i = 0; i < 4; i++) await settle()
    return { page, feed, navigate }
  }

  const posts = () => requests.filter(each => each.method === 'POST')

  it('renders the Desk columns and shelf without tempered or discarded fibers, and touches neither voice nor Rex focus', async () => {
    const { page } = await openDesk()
    const titles = [...page.el.querySelectorAll('.kbn-col-title')].map(el => el.textContent)
    expect(titles).toStrictEqual(['Waiting on you', 'Working', 'Awaiting review', 'Drafts', 'Resting', 'Roles & standing'])
    const uids = [...page.el.querySelectorAll<HTMLElement>('[data-card-uid]')].map(el => el.dataset.cardUid!)
    expect(uids).toContain(WORKSPACE_UID)
    expect(uids).not.toContain('thread-archive')
    expect(uids).not.toContain('thread-discard')
    expect(requests.map(each => new URL(each.url, 'http://d').pathname).filter(path => /voice|attach|terminal/.test(path))).toStrictEqual([])
  })

  it('in a Rex pane, clicking a card or waiting line calls POST /api/v1/go and shows .pg-said on failure', async () => {
    const { page, navigate } = await openDesk('?in=rex')
    const card = page.el.querySelector<HTMLElement>(`.kbn-family[data-card-uid="${WORKSPACE_UID}"]`)!
    card.click()
    await settle()
    expect(posts().map(each => [each.url, JSON.parse(each.body!)])).toStrictEqual([
      ['/api/v1/go', { fiber_id: WORKSPACE_UID, origin: WORKSPACE_HOST }],
    ])
    expect(page.el.querySelector<HTMLElement>('.pg-said')!.hidden).toBe(true)

    // When go fails, a quiet .pg-said toast explains why.
    goAnswer = { went: false, place: 'none' }
    const waitLine = page.el.querySelector<HTMLElement>('.kbn-family-wait[data-card-uid="thread-review"]')!
    waitLine.click()
    await settle(); await settle()
    const said = page.el.querySelector<HTMLElement>('.pg-said')!
    expect(said.hidden).toBe(false)
    expect(said.textContent).toBe('review is not running.')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('in a browser, clicking a card navigates to /thread?f=<uid>@<host> without calling /api/v1/go', async () => {
    const { page, navigate } = await openDesk()
    const card = page.el.querySelector<HTMLElement>(`.kbn-family[data-card-uid="${WORKSPACE_UID}"]`)!
    card.click()
    expect(navigate).toHaveBeenCalledWith(`${window.location.origin}/thread?f=${WORKSPACE_UID}%40${WORKSPACE_HOST}`)
    expect(posts()).toStrictEqual([])
  })

  it('supports DeskKeyboard navigation and opening with Enter', async () => {
    const { navigate } = await openDesk('?in=rex')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle()
    expect(posts().map(each => each.url)).toStrictEqual(['/api/v1/go'])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('lifecycle keys act on the selected row, bare or as ⌥⌘ chords, and on none when no row is selected', async () => {
    const { page } = await openDesk('?in=rex')
    const press = (init: KeyboardEventInit): void => { document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) }
    press({ key: 't' })
    press({ key: '†', code: 'KeyT', metaKey: true, altKey: true })
    await settle()
    expect(posts()).toStrictEqual([])
    const line = page.el.querySelector<HTMLElement>('[data-card-uid="thread-review"]')!
    line.tabIndex = -1
    line.focus()
    press({ key: 't' })
    for (let i = 0; i < 4; i++) await settle()
    expect(posts().map(each => [each.url, JSON.parse(each.body!).target])).toStrictEqual([['/api/v1/transition', 'tempered']])
    press({ key: 'ß', code: 'KeyS', metaKey: true, altKey: true })
    await settle()
    const panel = document.querySelector<HTMLElement>('.kbn-rest-popover')!
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    for (let i = 0; i < 4; i++) await settle()
    expect(JSON.parse(posts().at(-1)!.body!)).toMatchObject({ action: 'rest', until: '', origin: WORKSPACE_HOST })
  })

  it('a right-click on a row opens its acts and leaves the page where it is', async () => {
    const { page, navigate } = await openDesk()
    const line = page.el.querySelector<HTMLElement>('[data-card-uid="thread-review"]')!
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
    line.dispatchEvent(event)
    for (let i = 0; i < 3; i++) await settle()
    expect(event.defaultPrevented).toBe(true)
    const items = [...document.querySelectorAll<HTMLElement>('.kbn-verb-menu [data-action-index]')]
    expect(items.map(item => item.getAttribute('aria-label'))).toStrictEqual(['Rest', 'Temper', 'Discard', 'New session'])
    // A read that lands while the menu is open leaves the row it hangs from.
    page.render()
    expect(line.isConnected).toBe(true)
    items[2].click()
    for (let i = 0; i < 6; i++) await settle()
    expect(posts().map(each => [each.url, JSON.parse(each.body!).target])).toStrictEqual([['/api/v1/transition', 'composted']])
    expect(navigate).not.toHaveBeenCalled()
  })

  it('omits the search bar when in=rex, and renders a palette-backed search bar outside Rex', async () => {
    const { page: rexPage } = await openDesk('?in=rex')
    expect(rexPage.el.querySelector('.pg-desk-search')).toBeNull()
    expect(requests.filter(each => each.url === '/api/v1/palette')).toHaveLength(0)

    const { page, navigate } = await openDesk()
    const input = page.el.querySelector<HTMLInputElement>('.pg-desk-search-input')!
    const results = page.el.querySelector<HTMLElement>('.pg-desk-search-results')!
    expect(input).not.toBeNull()
    expect(results.hidden).toBe(true)
    // Lazy fetch: nothing fetched until focus/input.
    expect(requests.filter(each => each.url === '/api/v1/palette')).toHaveLength(0)

    input.focus()
    input.dispatchEvent(new Event('focus'))
    await settle(); await settle()
    expect(requests.filter(each => each.url === '/api/v1/palette')).toHaveLength(1)

    // Multi-token case-insensitive match finds tempered threads and excludes non-thread/channel items.
    input.value = 'archive tempered'
    input.dispatchEvent(new Event('input'))
    await settle()
    expect(results.hidden).toBe(false)
    const items = [...results.querySelectorAll<HTMLButtonElement>('.pg-desk-search-item')]
    expect(items).toHaveLength(2) // 1 match + 1 capture row
    expect(items[0]!.querySelector('.pg-desk-search-title')!.textContent).toBe('Old Archive')
    expect(items[0]!.querySelector('.pg-desk-search-badge')!.textContent).toBe('tempered')
    expect(items[1]!.textContent).toContain('Start new thread: “archive tempered”')

    // Typing while focused in search input does not steal keys for DeskKeyboard.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(navigate).not.toHaveBeenCalled()

    // Clicking a match navigates to its /thread page and clears/closes the search.
    items[0]!.click()
    expect(navigate).toHaveBeenCalledWith(`${window.location.origin}/thread?f=thread-archive%40${WORKSPACE_HOST}`)
    expect(input.value).toBe('')
    expect(results.hidden).toBe(true)

    // Clicking the capture row posts /api/v1/capture and announces via .pg-said.
    input.value = 'investigate weak lensing residuals'
    input.dispatchEvent(new Event('input'))
    await settle()
    const captureBtn = results.querySelector<HTMLButtonElement>('.pg-desk-search-capture')!
    captureBtn.click()
    await settle(); await settle()
    const capturePosts = posts().filter(each => each.url === '/api/v1/capture')
    expect(capturePosts).toHaveLength(1)
    expect(JSON.parse(capturePosts[0]!.body!)).toStrictEqual({ prompt: 'investigate weak lensing residuals' })
    const said = page.el.querySelector<HTMLElement>('.pg-said')!
    expect(said.hidden).toBe(false)
    expect(said.textContent).toBe('Started capture session…')

    // Escape clears the query, closes the dropdown, and returns focus to input even when a result button is focused.
    input.value = 'calibration'
    input.dispatchEvent(new Event('input'))
    await settle()
    expect(results.hidden).toBe(false)
    const firstResult = results.querySelector<HTMLButtonElement>('.pg-desk-search-item')!
    firstResult.focus()
    firstResult.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(input.value).toBe('')
    expect(results.hidden).toBe(true)
    expect(document.activeElement).toBe(input)

    // Palette cache refreshes after >15s.
    expect(requests.filter(each => each.url === '/api/v1/palette')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(16_000)
    input.dispatchEvent(new Event('focus'))
    await settle(); await settle()
    expect(requests.filter(each => each.url === '/api/v1/palette')).toHaveLength(2)
  })

  it('mountPage mounts DeskPage for /desk', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    mountPage(host, parsePageRoute({ protocol: 'http:', pathname: '/desk', search: '' }), '')
    for (let i = 0; i < 4; i++) await settle()
    expect(host.querySelector('main.pg-desk')).not.toBeNull()
    expect(host.querySelector('.kbn-desk-sections')).not.toBeNull()
  })

  it('mountPage lazily mounts MapPage for /map', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    mountPage(host, parsePageRoute({ protocol: 'http:', pathname: '/map', search: '?in=rex' }), '')
    await vi.dynamicImportSettled()
    for (let i = 0; i < 4; i++) await settle()
    expect(host.querySelector('.pg-map')).not.toBeNull()
    expect(requests.some(r => r.url === '/api/v1/map/terrain')).toBe(true)
  })
})

describe('the map page', () => {
  let pages: Array<{ dispose(): void }>

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    pages = []
  })

  afterEach(() => {
    for (const page of pages) page.dispose()
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('dispose() aborts in-flight terrain fetch and removes global listeners cleanly', async () => {
    const { MapPage } = await import('./MapPage.js')
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal ?? undefined
        return new Promise<Response>(() => {})
      }),
    )
    const removeWin = vi.spyOn(window, 'removeEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')

    const page = new MapPage({
      base: '',
      route: parsePageRoute({ protocol: 'http:', pathname: '/map', search: '' }),
      navigate: vi.fn(),
    })
    pages.push(page)
    document.body.append(page.el)
    page.start()

    expect(capturedSignal).toBeDefined()
    expect(capturedSignal!.aborted).toBe(false)

    page.dispose()

    expect(capturedSignal!.aborted).toBe(true)
    expect(removeDoc.mock.calls.map(c => c[0])).toEqual(expect.arrayContaining(['click', 'visibilitychange']))
    expect(removeWin.mock.calls.map(c => c[0])).toEqual(
      expect.arrayContaining(['resize', 'keydown', 'wheel', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click']),
    )
  })

  it('distinguishes 503 booting from other 503 errors and times out a hung terrain request', async () => {
    const { MapPage, TERRAIN_TIMEOUT_MS } = await import('./MapPage.js')
    let mode: 'booting' | 'other503' | 'hang' = 'booting'
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (mode === 'booting') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'booting' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        if (mode === 'other503') {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'store unreachable' }), {
              status: 503,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }),
    )

    const page = new MapPage({
      base: '',
      route: parsePageRoute({ protocol: 'http:', pathname: '/map', search: '' }),
      navigate: vi.fn(),
    })
    pages.push(page)
    document.body.append(page.el)
    page.start()
    for (let i = 0; i < 4; i++) await settle()

    const msg = page.el.querySelector<HTMLElement>('.map-loading-msg')!
    const retry = page.el.querySelector<HTMLButtonElement>('.map-retry')!
    expect(msg.textContent).toBe('The daemon is starting…')
    expect(retry.hidden).toBe(false)

    mode = 'other503'
    retry.click()
    for (let i = 0; i < 4; i++) await settle()
    expect(msg.textContent).toContain('store unreachable')
    expect(retry.hidden).toBe(false)

    mode = 'hang'
    retry.click()
    await vi.advanceTimersByTimeAsync(TERRAIN_TIMEOUT_MS)
    for (let i = 0; i < 4; i++) await settle()
    expect(msg.textContent).toContain('Timed out')
    expect(retry.hidden).toBe(false)
  })

  it('mountPage renders a clean error state if MapPage throws synchronously during mount', async () => {
    const { MapPage } = await import('./MapPage.js')
    vi.spyOn(MapPage.prototype, 'start').mockImplementation(() => {
      throw new Error('map init exploded')
    })

    const host = document.createElement('div')
    document.body.append(host)
    mountPage(host, parsePageRoute({ protocol: 'http:', pathname: '/map', search: '' }), '')
    await vi.dynamicImportSettled()
    for (let i = 0; i < 4; i++) await settle()

    expect(host.className).toBe('pg-missing')
    expect(host.textContent).toBe('Could not load map: map init exploded')
    expect(host.querySelector('.pg-map')).toBeNull()
  })
})
