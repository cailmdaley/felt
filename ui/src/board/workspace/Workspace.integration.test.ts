// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { card, servedFeed } from '../testFixtures.js'
import type { ColumnKind, KanbanCard } from '../KanbanTypes.js'
import type { Turn } from '../turn.js'
import { Workspace, type WorkspaceOptions } from './Workspace.js'
import { ThreadIndex } from '../threads.js'
import { projectDeskFrontier } from '../KanbanReadModel.js'
import { deskOrder } from '../deskOrdering.js'
import { response as boardResponse } from '../testFixtures.js'
import type { Reader } from './Reader.js'
import { Dock } from './Dock.js'
import { docKey } from './documents.js'
import { resetLanes } from '../requestLanes.js'
import { buildFileViewer } from '../FileViewerPanel.js'
import { FiberSends } from '../fiberSends.js'

vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async () => {}),
  bindDrawnPage: vi.fn(),
  buildFileViewer: vi.fn((_base: string, path: string, _owner: string, onLoad?: (frame: HTMLIFrameElement, refreshed: boolean) => void) => {
    const wrap = document.createElement('div')
    const iframe = document.createElement('iframe')
    iframe.title = path
    iframe.srcdoc = '<p>Report</p>'
    iframe.addEventListener('load', () => {
      if (iframe.contentWindow) iframe.contentWindow.scrollTo = vi.fn()
      onLoad?.(iframe, false)
    })
    wrap.append(iframe)
    return wrap
  }),
  disposeFileViewer: vi.fn(), suspendFileViewer: vi.fn(), resumeFileViewer: vi.fn(), loadFileViewerOnce: vi.fn(),
}))

let workspace: Workspace
type WorkspaceTestOptions = Omit<WorkspaceOptions, 'deskRows'> & { deskRows?: WorkspaceOptions['deskRows'] }
/** Every refresh reads the sent-file feed, so a test's changed answer is seen at its next step. */
function makeWorkspace(root: HTMLElement, opts: WorkspaceTestOptions): Workspace {
  return new Workspace(root, { sends: new FiberSends(opts.shuttleBase, { intervalMs: 0 }), ...opts, deskRows: opts.deskRows ?? opts.cards })
}
/** The turn an owner serves for a live worker's phase. */
const TURN_OF_PHASE: Record<string, Turn> = { working: 'working', waiting: 'idle', attention: 'question', blocked: 'blocked' }
const cards = [
  card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a', fiberDir: '/notes/alpha', path: 'work/alpha/alpha.md' }),
  card({ id: 'work/beta', uid: 'beta', name: 'Beta', originId: 'host-b', fiberDir: '/notes/beta', path: 'work/beta/beta.md' }),
]
const body = 'The result is ready.\n\n:::{embed} report.html\n:title: Report\n:::\n\n[Data](data.csv)'
let bodyCards: KanbanCard[] = cards
let boardCards: KanbanCard[] = cards
const bodyOverrides = new Map<string, string>()
const fiberReadResponse = (card: KanbanCard, contents = body): Response => {
  const frontmatter: Record<string, unknown> = {
    uid: card.uid ?? card.id, name: card.name, status: card.status,
    outcome: card.outcome ?? 'A checked result.',
  }
  if (card.shuttleKind) {
    frontmatter.shuttle = {
      kind: card.shuttleKind, agent: card.shuttleAgent, host: card.shuttleHost,
      project_dir: card.shuttleProjectDir,
    }
  }
  return new Response(JSON.stringify(servedFeed({
    host: card.originId,
    fibers: [{
      origin: card.originId, felt_store: card.feltStore ?? '/notes/.felt', path: card.path,
      dir: card.fiberDir ?? '/notes',
      fiber: {
        id: card.id, uid: card.uid ?? card.id, name: card.name, path: card.path,
        status: card.status, created_at: card.createdAt, frontmatter,
        ...(frontmatter.shuttle ? { shuttle: frontmatter.shuttle } : {}),
        outcome: card.outcome ?? 'A checked result.', body: contents,
      },
    }],
  })))
}
// Microtask depth varies with the Node runtime (undici fetch/Response hops), so drain generously.
const flush = async (): Promise<void> => { for (let i = 0; i < 200; i++) await Promise.resolve() }
const pop = async (action: () => void): Promise<void> => {
  await new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    action()
  })
  await flush()
}
/** The Board's receipt feed has named alpha's report before the channel opens. */
const feedNamesReport = async (): Promise<void> => {
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/sent-files/all/')
    ? new Response(JSON.stringify({ files: [{ fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: Date.now(), sessionId: 'session-two' }] }))
    : original(input, init))
  workspace.overview.refresh()
  await flush()
}
const changed = vi.fn()
const visibility = vi.fn<(active: boolean) => void>()

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1440)
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  bodyCards = cards
  boardCards = cards
  bodyOverrides.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/sent-files/all/')) return new Response(JSON.stringify({ files: [
      { fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: 1, sessionId: 'session-one' },
      { fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: 2, sessionId: 'session-two' },
      { fullPath: '/notes/alpha/table.html', uid: 'alpha', host: 'host-a', timestamp: 3 },
    ] }))
    if (url.includes('/api/v1/sent-files?')) {
      const uid = new URL(url, 'http://workspace.test').searchParams.get('uid')
      return new Response(JSON.stringify({ files: uid === 'alpha' ? [
        { fullPath: '/notes/alpha/report.html', timestamp: 2, sessionId: 'session-two' },
        { fullPath: '/notes/alpha/table.html', timestamp: 3 },
      ] : [] }), { headers: { ETag: '"alpha-receipts"' } })
    }
    if (url.includes('/api/v1/fibers/')) {
      const request = new URL(url, 'http://workspace.test')
      const id = request.pathname.slice('/api/v1/fibers/'.length).split('/').map(decodeURIComponent).join('/')
      const source = bodyCards.find(card => (card.id === id || (card.uid ?? card.id) === id) && card.originId === request.searchParams.get('origin'))
        ?? bodyCards.find(card => card.id === id || (card.uid ?? card.id) === id)
      if (source) return fiberReadResponse(source, bodyOverrides.get(`${source.originId}:${source.uid ?? source.id}`) ?? body)
    }
    if (url.includes('/api/v1/fibers')) return new Response(JSON.stringify({ fibers: [] }))
    return new Response('{}')
  }))
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
  localStorage.clear()
  changed.mockClear()
  visibility.mockClear()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => boardCards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock("", changed) })
})
/** What the board asked Rex to select: every select-only attach body. */
const selections = (): Record<string, unknown>[] => vi.mocked(fetch).mock.calls
  .filter(([url]) => String(url).endsWith('/api/v1/attach'))
  .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
afterEach(() => { resetLanes(); workspace?.dispose(); vi.useRealTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('routes a linked change to the fiber holding its file on its own host, not the report channel', async () => {
  boardCards = bodyCards = cards.map(c => ({ ...c, workerState: 'running' as const }))
  const send = vi.spyOn(Dock.prototype, 'sendReview').mockResolvedValue(undefined)
  workspace.open(boardCards[0], 'Desk', docKey('host-a', '/notes/alpha/report.html', 'host-a')); await flush()
  const report = vi.mocked(buildFileViewer).mock.calls.filter(call => call[1] === '/notes/alpha/report.html').at(-1)![5]!
  report.onNavigate!('/api/v1/file?path=%2Fnotes%2Fbeta%2Freview.change.json&origin=host-b')
  await flush()
  const review = vi.mocked(buildFileViewer).mock.calls.filter(call => call[1] === '/notes/beta/review.change.json').at(-1)![5]!
  expect(review.reviewTarget!()).toBe('work/beta on host-b')
  expect(review.canReview!()).toBe(true)
  await review.onReview!('Review anchored to the linked snapshot')
  expect(send).toHaveBeenCalledWith(boardCards[1], 'Review anchored to the linked snapshot')
  boardCards = [boardCards[0], { ...boardCards[1], workerState: undefined }]
  expect(review.canReview!()).toBe(false)
  boardCards = [boardCards[0]]
  expect(review.canReview!()).toBe(false)
  await expect(review.onReview!('Do not fall back to Alpha')).rejects.toThrow('fiber holding this bundle')
  expect(send).toHaveBeenCalledTimes(1)
})

it('does not redraw an unchanged active channel and follows changed cards across navigation', async () => {
  workspace.open(cards[0], 'Desk')
  await flush()
  workspace.update() // The first poll seats the current card revision.
  const show = vi.spyOn(workspace.reader, 'show')

  workspace.update()
  expect(show).not.toHaveBeenCalled()

  boardCards = [
    { ...cards[0], name: 'Alpha updated' },
    { ...cards[1], orchestrator: cards[0].id },
  ]
  workspace.update()
  expect(show).toHaveBeenCalledOnce()

  workspace.open(boardCards[1], 'Desk')
  await flush()
  show.mockClear()
  workspace.update()
  expect(show).not.toHaveBeenCalled()

  boardCards = [...boardCards, card({ id: 'work/unrelated', uid: 'unrelated', originId: 'host-c', status: 'active', runtimePhase: 'working' })]
  workspace.update()
  expect(show).not.toHaveBeenCalled()

  boardCards = [boardCards[0], { ...boardCards[1], name: 'Beta working', status: 'active', workerState: 'running', runtimePhase: 'working' }]
  workspace.update()
  expect(show).toHaveBeenCalledOnce()
  expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Beta working')
})

it('discovers a report only after it exists, including creation on a later refresh', async () => {
  vi.useFakeTimers()
  bodyOverrides.set('host-b:beta', 'No report yet.')
  let exists = false
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?')
    ? new Response(JSON.stringify({ exists: String(input).includes('report.html') && exists })) : original(input, init))
  workspace.open(cards[1], 'Desk'); await flush()
  const key = docKey('host-b', '/notes/beta/report.html', 'host-b')
  expect(workspace.reader.host.get(key)).toBeUndefined()
  expect(document.querySelector('.ws-report-inset')).toBeNull()
  exists = true
  await vi.advanceTimersByTimeAsync(15000); await flush()
  expect(workspace.reader.host.get(key)).toBeDefined()
})

it('brings the constitution forward from the band and retraces to the page it left', async () => {
  bodyCards = cards.map(card => ({ ...card, shuttleKind: 'oneshot' }))
  workspace.open(bodyCards[0], 'Desk'); await flush()
  workspace.open(bodyCards[1], 'Desk'); await flush()
  workspace.reader.openDocument(docKey('host-b', '/notes/beta/report.html', 'host-b')); await flush()
  document.querySelector<HTMLButtonElement>('.ws-stage-band .ws-band-constitution')!.click()
  await flush()
  expect(workspace.reader.document?.kind).toBe('fiber')
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to report.html')
  await pop(() => workspace.reader.back())
  expect(workspace.reader.document?.name).toBe('report.html')
})

it('takes a verdict key on a report without moving the page, its undo in the band', async () => {
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot', status: 'closed' }]
  workspace.open(bodyCards[0], 'Desk'); await flush()
  const report = docKey('host-a', '/notes/alpha/report.html', 'host-a')
  workspace.reader.openDocument(report); await flush()
  const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
  press('t')
  expect(workspace.reader.document?.key).toBe(report)
  expect(document.querySelectorAll('.ws-stage-band .ws-verdict-undo')).toHaveLength(1)
  expect(document.querySelector('.ws-stage-band .ws-verdict-undo')?.textContent).toMatch(/^Tempered/)
  press('z')
  expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
})

it('gives r no work on a constitution', async () => {
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot', status: 'closed' }]
  workspace.open(bodyCards[0], 'Desk'); await flush()
  const event = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(document.querySelector('.ws-reader textarea')).toBeNull()
})

it('steps constitutions in one history entry and returns the last viewed card to Desk', async () => {
  workspace.dispose()
  bodyCards = [0, 1, 2, 3].map(i => ({ ...cards[0], id: `work/scan-${i}`, uid: `scan-${i}`, name: `Scan ${i}` }))
  const returned = vi.fn()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, deskRows: () => bodyCards,
    origin: () => 'Desk', onVisibility: visibility, onReturnCard: returned, dock: new Dock('', changed) })
  workspace.open(bodyCards[0], 'Desk'); await flush()
  const length = window.history.length
  for (let i = 1; i < bodyCards.length; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(`Scan ${i}`)
  }
  expect(window.history.length).toBe(length)
  await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(workspace.isActive).toBe(false)
  expect(returned).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: bodyCards[3].uid }))
})

