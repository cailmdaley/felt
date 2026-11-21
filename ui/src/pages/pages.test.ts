// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addThreadFixtures } from '../../harness/thread-fixtures.js'
import { WORKSPACE_HOST, WORKSPACE_UID, workspaceExample } from '../../harness/workspace-fixtures.js'
import { servedFeed, settle } from '../board/testFixtures.js'
import { DeskPage } from './DeskPage.js'
import { PageFeed, POLL_MS, SENDS_POLL_MS } from './feed.js'
import { mountPage } from './mount.js'
import { parsePageRoute, threadHref } from './route.js'
import { AUTO_ADVANCE_IDLE_MS, ThreadPage } from './ThreadPage.js'

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
  let boardRecords: Array<{ id: string; kind: string; fiber: string; by: { fiber?: string; label?: string }; to?: { label?: string; fiber?: string }; text?: string; timestamp: number; originName: string }>
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
    boardRecords = []
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
      if (url.startsWith('/api/v1/board/family')) return json({ family: WORKSPACE_UID, records: boardRecords, waiting: {}, reach_ms: 14 * 86_400_000 })
      if (url.startsWith('/api/v1/sent-files/all/composite')) return json({ files: sentFiles, origins: {} })
      if (url.startsWith('/api/v1/file') && serveFiles) return serveFiles(url, method, headers)
      if (url === '/api/v1/go' && method === 'POST') return json(go)
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

  it('shows a Resume / New session strip when the thread has no live worker, and hides it when live or tempered/discarded', async () => {
    // Live worker: strip is hidden.
    const { page: livePage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    expect(livePage.el.querySelector<HTMLElement>('.pg-worker-strip')!.hidden).toBe(true)

    // Tempered thread: strip is hidden.
    const { page: temperedPage } = await open(`?f=thread-archive@${WORKSPACE_HOST}`)
    expect(temperedPage.el.querySelector<HTMLElement>('.pg-worker-strip')!.hidden).toBe(true)

    // Discarded thread: strip is hidden.
    const { page: discardedPage } = await open(`?f=thread-discard@${WORKSPACE_HOST}`)
    expect(discardedPage.el.querySelector<HTMLElement>('.pg-worker-strip')!.hidden).toBe(true)

    // Quiet thread (awaiting review, no live worker): strip is shown with WorkerActions.
    const { page: quietPage } = await open(`?f=thread-review@${WORKSPACE_HOST}&in=rex`)
    const strip = quietPage.el.querySelector<HTMLElement>('.pg-worker-strip')!
    expect(strip.hidden).toBe(false)
    const primary = strip.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    expect(primary.hidden).toBe(false)
    primary.click()
    await settle(); await settle()
    const dispatches = posts().filter(each => each.url === '/api/v1/dispatch')
    expect(dispatches).toHaveLength(1)
    const body = JSON.parse(dispatches[0]!.body!) as Record<string, unknown>
    expect(body.force).toBe(true)
    expect(body.ad_hoc).toBe(true)
    expect(body.origin).toBe(WORKSPACE_HOST)
    expect(['previous', 'continue']).toContain(body.resume_mode)

    // New session button dispatches with resume_mode: 'fresh' when visible.
    const fresh = strip.querySelector<HTMLButtonElement>('.ws-worker-fresh')!
    if (!fresh.hidden) {
      fresh.click()
      await settle(); await settle()
      const latest = JSON.parse(posts().filter(each => each.url === '/api/v1/dispatch').at(-1)!.body!) as Record<string, unknown>
      expect(latest.resume_mode).toBe('fresh')
    }
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

    // Compact composer sends user_message to the family root via /api/v1/dispatch.
    const input = postsPane.querySelector<HTMLTextAreaElement>('.pg-composer-input')!
    const sendBtn = postsPane.querySelector<HTMLButtonElement>('.pg-composer-send')!
    input.value = 'Check the null tests'
    sendBtn.click()
    await settle(); await settle()
    const dispatches = posts().filter(each => each.url === '/api/v1/dispatch')
    expect(dispatches).toHaveLength(1)
    const dispatchBody = JSON.parse(dispatches[0]!.body!) as Record<string, unknown>
    expect(dispatchBody.user_message).toBe('Check the null tests')
    expect(dispatchBody.resume_mode).toBe('continue')
    expect(dispatchBody.origin).toBe(WORKSPACE_HOST)
    expect(input.value).toBe('')
    // Avoid duplicate message inputs: worker strip stays hidden while Posts composer is shown.
    expect(page.el.querySelector<HTMLElement>('.pg-worker-strip')!.hidden).toBe(true)

    // Toggling to Tapestry / Files hides Posts and shows FamilyPage.
    filesTab.click()
    expect(filesTab.getAttribute('aria-selected')).toBe('true')
    expect(postsPane.hidden).toBe(true)
    expect(familyPane.hidden).toBe(false)

    // In a browser (no in=rex), clicking a post link navigates instead of calling /api/v1/go.
    const { page: browserPage, navigate: browserNav } = await open(`?f=${WORKSPACE_UID}@${WORKSPACE_HOST}`)
    const browserAnalysis = [...browserPage.el.querySelectorAll<HTMLElement>('.pg-posts .kbn-ch-item')].find(each => each.textContent?.includes('Analysis finished at 9 sigma.'))!
    browserAnalysis.querySelector<HTMLButtonElement>('[data-item]')!.click()
    expect(browserNav).toHaveBeenCalledWith(`${window.location.origin}/thread?f=thread-analysis%40${WORKSPACE_HOST}`)

    // A non-root thread with a subtree offers Posts mode, defaulting to Tapestry / Files.
    const { page: subPage } = await open(`?f=thread-analysis@${WORKSPACE_HOST}`)
    expect(subPage.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(false)
    expect(subPage.el.querySelector<HTMLButtonElement>('.pg-mode-pill[data-mode="files"]')!.getAttribute('aria-selected')).toBe('true')
    expect(subPage.el.querySelector<HTMLElement>('.pg-posts')!.hidden).toBe(true)
    expect(subPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)

    // A leaf thread (not a family root, no descendants) hides the mode bar and Posts pane.
    const { page: leafPage } = await open(`?f=thread-review@${WORKSPACE_HOST}`)
    expect(leafPage.el.querySelector<HTMLElement>('.pg-modes')!.hidden).toBe(true)
    expect(leafPage.el.querySelector<HTMLElement>('.pg-posts')!.hidden).toBe(true)
    expect(leafPage.el.querySelector<HTMLElement>('.ws-family-page')!.hidden).toBe(false)
  })
})

describe('the desk page', () => {
  const now = Date.now()
  let requests: Array<{ url: string; method: string; body?: string; headers: Headers }>
  let goAnswer: { went: boolean; place: string }
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
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET', headers = new Headers(init.headers)
      requests.push({ url, method, body: init.body as string | undefined, headers })
      const json = (body: unknown, extra: Record<string, string> = {}): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...extra } })
      if (url.startsWith('/api/v1/fibers/composite')) return json(composite, { ETag: '"d1"' })
      if (url.startsWith('/api/v1/board/family')) return json({ records: [], waiting: {}, reach_ms: 14 * 86_400_000 })
      if (url === '/api/v1/go' && method === 'POST') return json(goAnswer)
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

  it('mountPage mounts DeskPage for /desk', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    mountPage(host, parsePageRoute({ protocol: 'http:', pathname: '/desk', search: '' }), '')
    for (let i = 0; i < 4; i++) await settle()
    expect(host.querySelector('main.pg-desk')).not.toBeNull()
    expect(host.querySelector('.kbn-desk-sections')).not.toBeNull()
  })
})