it('does not rewrite unchanged names on show and writes a page selection once', async () => {
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot' }]
  workspace.open(bodyCards[0], 'Desk'); await flush()
  const replace = vi.spyOn(window.history, 'replaceState')
  const push = vi.spyOn(window.history, 'pushState')
  for (const runtimePhase of ['waiting', 'working'] as const) {
    bodyCards = [{ ...bodyCards[0], runtimePhase }]
    workspace.update(); await flush()
  }
  expect(replace).not.toHaveBeenCalled()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a')); await flush()
  expect(push).toHaveBeenCalledOnce()
  expect(replace).not.toHaveBeenCalled()
})

it('follows visited files after reload and returns a fresh deep link to its origin', async () => {
  workspace.open(cards[0], 'Desk'); await flush()
  const report = docKey('host-a', '/notes/alpha/report.html', 'host-a')
  const table = docKey('host-a', '/notes/alpha/table.html', 'host-a')
  workspace.reader.openDocument(report)
  workspace.reader.openDocument(table)
  const hash = window.location.hash
  workspace.dispose()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
  await flush()
  await pop(() => workspace.reader.back())
  expect(workspace.reader.document?.key).toBe(report)
  await pop(() => workspace.reader.back())
  expect(workspace.reader.document?.kind).toBe('fiber')
  workspace.dispose()
  window.history.replaceState(null, '', hash)
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
  await flush()
  workspace.reader.back()
  expect(workspace.isActive).toBe(false)
  expect(window.location.hash).toBe('#/board')
})

it('names the fiber page behind a file, and the constitution behind another channel', async () => {
  workspace.open(cards[0], 'Desk')
  await flush()
  expect(workspace.reader.document?.kind).toBe('fiber')
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
  await flush()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Constitution')
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/table.html', 'host-a'))
  await flush()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to report.html')
  workspace.open(cards[1]); await flush()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Alpha')
})

it('visits documents and retraces them without re-reading the channel or its receipt feed', async () => {
  workspace.open(cards[0], 'Desk'); await flush()
  const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/api\/v1\/(fibers\/|sent-files\?)/.test(String(url))).length
  const before = reads()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
  await flush()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/table.html', 'host-a'))
  await flush()
  await pop(() => workspace.reader.back())
  expect(workspace.reader.document?.name).toBe('report.html')
  expect(reads()).toBe(before)
})

describe('bar Find transcripts', () => {
  const hit = {
    session: 'b4edf873-cb1c-40ab-a891-f26f5333b321', harness: 'claude', project: '/work/alpha',
    path: '/transcripts/alpha.jsonl', line: 2, timestamp: '2026-10-20T14:41:00Z', role: 'assistant',
    score: 9, matches: 13, snippet: 'The «Alpha» result', fibers: [{ id: 'work/alpha', name: 'Alpha' }],
  }
  const setup = (): HTMLInputElement => {
    workspace.dispose()
    const find = document.createElement('input')
    document.body.append(find)
    bodyCards = [{ ...cards[0], shuttleKind: 'oneshot', shuttleAgent: 'claude-opus' }, cards[1]]
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed), find })
    return find
  }
  const type = (find: HTMLInputElement, text: string): void => {
    find.value = text
    find.dispatchEvent(new Event('input', { bubbles: true }))
    workspace.find(false)
  }
  const press = (el: HTMLElement, key: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }

  it('debounces, keeps constitutions first, and steps across into each excerpt\'s copy path', async () => {
    vi.useFakeTimers()
    const find = setup()
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify({ hits: [hit], errors: [] }))
      : original(input, init))
    type(find, 'Al')
    await vi.advanceTimersByTimeAsync(400)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/transcripts/search'))).toBe(false)
    type(find, 'Alpha')
    await vi.advanceTimersByTimeAsync(299)
    expect(document.querySelector('.ws-search-result')).toBeNull()
    await vi.advanceTimersByTimeAsync(1); await flush()
    const rows = [...document.querySelectorAll<HTMLElement>('.ws-switcher .ws-channel-row, .ws-switcher .ws-search-result button')]
    expect(rows).toHaveLength(2)
    expect(rows[0].classList.contains('ws-channel-row')).toBe(true)
    expect(rows[1].textContent).toBe('copy path')
    const result = document.querySelector<HTMLElement>('.ws-search-result')!
    expect(result.querySelector('mark')?.textContent).toBe('Alpha')
    expect(result.title).toBe('/transcripts/alpha.jsonl:2')
    expect(result.querySelector('.ws-search-meta')?.textContent).toContain('claude · b4edf873 · alpha')
    expect(result.querySelector('.ws-search-meta')?.textContent).toContain('13 matches')
    expect(document.querySelector('.ws-search-transcripts .kbn-flight-caption')?.textContent).toBe('Transcripts')
    press(find, 'ArrowDown'); expect(document.activeElement).toBe(rows[0])
    press(rows[0], 'ArrowDown'); expect(document.activeElement).toBe(rows[1])
    press(rows[1], 'ArrowUp'); expect(document.activeElement).toBe(rows[0])
  })

  it('opens nothing from an excerpt, and copies its location', async () => {
    vi.useFakeTimers()
    const find = setup()
    const copied = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify({ hits: [{ ...hit, matches: 1 }], errors: [] }))
      : original(input, init))
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(300); await flush()
    expect(document.querySelector('.ws-search-meta')?.textContent).toContain('1 match ·')
    document.querySelector<HTMLElement>('.ws-search-result')!.click(); await flush()
    expect(workspace.isActive).toBe(false)
    const copy = document.querySelector<HTMLButtonElement>('.ws-search-result button')!
    copy.click(); await flush()
    expect(copied).toHaveBeenCalledWith('/transcripts/alpha.jsonl:2')
    expect(copy.textContent).toBe('copied')
    expect(workspace.isActive).toBe(false)
  })

  it('never activates an excerpt from Enter in the field', async () => {
    vi.useFakeTimers()
    const find = setup()
    bodyCards = []
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify({ hits: [hit], errors: [] }))
      : original(input, init))
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(300); await flush()
    const copy = document.querySelector<HTMLButtonElement>('.ws-search-result button')!
    press(find, 'Enter'); await flush()
    expect(copy.textContent).toBe('copy path')
    expect(workspace.isActive).toBe(false)
  })

  it('aborts stale requests and hides late replies, including after closing', async () => {
    vi.useFakeTimers()
    const find = setup()
    const original = vi.mocked(fetch).getMockImplementation()!
    const requests: Array<{ signal: AbortSignal; resolve(response: Response): void }> = []
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/transcripts/search')
      ? new Promise(resolve => requests.push({ signal: init!.signal as AbortSignal, resolve }))
      : original(input, init))
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(300)
    type(find, 'Beta'); expect(requests[0].signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    requests[0].resolve(new Response(JSON.stringify({ hits: [hit], errors: [] }))); await flush()
    expect(document.querySelector('.ws-search-result')).toBeNull()
    workspace.closeFind(); expect(requests[1].signal.aborted).toBe(true)
    requests[1].resolve(new Response(JSON.stringify({ hits: [hit], errors: [] }))); await flush()
    expect(document.querySelector('.ws-switcher')).toBeNull()
  })

  it('shows one quiet failure and offers copy path for sessions with no board card', async () => {
    vi.useFakeTimers()
    const find = setup()
    const original = vi.mocked(fetch).getMockImplementation()!
    let fail = true
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify(fail ? { error: 'offline' } : { hits: [{ ...hit, fibers: [] }], errors: [] }), { status: fail ? 502 : 200 })
      : original(input, init))
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(300); await flush()
    expect(document.querySelector('.ws-search-note')?.textContent).toBe('Transcript search unavailable.')
    fail = false
    type(find, 'Alph'); await vi.advanceTimersByTimeAsync(300); await flush()
    expect(document.querySelector('.ws-search-note')).toBeNull()
    expect(document.querySelector('.ws-search-result button')?.textContent).toBe('copy path')
  })
})

describe('workspace reader integration', () => {
  it('s on the constitution page requests rest', async () => {
    workspace.dispose()
    const onRest = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed), onRest })
    const constitution = { ...cards[0], shuttleKind: 'oneshot' as const }
    bodyCards = [constitution]
    workspace.open(constitution); await flush(); await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }))
    expect(onRest).toHaveBeenCalledWith(expect.objectContaining({ uid: 'alpha' }), workspace.reader.el)
  })
  it('a Question leads with its report rather than a remembered file', async () => {
    const request = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/api/v1/file-info?')
      ? Response.json({ exists: true }) : request(input, init))
    const original = cards[0]; cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    workspace.open(cards[0]); await flush(); await flush()
    workspace.reader.openDocument(docKey('host-a', '/notes/alpha/table.html', 'host-a'))
    workspace.openQuestion(cards[0]); await flush(); await flush()
    expect(workspace.reader.document?.name).toBe('tapestry.html')
    expect(document.querySelector('.ws-report-inset')).toBeNull()
  })

  it('a Question on a constitution with threads never paints its map', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active', ask: { text: 'Which?', at: new Date().toISOString() } }), thread({ id: 'hub/a', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.openQuestion(feed[0])
    await Promise.resolve()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).not.toBe('family:host-a:hub')
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).not.toBe('family:host-a:hub')
  })

  it('a Question without a report opens its constitution', async () => {
    bodyOverrides.set('host-b:beta', 'A question without a report.')
    workspace.openQuestion(cards[1]); await flush(); await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-b:beta')
  })

  it('names the office the feed carries and repaints the page when it changes', async () => {
    const original = cards[0]
    const roles = (): string[] => [...document.querySelectorAll('.ws-fiber-role')].map(role => role.textContent ?? '')
    try {
      // The body read carries no office; the feed's card does.
      cards[0] = { ...original, shuttleRole: 'surveyor' }
      workspace.open(cards[0]); await flush(); await flush()
      expect(roles()).toEqual(['surveyor'])
      cards[0] = { ...original, shuttleRole: 'scribe' }
      workspace.update(); await flush()
      expect(roles()).toEqual(['scribe'])
      cards[0] = original
      workspace.update(); await flush()
      expect(roles()).toEqual([])
    } finally { cards[0] = original }
  })

  it('gives a role page its holds from the feed and none of a constitution\'s controls', async () => {
    const original = cards[0]
    const role = card({ id: 'roles/surveyor', uid: 'surveyor-uid', name: 'Surveyor', originId: 'host-a', fiberDir: '/roles/surveyor', path: 'roles/surveyor/surveyor.md' })
    cards[0] = { ...original, shuttleKind: 'oneshot', shuttleRole: 'surveyor' }
    bodyCards = [...cards, role]
    onTestFinished(() => { cards[0] = original })
    const holds = (): string[] => [...document.querySelectorAll('.ws-role-hold-name')].map(name => name.textContent ?? '')
    workspace.open(role); await flush(); await flush()
    expect(holds()).toEqual(['Alpha'])
    expect(document.querySelector<HTMLElement>('.ws-stage-band')?.hidden).toBe(true)
    expect(document.querySelector('[data-part="role-holders"]')).toBeNull()
    const page = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    for (const chrome of ['.ws-dock', '.kbn-detail-controls', '.kbn-ctl-history-toggle', '.kbn-detail-directive', '.kbn-ctl-verdict']) {
      expect(page.querySelector(chrome), chrome).toBeNull()
    }
    // A role is outside the feed; its holds still follow office assignments.
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    workspace.update(); await flush()
    expect(holds()).toEqual([])
    expect(document.querySelector('[data-part="role-holds"]')).toBeNull()
    cards[0] = { ...original, shuttleKind: 'oneshot', shuttleRole: 'surveyor' }
    workspace.update(); await flush()
    document.querySelector<HTMLButtonElement>('.ws-role-hold')!.click()
    await flush(); await flush()
    expect(document.querySelector('.ws-selected [data-part="fiber-title"]')?.textContent).toBe('Alpha')
    // The band stands over a constitution's pages; its fiber page holds no controls.
    expect(document.querySelector('.ws-stage-band .ws-dock')).not.toBeNull()
    expect(document.querySelector('.ws-fiber-prose .ws-dock')).toBeNull()
  })

  it('draws a key verdict in place of the pair, takes a click verdict after undo, and commits only the live identity after a move', async () => {
    workspace.dispose()
    const reviewing = card({ id: 'work/review', uid: 'stable-review', name: 'Review', originId: 'host-a',
      path: 'work/review/review.md', fiberDir: '/notes/review', status: 'closed', shuttleKind: 'oneshot' })
    let live = reviewing
    bodyCards = [reviewing]
    const commit = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [live], origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(reviewing); await flush()
    vi.useFakeTimers()
    const pair = document.querySelector<HTMLElement>('.ws-fiber-acts')!
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(pair.dataset.verdictPending).toBe('discarded')
    expect(pair.querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Discarded·undo z')
    vi.advanceTimersByTime(3000)
    pair.querySelector<HTMLButtonElement>('.ws-verdict-undo button')!.click()
    expect(pair.hasAttribute('data-verdict-pending')).toBe(false)
    pair.querySelector<HTMLButtonElement>('.kbn-ctl-temper')!.click()
    expect(commit).not.toHaveBeenCalled()
    expect(document.querySelectorAll('.ws-fiber-acts .ws-verdict-undo')).toHaveLength(1)
    expect(pair.querySelector('.ws-verdict-undo')?.textContent).toMatch(/^Tempered/)
    live = { ...reviewing, id: 'elsewhere/renamed', path: 'elsewhere/renamed/renamed.md', fiberDir: '/notes/renamed' }
    vi.advanceTimersByTime(3999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(commit).toHaveBeenCalledExactlyOnceWith(live, 'tempered')
    vi.useRealTimers()
  })
  it.each(['replacement', 'removed', 'other origin'])('drops a delayed verdict when its indexed identity is %s', async change => {
    workspace.dispose()
    const reviewing = card({ id: 'work/review', uid: 'UID-A', originId: 'host-a',
      status: 'closed', shuttleKind: 'oneshot' })
    let live = [reviewing]
    bodyCards = live
    const commit = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(reviewing); await flush()
    vi.useFakeTimers()
    workspace.queueVerdict(reviewing, 'composted')
    expect(document.querySelectorAll('.ws-fiber-acts .ws-verdict-undo')).toHaveLength(1)
    live = change === 'removed' ? [] : [{ ...reviewing,
      ...(change === 'replacement' ? { uid: 'UID-B' } : { originId: 'host-b' }) }]
    bodyCards = live
    vi.advanceTimersByTime(6000); await flush()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
    expect(commit).not.toHaveBeenCalled()
  })
  it('a moves in-flight or draft work to review through the shared verb after an undo window, z cancels, and it is inert elsewhere', async () => {
    workspace.dispose()
    const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    const open = async (fiber: KanbanCard, commit: (card: KanbanCard, target: ColumnKind) => void): Promise<HTMLElement> => {
      bodyCards = [fiber]
      workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [fiber], origin: () => 'Desk',
        onVisibility: visibility, dock: new Dock('', changed, commit) })
      workspace.open(fiber); await flush()
      return document.querySelector<HTMLElement>('.ws-fiber-acts')!
    }
    const flying = card({ id: 'work/fly', uid: 'fly-uid', name: 'Fly', originId: 'host-a', status: 'active',
      workerState: 'running', shuttleKind: 'oneshot', path: 'work/fly/fly.md', fiberDir: '/notes/fly' })
    const commit = vi.fn<(card: KanbanCard, target: ColumnKind) => void>()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const pair = await open(flying, commit)
    vi.useFakeTimers()
    press('a')
    expect(confirm).toHaveBeenCalledOnce()
    expect(pair.dataset.verdictPending).toBe('review')
    expect(pair.querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('To review·undo z')
    press('z')
    expect(pair.hasAttribute('data-verdict-pending')).toBe(false)
    vi.advanceTimersByTime(6000); await flush()
    expect(commit).not.toHaveBeenCalled()
    press('a')
    vi.advanceTimersByTime(3999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); await flush()
    expect(commit).toHaveBeenCalledExactlyOnceWith(flying, 'awaitingReview')
    // A declined worker stop queues nothing.
    vi.useRealTimers(); workspace.dispose(); document.body.replaceChildren()
    commit.mockClear(); confirm.mockReturnValue(false)
    await open(flying, commit); press('a')
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
    // Inert on work already awaiting review, and on a note.
    for (const fiber of [
      card({ id: 'work/done', uid: 'done-uid', name: 'Done', originId: 'host-a', status: 'closed', shuttleKind: 'oneshot', path: 'work/done/done.md', fiberDir: '/notes/done' }),
      card({ id: 'notes/plain', uid: 'plain-uid', name: 'Plain', originId: 'host-a', status: 'open', path: 'notes/plain/plain.md', fiberDir: '/notes/plain' }),
    ]) {
      workspace.dispose(); document.body.replaceChildren(); vi.useFakeTimers()
      await open(fiber, commit); press('a')
      expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
      vi.advanceTimersByTime(6000); await flush()
      expect(commit).not.toHaveBeenCalled()
      vi.useRealTimers()
    }
    confirm.mockRestore()
  })
  it('asks to stop a worker at gesture time and carries the answer to the delayed write', async () => {
    workspace.dispose()
    const app = card({ id: 'work/app', uid: 'app-uid', originId: 'host-a', status: 'active', shuttleKind: 'oneshot',
      workerState: 'running', tmuxSession: 'worker-shuttle', sessionUuid: 'thread-1' })
    let live = [app]
    bodyCards = live
    const commit = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(app); await flush()
    vi.useFakeTimers()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    workspace.queueVerdict(app, 'composted')
    expect(confirm).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
    confirm.mockReturnValue(true)
    workspace.queueVerdict(app, 'composted')
    expect(confirm).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(6000); await flush()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledExactlyOnceWith(app, 'composted')
    // A worker that starts during the undo window was never confirmed.
    const finished = card({ id: 'work/done', uid: 'done-uid', originId: 'host-a', status: 'open', shuttleKind: 'oneshot' })
    live = [finished]; commit.mockClear(); confirm.mockClear()
    workspace.queueVerdict(finished, 'tempered')
    expect(confirm).not.toHaveBeenCalled()
    live = [{ ...finished, status: 'active', workerState: 'running' }]
    vi.advanceTimersByTime(6000); await flush()
    expect(commit).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('has a worker now; verdict not written')
  })
  it.each(['same identity', 'replacement', 'missing'])('rechecks an off-index linked fiber against its owner: %s', async result => {
    workspace.dispose()
    const linked = card({ id: 'work/linked', uid: 'linked-uid', originId: 'host-a',
      status: 'closed', shuttleKind: 'oneshot' })
    bodyCards = [linked]
    const commit = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [], origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(linked); await flush()
    vi.useFakeTimers()
    workspace.queueVerdict(linked, 'tempered')
    const renamed = { ...linked, id: 'work/moved', path: 'work/moved/moved.md' }
    bodyCards = result === 'missing' ? [] : [result === 'replacement' ? { ...linked, uid: 'replacement-uid' } : renamed]
    vi.mocked(fetch).mockClear()
    vi.advanceTimersByTime(6000); await flush()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/v1/fibers/linked-uid?body=true&origin=host-a&routed=1'))).toBe(true)
    if (result === 'same identity') expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: linked.uid, id: renamed.id, originId: linked.originId }), 'tempered')
    else expect(commit).not.toHaveBeenCalled()
  })
  const reader = (): Reader => workspace.reader
  const walked = (): string[] => (reader() as unknown as { deskCards(): KanbanCard[] }).deskCards().map(row => row.uid ?? row.id)
  const landed = (): string | null | undefined => document.querySelector('.shuttle-toast .toast-message')?.textContent
  const titled = (): string | null | undefined => document.querySelector('.ws-channel-title')?.textContent
  const step = async (key: string): Promise<void> => { document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key !== key.toLowerCase(), bubbles: true, cancelable: true })); await flush() }
  it('steps the Desk with j/k wherever it opens', async () => {
    workspace.dispose()
    const returned = vi.fn()
    const grouped = [{ ...cards[0], status: 'closed', column: 'awaitingReview' as const }, { ...cards[1], status: 'active', column: 'inFlight' as const }]
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => grouped, origin: () => 'Board', onVisibility: visibility,
      deskRows: () => [grouped[1], grouped[0]], onReturnCard: returned, dock: new Dock('', changed),
    })
    workspace.open(grouped[0], 'Board'); await flush()
    expect(walked()).toEqual(['beta', 'alpha'])
    await step('k')
    expect(titled()).toBe('Beta')
    await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(workspace.isActive).toBe(false)
    expect(returned).not.toHaveBeenCalled()
  })
  it('walks In flight\'s bands as one flow with j/k, and stops J/K at each column', async () => {
    workspace.dispose()
    const flight = (uid: string, runtimePhase?: KanbanCard['runtimePhase']): KanbanCard =>
      ({ ...cards[1], id: `work/${uid}`, uid, name: uid, path: `work/${uid}/${uid}.md`, status: 'active', column: 'inFlight', turn: TURN_OF_PHASE[runtimePhase ?? ''] ?? 'no-signal', workerState: 'running', runtimePhase })
    const feed = [{ ...cards[0], status: 'closed', column: 'awaitingReview' as const }, flight('w1', 'working'), flight('n1', 'waiting'), flight('w2', 'working'), flight('n2', 'blocked'), { ...cards[1], uid: 'draft', id: 'work/draft', name: 'draft' }]
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, deskRows: () => [feed[5], feed[2], feed[4], feed[1], feed[3], feed[0]], origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[0], 'Desk'); await flush()
    expect(walked()).toEqual(['draft', 'n1', 'n2', 'w1', 'w2', 'alpha'])
    await step('K'); expect(titled()).toBe('n1')
    await step('j'); expect(titled()).toBe('n2')
    // Off the end of one band, j goes on into the next, and on across columns.
    await step('j'); expect(titled()).toBe('w1')
    await step('K'); expect(titled()).toBe('draft')
    await step('j'); expect(titled()).toBe('n1')
    await step('k'); expect(titled()).toBe('draft')
    await step('J'); expect(titled()).toBe('n1')
    await step('J'); expect(titled()).toBe('Alpha')
    await step('K'); expect(titled()).toBe('n1')
  })
  it('keeps an off-Desk thread beside its family\'s Desk row, in that row\'s column', async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const raw = [
      thread({ id: 'draft', status: 'open' }),
      thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'hub/sub', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'settled', status: 'closed', tempered: true }),
      thread({ id: 'settled/ask', orchestrator: 'settled', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }),
      thread({ id: 'review', status: 'closed' }),
    ]
    const index = new ThreadIndex(raw)
    const feed = raw.map(c => ({ ...c, threadSummary: index.summary(c) }))
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, deskRows: () => [feed[0], feed[4], feed[1], feed[5]], threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[2], 'Desk'); await flush()
    expect(walked()).toEqual(['draft', 'settled-ask', 'hub', 'hub-sub', 'review'])
    await step('k')
    expect(landed()).toBe('In flight · hub')
    workspace.open(feed[3], 'Desk'); await flush()
    expect(walked()).toEqual(['draft', 'settled-ask', 'settled', 'hub', 'review'])
    await step('j')
    expect(landed()).toBe('In flight · hub')
    await step('J')
    expect(landed()).toBe('Awaiting review · review')
  })
  it("leads a thread up its ancestry, by the band's trail and by b", async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', path: `${over.id}.md`, ...over })
    const feed = [
      thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'hub/sub', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'hub/sub/leaf', orchestrator: 'hub-sub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
    ]
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const title = (): string | null | undefined => document.querySelector('.ws-stage-band .ws-band-title')?.textContent
    workspace.open(feed[0], 'Desk'); await flush()
    expect(title()).toBe('hub')
    expect(document.querySelector('.ws-band-head button[aria-label="Settings"]')).not.toBeNull()
    // A root has no orchestrator: no way back on its line, and b does nothing.
    expect(document.querySelector<HTMLElement>('.ws-stage-band .ws-settings-ancestry')?.hidden).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    await flush()
    expect(title()).toBe('hub')
    workspace.open(feed[1], 'Desk'); await flush()
    expect(title()).toBe('hub/sub')
    const links = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-stage-band .ws-settings-ancestry .ws-ancestry-link')]
    expect(links().map(b => b.textContent)).toEqual(['hub'])
    links()[0].click(); await flush()
    expect(title()).toBe('hub')
    workspace.open(feed[2], 'Desk'); await flush()
    expect(links().map(b => b.textContent)).toEqual(['hub', 'hub/sub'])
    links()[0].click(); await flush()
    expect(title()).toBe('hub')
    workspace.open(feed[1], 'Desk'); await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true, cancelable: true }))
    await flush()
    expect(title()).toBe('hub')
  })
  it('opens the sheet of sent files from the toggle, newest first', async () => {
    workspace.open(cards[0], 'Desk'); await flush()
    const toggle = document.querySelector<HTMLButtonElement>('.ws-files-toggle')!
    expect(toggle.hidden).toBe(false)
    const showModal = vi.fn()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true })
    try {
      toggle.click()
      expect(showModal).toHaveBeenCalledOnce()
      const rows = [...document.querySelectorAll<HTMLButtonElement>('.ws-page-sheet [data-part="page-sheet-row"]')]
      expect(rows.map(row => row.dataset.key)).toEqual(['host-a:/notes/alpha/table.html', 'host-a:/notes/alpha/report.html'])
    } finally { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal') }
  })
  it('hides the toggle for a constitution with no sent files, and answers the menu with the empty sheet', async () => {
    workspace.open(cards[1], 'Desk'); await flush()
    expect(document.querySelector<HTMLElement>('.ws-files-toggle')!.hidden).toBe(true)
    const showModal = vi.fn()
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { value: showModal, configurable: true })
    try {
      workspace.reader.showSentFiles()
      expect(showModal).toHaveBeenCalledOnce()
    } finally { Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal') }
  })
  it('routes lifecycle keys, console verbs and the worker line to the highlighted thread', async () => {
    workspace.dispose()
    const hub = card({ id: 'hub', uid: 'hub', originId: 'host-a', name: 'Hub', status: 'closed', shuttleKind: 'oneshot' })
    const leaf = card({ id: 'hub/notch', uid: 'notch', originId: 'host-a', name: 'Notch', orchestrator: 'hub', status: 'active', shuttleKind: 'oneshot', sessionUuid: 'notch-session' })
    const feed = [hub, leaf], onRest = vi.fn(), dock = new Dock('', changed, undefined, undefined, { onRest })
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock, onRest })
    const queue = vi.spyOn(workspace, 'queueVerdict').mockReturnValue(true)
    workspace.open(hub, 'Desk'); await flush()
    const row = document.querySelector<HTMLElement>('.ws-selected .fp-row:not(.fp-head)')!
    document.querySelector<HTMLElement>('.ws-selected .fp-head')!.focus()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('.ws-band-title')?.textContent).toBe('Hub')
    const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    press('a'); expect(queue).toHaveBeenLastCalledWith(leaf, 'awaitingReview')
    press('x'); expect(queue).toHaveBeenLastCalledWith(leaf, 'composted')
    press('t'); expect(queue).toHaveBeenLastCalledWith(leaf, 'tempered')
    press('s'); expect(onRest).toHaveBeenLastCalledWith(leaf, workspace.reader.el)
    const rest = document.querySelector<HTMLButtonElement>('.ws-stage-band .kbn-ctl-rest')!
    expect(rest.title).toBe('Rest notch (s)')
    rest.click(); expect(onRest).toHaveBeenLastCalledWith(leaf, rest)
    document.querySelector<HTMLButtonElement>('.ws-stage-band .kbn-ctl-review')!.click()
    expect(queue).toHaveBeenLastCalledWith(leaf, 'awaitingReview')
    const primary = document.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    expect(primary.getAttribute('aria-label')).toBe('Resume Notch')
    primary.click(); await flush()
    const dispatch = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/v1/dispatch'))!
    expect(JSON.parse(String(dispatch[1]!.body))).toMatchObject({ fiber_id: 'hub/notch', resume_mode: 'previous' })
    document.querySelector<HTMLElement>('.ws-selected .fp-head')!.click()
    press('x'); expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'hub' }), 'composted')
    expect(document.querySelector<HTMLButtonElement>('.ws-stage-band .kbn-ctl-discard')!.title).toBe('Discard (x)')
  })
  it('uses the page card at the head, and sends to a highlighted live worker', async () => {
    workspace.dispose()
    const hub = card({ id: 'hub', uid: 'hub', originId: 'host-a', name: 'Hub', status: 'active', shuttleKind: 'oneshot' })
    const leaf = card({ id: 'hub/leaf', uid: 'leaf', originId: 'host-a', name: 'Leaf', orchestrator: 'hub', status: 'active', shuttleKind: 'oneshot', sessionUuid: 'session', workerState: 'running' })
    const sibling = card({ id: 'hub/other', uid: 'other', originId: 'host-a', name: 'Other', orchestrator: 'hub', status: 'active', shuttleKind: 'oneshot', sessionUuid: 'other-session', workerState: 'running' })
    const feed = [hub, leaf, sibling], dock = new Dock('', changed)
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock })
    const queue = vi.spyOn(workspace, 'queueVerdict').mockReturnValue(true)
    const conversation = vi.spyOn(dock, 'openConversation').mockReturnValue(true)
    workspace.open(leaf, 'Desk'); await flush()
    document.querySelector<HTMLElement>('.ws-selected .fp-head')!.click()
    const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    press('x'); expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'leaf' }), 'composted')
    press('c'); expect(conversation).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'leaf' }))
    const other = [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(row => row.querySelector<HTMLElement>('.fp-name')?.title === 'Other')!
    other.click()
    const input = document.querySelector<HTMLInputElement>('.ws-worker-message')!
    input.value = 'Hello'; input.dispatchEvent(new Event('input'))
    const send = document.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    expect(send.getAttribute('aria-label')).toBe('Send Other')
    send.click(); await flush()
    const dispatch = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/v1/dispatch'))!
    expect(JSON.parse(String(dispatch[1]!.body))).toMatchObject({ fiber_id: 'hub/other', user_message: 'Hello', resume_mode: 'previous' })
    expect(document.querySelector('.ws-band-title')?.textContent).toBe('Leaf')
  })
  it('row verbs select their thread without unfolding it and share the undo queue', async () => {
    workspace.dispose()
    const hub = card({ id: 'hub', uid: 'hub', originId: 'host-a', status: 'active', shuttleKind: 'oneshot' })
    const leaf = card({ id: 'hub/notch', uid: 'notch', originId: 'host-a', orchestrator: 'hub', status: 'closed', shuttleKind: 'oneshot' })
    const feed = [hub, leaf], commit = vi.fn(), onRest = vi.fn()
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed, commit, undefined, { onRest }), onRest })
    workspace.open(hub, 'Desk'); await flush()
    const row = document.querySelector<HTMLElement>('.ws-selected .fp-row:not(.fp-head)')!
    const discard = row.querySelector<HTMLButtonElement>('.fp-verbs .kbn-ctl-discard')!
    expect(discard.title).toBe('Discard notch (x)')
    vi.useFakeTimers()
    discard.click()
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.ws-fiber-acts .ws-verdict-undo')).not.toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true }))
    vi.advanceTimersByTime(6000)
    expect(commit).not.toHaveBeenCalled()
    discard.click(); vi.advanceTimersByTime(4000)
    expect(commit).toHaveBeenCalledExactlyOnceWith(leaf, 'composted')
  })
  it('lands a family\'s constitution on its page, first in its run, a leaf thread there too at its unfolded row, and one outside a family on its own page', async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/leaf', orchestrator: 'hub', status: 'active' }), thread({ id: 'lone', status: 'active' })]
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const pages = (): (string | null)[] => [...document.querySelectorAll('.ws-page')].map(page => page.getAttribute('data-key'))
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined

    workspace.open(feed[0], 'Desk'); await flush()
    expect(selected()).toBe('family:host-a:hub')
    expect(pages()[0]).toBe('family:host-a:hub')
    expect(document.querySelector('.ws-selected .fp-head[data-current] .fp-name')?.textContent).toBe('hub')

    workspace.open(feed[1], 'Desk'); await flush()
    expect(selected()).toBe('family:host-a:hub-leaf')
    expect(pages().indexOf('family:host-a:hub-leaf')).toBeLessThan(pages().indexOf('fiber:host-a:hub-leaf'))
    expect(chosen()).toBe('hub/leaf')
    expect(row('hub/leaf').getAttribute('aria-expanded')).toBe('true')
    expect(row('hub/leaf').hasAttribute('data-current')).toBe(true)

    workspace.open(feed[2], 'Desk'); await flush()
    expect(selected()).toBe('family:host-a:lone')
    expect(workspace.familyDocument(card({ id: 'note', originId: 'host-a' }))).toBeUndefined()
  })
  it('returns to the page with its selection, folds, focus and scroll where they were', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const waiting = { status: 'active', workerState: 'running', runtimePhase: 'waiting' } as const
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/a', orchestrator: 'hub', ...waiting, lastActivityAt: Date.now() }), thread({ id: 'hub/b', orchestrator: 'hub', ...waiting, lastActivityAt: Date.now() - 1000 })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined
    workspace.open(feed[0], 'Desk'); await flush()
    const scroller = (): HTMLElement => document.querySelector<HTMLElement>('.ws-selected .ws-family-scroll')!
    const key = (name: string): void => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) }
    for (let n = 0; n < 8 && chosen() !== 'hub/b'; n++) key('j')
    expect(chosen()).toBe('hub/b')
    key('Enter'); await flush()
    expect(row('hub/b').getAttribute('aria-expanded')).toBe('true')
    scroller().scrollTop = 333
    scroller().dispatchEvent(new Event('scroll'))
    expect(document.querySelector('.ws-stage-band .ws-band-title')?.textContent).toBe('hub')
    workspace.open(feed[1], 'Desk', 'fiber:host-a:hub-a'); await flush()
    expect(document.querySelector('.ws-stage-band .ws-band-title')?.textContent).toBe('hub/a')
    workspace.open(feed[0], 'Desk'); await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('family:host-a:hub')
    expect(chosen()).toBe('hub/b')
    expect(row('hub/b').getAttribute('aria-expanded')).toBe('true')
    expect(scroller().scrollTop).toBe(333)
    expect(document.activeElement).toBe(row('hub/b'))
  })
  it('unfolds a row in place, follows Rex deeper, and goes Back off the page at once', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), thread({ id: 'hub/mid/leaf', orchestrator: 'hub-mid', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined
    workspace.open(feed[0], 'Desk'); await flush()
    expect(selected()).toBe('family:host-a:hub')
    row('hub/mid').click(); await flush()
    expect(selected()).toBe('family:host-a:hub')
    expect(document.querySelector('.ws-stage-band .ws-band-title')?.textContent).toBe('hub')
    expect(chosen()).toBe('hub/mid')
    expect(row('hub/mid/leaf')).toBeDefined()
    row('hub/mid').click(); await flush()
    expect(row('hub/mid/leaf')).toBeUndefined()
    workspace.follow('hub-mid-leaf', 'host-a'); await flush()
    expect(chosen()).toBe('hub/mid/leaf')
    expect(row('hub/mid').getAttribute('aria-expanded')).toBe('true')
    const leave = vi.spyOn(window.history, 'back')
    workspace.reader.back()
    expect(leave).toHaveBeenCalledOnce()
    await flush()
  })
  it('lands a Desk click on the page at its thread, even after reading a file there, and a draft on its own page', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), thread({ id: 'hub/draft', orchestrator: 'hub', status: 'open' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined
    workspace.open(feed[1], 'Desk', 'fiber:host-a:hub-mid'); await flush()
    expect(selected()).toBe('fiber:host-a:hub-mid')
    workspace.openFromDesk(feed[1]); await flush()
    expect(selected()).toBe('family:host-a:hub-mid')
    expect(chosen()).toBe('hub/mid')
    workspace.openFromDesk(feed[0]); await flush()
    expect(selected()).toBe('family:host-a:hub')
    expect(chosen()).toBe('hub')
    workspace.openFromDesk(feed[2]); await flush()
    expect(selected()).toBe('fiber:host-a:hub-draft')
  })
  it('follows Rex into a family without revealing back: comes to its row, lands on another family\'s page, and stands on a page of the same channel', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), thread({ id: 'other', status: 'active' }), thread({ id: 'other/kid', orchestrator: 'other', status: 'active' }), thread({ id: 'lone', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    const dock = new Dock('', changed), conversation = vi.spyOn(dock, 'openConversation')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined
    workspace.open(feed[0], 'Desk'); await flush()
    workspace.follow('hub-mid', 'host-a'); await flush()
    expect(selected()).toBe('family:host-a:hub')
    expect(chosen()).toBe('hub/mid')
    expect(row('hub/mid').hasAttribute('data-worker')).toBe(true)
    workspace.follow('other-kid', 'host-a'); await flush()
    expect(selected()).toBe('family:host-a:other-kid')
    expect(chosen()).toBe('other/kid')
    workspace.open(feed[3], 'Desk', 'fiber:host-a:other-kid'); await flush()
    workspace.follow('other-kid', 'host-a'); await flush()
    expect(selected()).toBe('fiber:host-a:other-kid')
    workspace.follow('lone', 'host-a'); await flush()
    expect(document.querySelector('.ws-stage-band .ws-band-title')?.textContent).toBe('lone')
    expect(selected()).toBe('family:host-a:lone')
    expect(conversation).not.toHaveBeenCalled()
  })
  it('opens the page a session asks for: its constitution, its tapestry, or its row on the family page', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, fiberDir: `/notes/${over.id}`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?')
      ? Response.json({ exists: new URL(String(input), 'http://workspace.test').searchParams.get('path') === '/notes/hub/mid/tapestry.html' })
      : original(input, init))
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    await workspace.openFiber('hub-mid', 'host-a', 'constitution'); await flush()
    expect(selected()).toBe('fiber:host-a:hub-mid')
    await workspace.openFiber('hub-mid', 'host-a', 'tapestry'); await flush()
    expect(selected()).toBe(docKey('host-a', '/notes/hub/mid/tapestry.html', 'host-a', '/notes/hub/mid'))
    await workspace.openFiber('hub-mid', 'host-a', 'files'); await flush()
    expect(selected()).toBe('family:host-a:hub-mid')
    expect(document.querySelector('.ws-selected .fp-row[aria-selected="true"]')?.hasAttribute('data-open')).toBe(true)
  })

  it.each([
    [['report.html'], 'report.html'],
    [['artifact.html', 'report.html'], 'artifact.html'],
    [['tapestry.html', 'artifact.html', 'report.html'], 'tapestry.html'],
  ])('opens the first existing companion from %j', async (files, expected) => {
    const thread = card({ id: 'report-only', uid: 'report-only', originId: 'host-a', fiberDir: '/notes/report-only', path: 'report-only/report-only.md' })
    bodyCards = [thread]
    bodyOverrides.set('host-a:report-only', 'No embedded or sent files.')
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://workspace.test')
      if (url.pathname === '/api/v1/file-info') {
        return Response.json({ exists: files.some(file => url.searchParams.get('path') === `/notes/report-only/${file}`) })
      }
      return original(input, init)
    })
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [thread], origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    await workspace.openFiber('report-only', 'host-a', 'tapestry'); await flush()
    expect(workspace.reader.document?.key).toBe(docKey('host-a', `/notes/report-only/${expected}`, 'host-a'))
    expect(workspace.reader.document?.name).toBe(expected)
  })

  it('does not open a companion after navigation moves on while its owner is answering', async () => {
    const thread = card({ id: 'slow-pin', uid: 'slow-pin', originId: 'host-a', fiberDir: '/notes/slow-pin', path: 'slow-pin/slow-pin.md' })
    bodyCards = [thread, ...cards]
    let answer!: (response: Response) => void
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), 'http://workspace.test')
      if (url.pathname === '/api/v1/file-info' && url.searchParams.get('path') === '/notes/slow-pin/tapestry.html') {
        return new Promise<Response>(resolve => { answer = resolve })
      }
      return original(input, init)
    })
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [thread, ...cards], origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const pending = workspace.openFiber('slow-pin', 'host-a', 'tapestry')
    await flush()
    expect(answer).toBeDefined()
    workspace.open(cards[0], 'Desk'); await flush()
    const route = window.location.hash
    expect(route).toContain('alpha@host-a')
    answer(Response.json({ exists: true }))
    await pending; await flush()
    expect(window.location.hash).toBe(route)
  })

  it('moves Rex quietly on a click that unfolds a row at any depth, and not on folding, keys or the way out', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, sessionUuid: `session-${over.id}`, tmuxSession: `worker-${over.id}`, workerState: 'running', ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), thread({ id: 'hub/mid/leaf', orchestrator: 'hub-mid', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    const dock = new Dock('', changed), conversation = vi.spyOn(dock, 'openConversation')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock })
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    workspace.openFromDesk(feed[0]); await flush()
    expect(selections()).toEqual([{ tmux_session: 'worker-hub', shuttle_host: null, select_only: true }])
    row('hub/mid').click()
    row('hub/mid/leaf').click()
    expect(selections().map(selection => selection.tmux_session)).toEqual(['worker-hub', 'worker-hub/mid', 'worker-hub/mid/leaf'])
    row('hub/mid/leaf').click()
    row('hub/mid/leaf').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))
    row('hub/mid').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(row('hub/mid/leaf')).toBeUndefined()
    vi.spyOn(window.history, 'back').mockImplementation(() => {})
    workspace.reader.back(); await flush()
    expect(selections()).toHaveLength(3)
    expect(conversation).not.toHaveBeenCalled()
  })
  it('goes where Rex went from the Desk, another family or a lone body, and never writes back', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, sessionUuid: `session-${over.id}`, ...over })
    const remote = thread({ id: 'far', originId: 'host-b', status: 'active' })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), remote]
    bodyCards = feed
    workspace.dispose()
    const dock = new Dock('', changed), conversation = vi.spyOn(dock, 'openConversation').mockReturnValue(true), sight = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, onSight: sight, dock })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    expect(workspace.isActive).toBe(false)
    workspace.follow('hub-mid', 'host-a'); await flush()
    expect(workspace.isActive).toBe(true)
    expect(selected()).toBe('family:host-a:hub-mid')
    workspace.follow('far', 'host-b'); await flush()
    expect(selected()).toBe('family:host-b:far')
    expect(sight.mock.lastCall?.[0].id).toBe('far')
    expect(conversation).not.toHaveBeenCalled()
  })
  it('reaches a thread from a view that stays in place: Rex selects the window its worker has, voice goes with it, and nothing opens', async () => {
    const worker = card({ id: 'hub', uid: 'hub', originId: 'host-a', shuttleHost: 'host-a', shuttleKind: 'oneshot', status: 'active', sessionUuid: 'session-hub', tmuxSession: 'worker-hub', workerState: 'running' })
    const past = card({ id: 'done', originId: 'host-a', status: 'closed', sessionUuid: 'session-done' })
    workspace.dispose()
    const dock = new Dock('', changed), conversation = vi.spyOn(dock, 'openConversation'), sight = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [worker, past], origin: () => 'Globe', onVisibility: visibility, onSight: sight, dock })
    const answer = (moved: boolean): void => {
      const original = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (input, init) => String(input).endsWith('/api/v1/attach') ? Response.json({ moved, session: 'worker-hub' }) : original(input, init))
    }
    answer(true)
    expect(await workspace.reach(worker)).toBe(true)
    expect(selections()).toEqual([{ tmux_session: 'worker-hub', shuttle_host: 'host-a', select_only: true }])
    expect(sight).toHaveBeenLastCalledWith(worker)
    answer(false)
    expect(await workspace.globeHost.converse(worker)).toBe(false)
    expect(await workspace.globeHost.converse(past)).toBe(false)
    expect(selections()).toHaveLength(2)
    expect(sight).toHaveBeenLastCalledWith(past)
    expect(conversation).not.toHaveBeenCalled()
  })
  it('tells voice what it shows: the thread the page has selected, the page elsewhere, and moves Rex quietly from a click', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, sessionUuid: `session-${over.id}`, tmuxSession: `worker-${over.id}`, workerState: 'running', ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    const dock = new Dock('', changed), sight = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, onSight: sight, dock })
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const seen = (): string | undefined => (sight.mock.lastCall?.[0] as KanbanCard | undefined)?.id
    workspace.openFromDesk(feed[0]); await flush()
    expect(seen()).toBe('hub')
    expect(selections().at(-1)?.tmux_session).toBe('worker-hub')
    row('hub/mid').click()
    expect(seen()).toBe('hub/mid')
    expect(selections().at(-1)?.tmux_session).toBe('worker-hub/mid')
    row('hub').click()
    expect(seen()).toBe('hub')
    workspace.open(feed[1], 'Desk', 'fiber:host-a:hub-mid'); await flush()
    expect(seen()).toBe('hub/mid')
  })
  it('draws a lone constitution as its head with what it holds, and a draft on its own page', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'lone', status: 'active' }), thread({ id: 'draft', status: 'open' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.openFromDesk(feed[0]); await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('family:host-a:lone')
    expect(document.querySelectorAll('.ws-selected .fp-row')).toHaveLength(1)
    expect(document.querySelector('.ws-selected .fp-head .fp-constitution')).not.toBeNull()
    workspace.openFromDesk(feed[1]); await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-a:draft')
  })
  it('toggles the selected thread\'s lead inline on the family page', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active', fiberDir: '/notes/hub' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?')
      ? Response.json({ exists: new URL(String(input), 'http://workspace.test').searchParams.get('path') === '/notes/hub/report.html' })
      : original(input, init))
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const press = async (): Promise<void> => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true })); await flush() }
    workspace.open(feed[0], 'Desk'); await flush()
    await press()
    expect(selected()).toBe('family:host-a:hub')
    expect(document.querySelector<HTMLElement>('.ws-selected .fp-head .fp-doc')!.hidden).toBe(false)
    expect(document.querySelector<HTMLIFrameElement>('.ws-selected .fp-head .fp-doc iframe')!.title).toBe('/notes/hub/report.html')
    await press()
    expect(selected()).toBe('family:host-a:hub')
    expect(document.querySelector<HTMLElement>('.ws-selected .fp-head .fp-doc')!.hidden).toBe(true)
    workspace.follow('hub-mid', 'host-a'); await flush()
    await press()
    expect(selected()).toBe('family:host-a:hub')
    expect(document.querySelector<HTMLElement>('.ws-selected .fp-row[aria-selected="true"] .fp-doc')!.hidden).toBe(true)
  })
  it('returns from the Desk with a thread\'s document still unfolded, and h folds it before leaving', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const doc = (): HTMLElement => document.querySelector<HTMLElement>('.ws-selected .fp-row[data-row$="hub/mid"] .fp-doc')!
    const selected = (): HTMLElement => document.querySelector<HTMLElement>('.ws-selected .fp-row[aria-selected="true"]')!
    const press = async (key: string): Promise<void> => { selected().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await flush() }
    workspace.openFromDesk(feed[0]); await flush()
    await press('j'); await press('l')
    expect(doc().hidden).toBe(false)
    await pop(() => workspace.returnToOrigin())
    expect(workspace.isActive).toBe(false)
    workspace.openFromDesk(feed[0]); await flush()
    expect(workspace.isActive).toBe(true)
    expect(selected().classList.contains('fp-head')).toBe(true)
    expect(doc().hidden).toBe(false)
    await press('h')
    expect(workspace.isActive).toBe(true)
    expect(doc().hidden).toBe(true)
    await press('h')
    expect(workspace.isActive).toBe(false)
  })
  it('leaves Download and Refresh off the map\'s document menu', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/a', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[0], 'Desk'); await flush()
    document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!.click()
    const items = [...document.querySelectorAll('.ws-menu .ws-menu-item')].map(item => item.textContent)
    expect(items).toContain('Copy path')
    expect(items).not.toContain('Download')
    expect(items).not.toContain('Refresh')
  })
  it('unfolds a family row on a page that was one constitution until the family formed', async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', path: `${over.id}.md`, ...over })
    const hub = thread({ id: 'hub', status: 'active' }), leaf = thread({ id: 'hub/leaf', orchestrator: 'hub', status: 'active' })
    let feed = [hub]
    bodyCards = [hub, leaf]
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const row = (name: string): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-selected .fp-row')].find(el => el.querySelector<HTMLElement>('.fp-name')?.title === name)!
    const chosen = (): string | undefined => document.querySelector('.ws-selected .fp-row[aria-selected="true"] .fp-name')?.getAttribute('title') ?? undefined
    workspace.open(hub, 'Desk'); await flush()
    expect(selected()).toBe('family:host-a:hub')
    feed = [hub, leaf]
    workspace.update(); await flush()
    expect(selected()).toBe('family:host-a:hub')
    row('hub/leaf').click(); await flush()
    expect(selected()).toBe('family:host-a:hub')
    expect(chosen()).toBe('hub/leaf')
    expect(row('hub/leaf').getAttribute('aria-expanded')).toBe('true')
  })
  it('steps the columns of the Desk projection, including scheduled work in Resting', async () => {
    workspace.dispose()
    const draft = card({ id: 'desk/draft', shuttleKind: 'oneshot' })
    const turn = card({ id: 'desk/turn', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'waiting' })
    const working = card({ id: 'desk/working', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'working' })
    const review = card({ id: 'desk/review', status: 'closed', shuttleKind: 'oneshot' })
    const seat = card({ id: 'roles/editor', status: 'open', shuttleKind: 'standing', shuttleRole: 'editor', shuttleSeat: true })
    const stashed = card({ id: 'desk/stashed', shuttleKind: 'oneshot', effectiveHorizon: 'stashed' })
    const scheduled = card({ id: 'roles/scheduled', status: 'active', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', nextLaunchAt: '2026-10-30T09:00:00Z' })
    const projection = projectDeskFrontier(boardResponse({
      now: { drafts: [draft], inFlight: [turn, working], awaitingReview: [review] },
      roles: [seat], stash: [stashed], timeline: { past: [], futureDated: [scheduled] },
    }))
    const rows = deskOrder(projection).rows
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => [...rows], deskRows: () => rows,
      threadIndex: () => new ThreadIndex(rows), origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed),
    })
    workspace.open(rows[0], 'Desk'); await flush()
    expect(walked()).toEqual(rows.map(row => row.uid ?? row.id))
    const columns: string[] = []
    for (let n = 0; n < 4; n++) { await step('J'); columns.push(landed()!.split(' · ')[0]) }
    expect(columns).toEqual(['In flight', 'Awaiting review', 'Resting', 'Roles'])
  })
  it('indexes fleet filenames on a cold Desk and refreshes an open picker without entering Reader', async () => {
    workspace.dispose()
    document.body.replaceChildren()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(fetch).mockClear()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const previous = document.createElement('button')
    document.body.append(previous); previous.focus()
    const route = window.location.hash
    workspace.findConstitution()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe(route)
    const find = document.querySelector<HTMLInputElement>('.ws-switcher input')!
    expect(document.activeElement).toBe(find)
    find.value = 'table.html'; find.dispatchEvent(new Event('input'))
    expect(document.querySelectorAll('.ws-switcher .ws-channel-row')).toHaveLength(0)
    await flush()
    expect(document.querySelectorAll('.ws-switcher .ws-channel-row')).toHaveLength(1)
    expect(document.activeElement).toBe(find)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/sent-files/all/'))).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/v1/fibers/'))).toBe(false)
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(previous)
    expect(document.querySelector('.ws-switcher')).toBeNull()
    workspace.findConstitution()
    const input = document.querySelector<HTMLInputElement>('.ws-switcher input')!
    const reads = vi.mocked(fetch).mock.calls.length
    input.value = 'table.html'; input.dispatchEvent(new Event('input'))
    expect(vi.mocked(fetch).mock.calls.length).toBe(reads)
    expect(document.querySelectorAll('.ws-switcher .ws-channel-row')).toHaveLength(1)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await flush()
    expect(workspace.isActive).toBe(true)
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('Alpha')
  })
  for (const [routed, landing] of [['the report the Board feed names', 'report.html'], ['a sent file opened by address', 'table.html']] as const) {
    it(`shows only the selected page until the body lands after ${routed}, then the strip in its final order`, async () => {
      if (landing === 'report.html') await feedNamesReport()
      const original = vi.mocked(fetch).getMockImplementation()!
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        if (String(input).includes('/api/v1/fibers/')) await gate
        return original(input, init)
      })
      const key = docKey('host-a', `/notes/alpha/${landing}`, 'host-a')
      workspace.open(cards[0], 'Desk', landing === 'report.html' ? undefined : key); await flush()
      const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
      // Before the body, the selected page shows; the strip and ticks wait unseen, and stepping does nothing.
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      expect(workspace.reader.el.querySelector('.ws-tabs,.ws-page-ticks')).toBeNull()
      for (const press of ['G', 'l']) document.dispatchEvent(new KeyboardEvent('keydown', { key: press, bubbles: true, cancelable: true }))
      await flush()
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      release(); await flush(); await flush()
      expect(selected()).toBe(key)
      expect(workspace.reader.el.querySelector('.ws-tabs,.ws-page-ticks')).toBeNull()
      await pop(() => workspace.reader.back())
      expect(workspace.isActive).toBe(false)
      expect(selected()).toBe(key)
    })
  }
  it('shows the body as soon as it lands while the strip waits for the receipts, then the strip in its final order', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/api/v1/sent-files?')) await gate
      return original(input, init)
    })
    workspace.open(cards[0]); await flush(); await flush()
    const prose = (): string => document.querySelector('.ws-prose')?.textContent ?? ''
    // The body is in hand: its prose shows and the loading note is gone, while the run waits.
    expect(prose()).toContain('The result is ready.')
    expect(document.querySelector('.ws-body-status')).toBeNull()
    expect(workspace.reader.el.querySelector('.ws-tabs,.ws-page-choice')).toBeNull()
    workspace.update(); await flush()
    release(); await flush(); await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-a:alpha')
    expect(workspace.reader.host.get(docKey('host-a', '/notes/alpha/table.html', 'host-a'))).toBeDefined()
  })
  it('holds a sent page opened by address between the channel\'s body and its receipts', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).includes('/api/v1/sent-files?')) await gate
      return original(input, init)
    })
    workspace.open(cards[0]); await flush(); await flush()
    const table = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.open(cards[0], 'Desk', table); await flush()
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    expect(selected()).toBe(table)
    release(); await flush(); await flush()
    expect(selected()).toBe(table)
  })
  it('owner-routes file mtimes in Unix seconds for embeds and body links without reordering the strip', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/file-info?')) return new Response(JSON.stringify({ exists: true, modified_at: url.includes('report.html') ? 2000000000 : 1900000000 }))
      return original(input, init)
    })
    await feedNamesReport()
    workspace.open(cards[0]); await flush()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const tableKey = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    expect(workspace.reader.host.get(tableKey)?.doc.modifiedAt).toBe(new Date(1900000000 * 1000).toISOString())
    expect(workspace.reader.host.get(reportKey)?.doc.modifiedAt).toBe(new Date(2000000000 * 1000).toISOString())
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
    expect(document.querySelector('.ws-tab')).toBeNull()
    const metadataRequests = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/file-info?'))
    expect(metadataRequests.every(([url]) => String(url).includes('origin=host-a'))).toBe(true)
    workspace.reader.openDocument('fiber:host-a:alpha')
    document.querySelector<HTMLAnchorElement>('.ws-selected a[data-file-path]')!.click()
    await flush()
    const selectedKey = document.querySelector('.ws-selected')?.getAttribute('data-key')
    expect(workspace.reader.host.get(selectedKey!)?.doc.modifiedAt).toBe(new Date(1900000000 * 1000).toISOString())
  })
  it('opens on its report while owner file times are still being read', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?') ? new Promise<Response>(() => {}) : original(input, init))
    await feedNamesReport()
    workspace.open(cards[0]); await flush()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
    expect(workspace.reader.host.get(docKey('host-a', '/notes/alpha/table.html', 'host-a'))).toBeDefined()
    // The metadata reads wait in the quiet lane, two at a time over HTTP/1.1.
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/file-info?'))).toHaveLength(2)
  })
  it('loads receipts from each channel owner with conditional revalidation and last-good retention', async () => {
    const shared = [
      card({ id: 'work/shared', uid: 'shared-uid', name: 'Shared A', originId: 'host-a', fiberDir: '/notes/shared', path: 'work/shared/shared.md' }),
      card({ id: 'work/shared', uid: 'shared-uid', name: 'Shared B', originId: 'host-b', fiberDir: '/notes/shared', path: 'work/shared/shared.md' }),
    ]
    bodyCards = shared
    workspace.dispose()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    let failA = false
    const result = (owner: string): Response => owner === 'host-a'
      ? new Response(JSON.stringify({ files: [
        { fullPath: '/notes/shared/report.html', timestamp: 10, sessionId: 'session-a' },
        { fullPath: '/remote/atlas.html', host: 'archive-host', timestamp: 11, sessionId: 'session-byte-owner' },
      ] }), { headers: { ETag: '"a-v1"' } })
      : new Response(JSON.stringify({ files: [{ fullPath: '/notes/shared/report.html', timestamp: 20, sessionId: 'session-b' }] }), { headers: { ETag: '"b-v1"' } })
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.includes('/api/v1/sent-files?')) {
        const request = new URL(url, 'http://workspace.test')
        const owner = request.searchParams.get('origin')!
        const validator = new Headers(init?.headers).get('If-None-Match')
        if (owner === 'host-a' && validator) return new Response(null, { status: failA ? 503 : 304 })
        if (validator) return new Response(null, { status: 304 })
        return result(owner)
      }
      if (url.includes('/sent-files/all/composite')) return new Response(JSON.stringify({ files: [], origins: { 'host-a': { kind: 'local', stale: false } } }))
      if (url.includes('/api/v1/fibers/')) {
        const request = new URL(url, 'http://workspace.test')
        const source = shared.find(item => item.originId === request.searchParams.get('origin'))!
        return fiberReadResponse(source)
      }
      return new Response('{}')
    })
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => shared, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })

    const reportA = docKey('host-a', '/notes/shared/report.html', 'host-a')
    const reportB = docKey('host-b', '/notes/shared/report.html', 'host-b')
    workspace.open(shared[0]); await flush()
    expect(workspace.reader.host.get(reportA)?.doc.provenance).toContainEqual({ kind: 'sent', time: 10, session: 'session-a' })
    const receiptCache = (workspace as unknown as { receipts: Map<string, { files: Array<{ uid?: string; host?: string }> }> }).receipts
    expect(receiptCache.get(JSON.stringify(['host-a', 'shared-uid']))?.files[0]).toMatchObject({ uid: 'shared-uid', host: 'host-a' })
    const byteOwned = workspace.reader.host.get(docKey('archive-host', '/remote/atlas.html', 'host-a'))
    expect(byteOwned?.doc.owner).toBe('archive-host')
    expect(byteOwned?.doc.provenance).toContainEqual({ kind: 'sent', time: 11, session: 'session-byte-owner' })
    workspace.open(shared[1]); await flush()
    expect(workspace.reader.host.get(reportB)?.doc.provenance).toContainEqual({ kind: 'sent', time: 20, session: 'session-b' })
    expect(workspace.reader.host.get(reportB)?.doc.provenance).not.toContainEqual(expect.objectContaining({ session: 'session-a' }))

    workspace.open(shared[0]); await flush()
    expect(workspace.reader.host.get(reportA)?.doc.provenance).toContainEqual({ kind: 'sent', time: 10, session: 'session-a' })
    workspace.open(shared[1]); await flush()
    failA = true
    workspace.open(shared[0]); await flush()
    expect(workspace.reader.host.get(reportA)?.doc.provenance).toContainEqual({ kind: 'sent', time: 10, session: 'session-a' })

    const receiptCalls = calls.filter(call => call.url.includes('/api/v1/sent-files?'))
    expect(receiptCalls.map(({ url }) => {
      const request = new URL(url, 'http://workspace.test')
      return [request.searchParams.get('uid'), request.searchParams.get('origin')]
    })).toEqual([['shared-uid', 'host-a'], ['shared-uid', 'host-b'], ['shared-uid', 'host-a'], ['shared-uid', 'host-b'], ['shared-uid', 'host-a']])
    expect(new Headers(receiptCalls[2].init?.headers).get('If-None-Match')).toBe('"a-v1"')
    expect(new Headers(receiptCalls[3].init?.headers).get('If-None-Match')).toBe('"b-v1"')
    expect(new Headers(receiptCalls[4].init?.headers).get('If-None-Match')).toBe('"a-v1"')
    expect(calls.filter(call => call.url.includes('/sent-files/all/composite')).every(({ url }) => !url.includes('since_ms=0'))).toBe(true)
  })

  it('opens on the report the receipt feed already names, and retains the same iframe through pages, expand and return', async () => {
    await feedNamesReport()
    workspace.open(cards[0])
    await flush()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const frame = workspace.reader.host.get(reportKey)!
    const iframe = frame.content.querySelector('iframe')!
    expect(frame.el.classList.contains('ws-selected')).toBe(true)
    expect(window.location.hash).toContain(encodeURIComponent(reportKey))
    workspace.reader.openDocument('fiber:host-a:alpha')
    expect(frame.el.classList.contains('ws-receded')).toBe(true)
    await pop(() => workspace.reader.back())
    document.querySelector<HTMLButtonElement>('.ws-selected .ws-expand-button')!.click()
    expect(frame.el.classList.contains('ws-expanded')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(frame.el.classList.contains('ws-expanded')).toBe(false)
    workspace.reader.hide()
    expect(frame.el.classList.contains('ws-parked')).toBe(true)
    workspace.open(cards[0])
    await flush()
    expect(workspace.reader.host.get(reportKey)?.content.querySelector('iframe')).toBe(iframe)
    expect(frame.doc.provenance.filter(p => p.kind === 'sent')).toHaveLength(1)
  })

  it('opens a constitution on its report under the band, and keeps body links and embeds on its fiber page', async () => {
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    await feedNamesReport()
    workspace.open(cards[0])
    await flush()
    expect(workspace.reader.document?.name).toBe('report.html')
    const band = document.querySelector<HTMLElement>('.ws-stage-band')!
    expect(band.hidden).toBe(false)
    expect(band.nextElementSibling?.classList.contains('ws-stage')).toBe(true)
    expect(document.querySelector('.ws-tab,.ws-thumbbar')).toBeNull()

    const constitution = band.querySelector<HTMLButtonElement>('.ws-band-constitution')!
    expect(constitution.hidden).toBe(false)
    expect(constitution.getAttribute('aria-label')).toBe('Constitution')
    constitution.click()
    expect(document.querySelector('.ws-page.ws-selected .ws-fiber-prose')).not.toBeNull()
    expect(workspace.reader.document?.kind).toBe('fiber')
    const article = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    expect(article.querySelector('.ws-dock')).toBeNull()
    expect(article.querySelector('.kbn-detail-lede')?.textContent).toContain('A checked result.')
    expect(band.hidden).toBe(false)
    const link = document.querySelector<HTMLAnchorElement>('.ws-selected a[data-file-path]')!
    link.click()
    await flush()
    expect(workspace.reader.host.get(docKey('host-a', '/notes/alpha/report.html', 'host-a'))).toBeDefined()
    const dataFrame = workspace.reader.host.get(docKey('host-a', '/notes/alpha/data.csv', 'host-a'))!
    expect(dataFrame.doc.provenance.some(p => p.kind === 'link')).toBe(true)
    expect(dataFrame.el.classList.contains('ws-selected')).toBe(true)
    expect(band.hidden).toBe(false)
  })

  it('seats one band over each channel by owner and uid, and clears it for a note', async () => {
    const ownerCards = [
      card({ id: 'work/shared', uid: 'same-uid', name: 'Alpha copy', originId: 'host-a', fiberDir: '/notes/a', path: 'work/shared/shared.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }),
      card({ id: 'work/shared', uid: 'same-uid', name: 'Beta copy', originId: 'host-b', fiberDir: '/notes/b', path: 'work/shared/shared.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }),
      card({ id: 'notes/plain', uid: 'plain', name: 'Plain', originId: 'host-a', fiberDir: '/notes/plain', path: 'notes/plain/plain.md' }),
    ]
    bodyCards = ownerCards
    workspace.dispose()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => ownerCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    const band = (): HTMLElement => document.querySelector<HTMLElement>('.ws-stage-band')!
    const name = (): string | null | undefined => band().querySelector('.ws-band-title')?.textContent
    workspace.open(ownerCards[0]); await flush()
    expect(band().hidden).toBe(false)
    expect(name()).toBe('Alpha copy')
    const dock = band().querySelector('.ws-dock')
    workspace.open(ownerCards[1]); await flush()
    expect(name()).toBe('Beta copy')
    expect(band().querySelector('.ws-dock')).toBe(dock)
    expect(band().querySelectorAll('.ws-dock')).toHaveLength(1)
    workspace.open(ownerCards[2]); await flush()
    expect(band().hidden).toBe(true)
    expect(band().children).toHaveLength(0)
    workspace.open(ownerCards[0]); await flush()
    expect(band().hidden).toBe(false)
    expect(name()).toBe('Alpha copy')
  })

  it('retargets a renamed owner+uid band through Workspace.update', async () => {
    let liveCards = [card({ id: 'a/task', uid: 'stable-task', originId: 'host-a',
      path: 'a/task/task.md', fiberDir: '/notes/a/task', feltStore: '/notes/.felt',
      shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'host-a', shuttleProjectDir: '/work/a' })]
    bodyCards = liveCards
    workspace.dispose()
    const transition = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => liveCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed, transition, vi.fn()),
    })
    workspace.open(liveCards[0])
    await flush()
    const band = document.querySelector<HTMLElement>('.ws-stage-band .ws-dock')!
    liveCards = [{ ...liveCards[0], id: 'b/task', path: 'b/task/task.md', fiberDir: '/notes/b/task',
      feltStore: '/new/.felt', shuttleHost: 'host-b', shuttleProjectDir: '/work/b',
      workerState: 'running', tmuxSession: 'new-worker', sessionUuid: 'new-session', runtimePhase: 'working', turn: 'working', column: 'inFlight' }]
    workspace.update()
    expect(document.querySelector('.ws-stage-band .ws-dock')).toBe(band)
    expect(document.querySelectorAll('.kbn-card-worker:not(.ws-navbar *)')).toHaveLength(0)
    expect(document.querySelector('.ws-navbar .ws-head-worker .kbn-card-worker')?.textContent).toMatch(/^working/)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fresh = band.querySelector<HTMLButtonElement>('.ws-worker-acts button[data-verb="New session"]')!
    fresh.click()
    await flush()
    expect(confirm).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    confirm.mockReturnValue(true)
    workspace.queueVerdict(liveCards[0], 'tempered')
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(transition).not.toHaveBeenCalled()
    vi.advanceTimersByTime(6000)
    expect(confirm).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({
      id: 'b/task', uid: 'stable-task', path: 'b/task/task.md', fiberDir: '/notes/b/task',
      feltStore: '/new/.felt', shuttleHost: 'host-b', shuttleProjectDir: '/work/b', originId: 'host-a',
    }), 'tempered')
    vi.mocked(fetch).mockClear()
    fresh.click()
    await flush()
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/dispatch'))!
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ fiber_id: 'b/task', origin: 'host-a', user_message: '', resume_mode: 'fresh' })
  })

  it('Escape gives inline and reader popovers first refusal, then collapses and returns', async () => {
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    workspace.open(cards[0])
    await flush()
    const escape = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }
    const expand = document.querySelector<HTMLButtonElement>('.ws-selected .ws-expand-button')!
    expand.click()
    const popover = vi.spyOn(workspace.dock, 'handleEscape').mockReturnValueOnce(true).mockReturnValue(false)
    escape()
    expect(popover).toHaveBeenCalledOnce()
    expect(document.querySelector('.ws-selected.ws-expanded')).not.toBeNull()

    document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!.click()
    expect(document.querySelector('.ws-menu')).not.toBeNull()
    escape()
    expect(document.querySelector('.ws-menu')).toBeNull()
    expect(popover).toHaveBeenCalledOnce()
    escape()
    expect(document.querySelector('.ws-selected.ws-expanded')).toBeNull()
    expect(workspace.isActive).toBe(true)
    await pop(escape)
    expect(workspace.isActive).toBe(false)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    popover.mockRestore()
  })

  it('a refused Desk start lands on its fiber with the host-specific inline recovery prompt', async () => {
    const managed: KanbanCard = { ...cards[0], shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }
    workspace.openStartPrompt(managed, { reason: 'arm_refused', needs: 'project_dir', host: 'host-a', message: 'Choose a project directory.' })
    const band = workspace.dock.el
    expect(document.activeElement).toBe(band.querySelector('.kbn-start-prompt input'))
    await flush()
    expect(workspace.isActive).toBe(true)
    expect(window.location.hash).toContain('alpha@host-a')
    expect(workspace.reader.document?.kind).toBe('fiber')
    expect(band.querySelector('.kbn-start-prompt')?.textContent).toContain('Project directory on host-a')
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/dispatch'), expect.anything())
  })

  it('phone Back returns from the reader once; the inline controls add no history entry', async () => {
    workspace.dispose()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    window.history.replaceState(null, '', '/')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const historyLength = window.history.length
    workspace.open(cards[0])
    await flush()
    const key = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const iframe = workspace.reader.host.get(key)!.content.querySelector('iframe')
    expect(window.history.length).toBe(historyLength + 1)
    const nextBack = (): Promise<void> => new Promise(resolve => { window.addEventListener('popstate', () => resolve(), { once: true }); window.history.back() })
    await nextBack()
    await flush()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe('')
    expect(workspace.reader.host.get(key)?.content.querySelector('iframe')).toBe(iframe)
    expect(visibility).toHaveBeenLastCalledWith(false)
  })

  it('opens the real worker conversation with c, without a panel or a pill on the fiber page', async () => {
    const live = { ...cards[0], shuttleKind: 'oneshot' as const, shuttleAgent: 'codex-sol', tmuxSession: 'terminal-alpha', shuttleHost: 'daemon-a', terminalBackend: 'rex' as const }
    const openWorker = vi.fn()
    bodyCards = [{ ...live, terminalBackend: undefined }]
    workspace.dispose()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => [live], origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed, undefined, openWorker),
    })
    workspace.open(live)
    await flush()
    // The band draws no opening of its own; the navbar pill and c reach the conversation.
    expect(document.querySelectorAll('.ws-dock .kbn-card-worker, .ws-band-open')).toHaveLength(0)
    const head = document.querySelector<HTMLButtonElement>('.ws-navbar .ws-head-worker button.kbn-card-worker')!
    head.click()
    expect(openWorker).toHaveBeenLastCalledWith('terminal-alpha', 'daemon-a')
    openWorker.mockClear()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(openWorker).toHaveBeenCalledWith('terminal-alpha', 'daemon-a')
    expect(workspace.isActive).toBe(true)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    expect(document.querySelector('.ws-stage-band .ws-dock')).not.toBeNull()
    expect(document.querySelector('.ws-fiber-prose .ws-dock')).toBeNull()

    workspace.returnToOrigin()
    await flush()
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    const chat = document.querySelector<HTMLButtonElement>('.ws-overview-folio-conversation')!
    expect(chat.hidden).toBe(false)
    openWorker.mockClear()
    chat.click()
    expect(openWorker).toHaveBeenCalledWith('terminal-alpha', 'daemon-a')
    openWorker.mockClear()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'G', bubbles: true, cancelable: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '.', bubbles: true, cancelable: true }))
    expect(openWorker).toHaveBeenCalledWith('terminal-alpha', 'daemon-a')
  })

  it('keeps reordered tab DOM, labels, and selection aligned with the active fiber', async () => {
    const orderedCards = [
      card({ id: 'work/first', uid: 'first', name: 'First', originId: 'host-a', fiberDir: '/notes/shared', path: 'work/first/first.md' }),
      card({ id: 'work/second', uid: 'second', name: 'Second', originId: 'host-b', fiberDir: '/notes/shared', path: 'work/second/second.md' }),
    ]
    bodyCards = orderedCards
    bodyOverrides.set('host-a:first', 'First result.\n\n:::{embed} report.html\n:::\n\n:::{embed} table.html\n:::\n\n:::{embed} notes.md\n:::')
    bodyOverrides.set('host-b:second', 'Second result.\n\n:::{embed} notes.md\n:::\n\n:::{embed} table.html\n:::\n\n:::{embed} report.html\n:::')
    workspace.dispose()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => orderedCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.open(orderedCards[0])
    await flush()
    expect(workspace.reader.document?.key).toBe('fiber:host-a:first')
    workspace.open(orderedCards[1]); await flush()
    expect(workspace.reader.document?.key).toBe('fiber:host-b:second')
    const prose = workspace.reader.host.get('fiber:host-b:second')!.content
    expect(prose.querySelector('.ws-prose-documents')).toBeNull()
    expect(document.querySelector('.ws-tab')).toBeNull()
  })

  it('uses the Reader back key to pop an opened file to its parent', async () => {
    workspace.open(cards[0]); await flush()
    const key = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.reader.openDocument(key)
    expect(workspace.reader.document?.key).toBe(key)
    await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(workspace.reader.document?.kind).toBe('fiber')
    expect(workspace.isActive).toBe(true)
  })

  it('leaves Enter and Space activation on native expand controls alone', async () => {
    workspace.open(cards[0])
    await flush()
    const expand = document.querySelector<HTMLButtonElement>('.ws-selected .ws-expand-button')!
    for (const key of ['Enter', ' ']) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
      expand.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
      expect(document.querySelector('.ws-selected.ws-expanded')).toBeNull()
      expand.click()
      expect(document.querySelector('.ws-selected.ws-expanded')).not.toBeNull()
      expand.click()
    }
  })

  it('uses j/k for constitution order and held arrows for document scrolling', async () => {
    workspace.open(cards[1])
    await flush()
    const ordered = [cards[0], cards[1]]
    workspace.open(ordered[0])
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(ordered[1].name)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(ordered[0].name)

    workspace.reader.openDocument('fiber:host-a:alpha')
    const scroller = document.querySelector<HTMLElement>('.ws-selected .ws-prose-scroll')!
    let scrollHeight = 1800
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 600 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    })
    scroller.scrollBy = vi.fn()
    const press = (key: string, repeat = false, shiftKey = false): void => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, repeat, shiftKey, bubbles: true, cancelable: true }))
    }
    press('ArrowDown')
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: 72, behavior: 'smooth' })
    press('ArrowDown', true)
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: 72, behavior: 'instant' })
    press('ArrowUp')
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: -72, behavior: 'smooth' })
    press('d')
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: 300, behavior: 'smooth' })
    press('u')
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: -300, behavior: 'smooth' })
    press(' ')
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: 600, behavior: 'smooth' })
    press(' ', false, true)
    expect(scroller.scrollBy).toHaveBeenLastCalledWith({ top: -600, behavior: 'smooth' })
    scrollHeight = 600
    press('ArrowDown')
    expect(scroller.scrollBy).toHaveBeenCalledTimes(7)
  })

  it('switches Reader focus modality from keyboard to pointer input', async () => {
    workspace.open(cards[0])
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(workspace.reader.el.classList.contains('ws-keyboard')).toBe(true)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(workspace.reader.el.classList.contains('ws-keyboard')).toBe(false)
  })

  it('keeps label controls and their keyboard focus through metadata polls', async () => {
    workspace.open(cards[0])
    await flush()
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!
    control.focus()
    workspace.update()
    expect(document.querySelector('.ws-selected .ws-menu-button')).toBe(control)
    expect(document.activeElement).toBe(control)
    control.click()
    workspace.update()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(control)
    expect(control.isConnected).toBe(true)
  })

  it('never moves a painted selection when the channel\'s receipts arrive late', async () => {
    let deliver: () => void = () => {}
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/api/v1/sent-files?')
      ? new Promise<Response>(resolve => { deliver = () => { void original(input, init).then(resolve) } }) : original(input, init))
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    // Nothing names a page at open: the fiber's own page paints and stays.
    workspace.open(cards[0]); await flush()
    expect(selected()).toBe('fiber:host-a:alpha')
    deliver(); await flush()
    expect(workspace.reader.host.get(reportKey)).toBeTruthy()
    expect(selected()).toBe('fiber:host-a:alpha')
    expect(window.location.hash).not.toContain(encodeURIComponent(reportKey))
    // A routed page paints at once from a provisional frame, before its receipts.
    workspace.dispose()
    window.history.replaceState(null, '', '/')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    const tableKey = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(tableKey)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flush()
    expect(selected()).toBe(tableKey)
    const frame = workspace.reader.host.get(tableKey)!.el
    deliver(); await flush()
    expect(selected()).toBe(tableKey)
    expect(workspace.reader.host.get(tableKey)!.el).toBe(frame)
  })

  it('paints a routed page while file metadata is still unanswered', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/file-info?') ? new Promise<Response>(() => {}) : original(input, init))
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(reportKey)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
  })

  it('keeps a fresh deep-linked file addressable even outside the document index, returning directly to Board', async () => {
    const gone = docKey('host-a', '/notes/alpha/gone.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(gone)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flush()
    expect(workspace.reader.document?.key).toBe(gone)
    workspace.reader.back()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe('#/board')
  })

  it('keeps an explicit prose selection made while the body is loading', async () => {
    let deliver: (value: Response) => void = () => {}
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/v1/fibers/work/')
      ? new Promise<Response>(resolve => { deliver = resolve }) : originalFetch(url)))
    workspace.open(cards[0])
    workspace.reader.openDocument('fiber:host-a:alpha')
    deliver(fiberReadResponse(cards[0]))
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-a:alpha')
  })

  it('waits for authoritative metadata before seating a cold constitution\'s band', async () => {
    const managed = card({ id: 'work/cold', uid: 'cold', name: 'Cold constitution', originId: 'host-a',
      fiberDir: '/notes/cold', path: 'work/cold/cold.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' })
    let deliver!: (value: Response) => void
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/v1/fibers/cold?')
      ? new Promise<Response>(resolve => { deliver = resolve }) : originalFetch(url)))
    const open = vi.spyOn(workspace.dock, 'open')
    window.history.replaceState(null, '', '#/board/cold@host-a')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(document.querySelector('.ws-stage-band .ws-dock')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(open).not.toHaveBeenCalled()
    deliver(fiberReadResponse(managed))
    await flush()
    workspace.open(managed)
    await flush()
    const band = document.querySelector<HTMLElement>('.ws-stage-band .ws-dock')!
    expect(band.querySelector('.kbn-detail-controls-toggle')?.textContent).toContain('codex-sol')
  })

  it('gives an unknown routed fiber its own retryable failure page', async () => {
    workspace.open(cards[0])
    await flush()
    window.history.replaceState(null, '', '#/board/no-card@host-b')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('no-card')
    expect(document.querySelector('.ws-selected')?.textContent).toContain('Fiber not found on host-b')
    expect(document.querySelector('.ws-selected')?.textContent).toContain('Retry')
    expect(window.location.hash).toContain('no-card@host-b')
  })

  it('mouse entry does not focus chrome, but keyboard entry does', async () => {
    workspace.open(cards[1])
    await flush()
    workspace.open(cards[0])
    await flush()
    expect(document.activeElement).not.toBe(document.querySelector('.ws-return'))
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!
    const press = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    control.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(document.querySelector('.ws-return'))
  })

  it('keeps Alt-arrow stepping in Desk order and ignores messages from unrelated frames', async () => {
    workspace.open(cards[1])
    await flush()
    const ordered = [cards[0], cards[1]]
    const hash = window.location.hash
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shuttle-workspace-key', key: 'ArrowRight' }, source: window }))
    expect(window.location.hash).toBe(hash)
    workspace.open(ordered[0])
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(ordered[1].name)
    expect(window.location.hash).toContain(`${ordered[1].uid ?? ordered[1].id}@${ordered[1].originId}`)
    expect(visibility).toHaveBeenCalledWith(true)
  })

  it('restores a Desk-opened channel over Desk after reload', async () => {
    workspace.open(cards[0])
    await flush()
    expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'desk' } })

    workspace.dispose()
    document.body.replaceChildren()
    const onView = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => cards, origin: () => 'Board', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    await flush()

    expect(onView).toHaveBeenCalledWith('desk')
    expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
  })

  it('restores the Board return for a file route after reload', async () => {
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    await feedNamesReport()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    workspace.overview.el.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"] .ws-overview-folio-open')!.click()
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'board', base: true } })

    workspace.dispose()
    document.body.replaceChildren()
    const onView = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => boardCards, origin: () => 'Desk', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    workspace.mountOverview(document.body)
    await flush()
    expect(onView).toHaveBeenCalledWith('board')
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)

    const returned = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    await returned
    await flush()
    expect(window.location.hash).toBe('#/board')
    expect(workspace.overview.el.hidden).toBe(false)
  })

  it('restores the Board return after reloading a nested file route', async () => {
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    await feedNamesReport()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const tableKey = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.overview.el.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"] .ws-overview-folio-open')!.click()
    await flush()
    expect(workspace.reader.host.get(tableKey)).toBeTruthy()
    workspace.reader.openDocument(tableKey)
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(tableKey)
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { back: { pageLabel: 'report.html' }, depth: 2 } })

    workspace.dispose()
    document.body.replaceChildren()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => boardCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.mountOverview(document.body)
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(tableKey)

    await pop(() => workspace.reader.back())
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
    const returned = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    workspace.reader.back()
    await returned
    await flush()
    expect(window.location.hash).toBe('#/board')
    expect(workspace.overview.el.hidden).toBe(false)
  })

  it('restores overview scroll after returning from a channel opened on the Board', async () => {
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    await feedNamesReport()
    workspace.overview.opened(cards[0])
    const overview = workspace.overview.el
    overview.scrollTop = 432
    overview.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"] .ws-overview-folio-open')!.click()
    await flush()
    expect(workspace.reader.isActive).toBe(true)
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
    expect(overview.hidden).toBe(true)

    overview.scrollTop = 0
    const returned = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    await returned
    await flush()
    expect(window.location.hash).toBe('#/board')
    expect.soft(overview.hidden).toBe(false)
    expect(overview.scrollTop).toBe(432)
  })

  it('resumes the last Board channel after Desk suspension, but not after an explicit return', async () => {
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    workspace.overview.opened(cards[0])
    workspace.overview.el.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"] .ws-overview-folio-open')!.click()
    await flush()
    expect(workspace.reader.isActive).toBe(true)
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Alpha')

    workspace.suspend('desk')
    expect(workspace.reader.isActive).toBe(false)
    expect(window.location.hash).toBe('#/desk')
    workspace.showBoard()
    await flush()
    expect(workspace.reader.isActive).toBe(true)
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Alpha')

    await pop(() => document.querySelector<HTMLButtonElement>('.ws-return')!.click())
    workspace.showBoard()
    await flush()
    expect(workspace.reader.isActive).toBe(false)
    expect(workspace.overview.el.hidden).toBe(false)
    expect(window.location.hash).toBe('#/board')
  })
})
