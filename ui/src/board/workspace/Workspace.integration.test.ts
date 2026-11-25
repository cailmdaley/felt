// @vitest-environment jsdom
import { slug } from '../threadOutline.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { consoleActs, pressConsoleAct } from './testActs.js'
import { card, servedFeed, settle } from '../testFixtures.js'
import type { ColumnKind, KanbanCard } from '../KanbanTypes.js'
import type { Turn } from '../turn.js'
import { Workspace, type WorkspaceOptions } from './Workspace.js'
import { constitutionsSection } from '../search/sections.js'
import { ThreadIndex } from '../threads.js'
import { deskCardKey, deskOrder } from '../deskOrdering.js'
import type { Reader } from './Reader.js'
import { Dock } from './Dock.js'
import { docKey } from './documents.js'
import { resetLanes } from '../requestLanes.js'
import { buildFileViewer } from '../FileViewerPanel.js'
import { FiberSends } from '../fiberSends.js'
import fc from 'fast-check'
import '../views/index.js'
/** The fiber's acts as drawn: on its row on a family page, else in the band. */
const shownActs = (): HTMLElement => [...document.querySelectorAll<HTMLElement>('.ws-fiber-acts')].find(el => !el.closest('[hidden]'))!

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
type WorkspaceTestOptions = Omit<WorkspaceOptions, 'deskRows' | 'console'> & Partial<Pick<WorkspaceOptions, 'deskRows' | 'console'>>
/** Every refresh reads the sent-file feed, so a test's changed answer is seen at its next step. */
function makeWorkspace(root: HTMLElement, opts: WorkspaceTestOptions): Workspace {
  return new Workspace(root, { sends: new FiberSends(opts.shuttleBase, { intervalMs: 0 }), console: options => new Dock(opts.shuttleBase, vi.fn(), undefined, undefined, options), ...opts, deskRows: opts.deskRows ?? opts.cards })
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
const pop = async (action: () => void): Promise<void> => {
  await new Promise<void>(resolve => {
    window.addEventListener('popstate', () => resolve(), { once: true })
    action()
  })
  await settle()
}
/** The library's receipt feed has named alpha's report before the channel opens: the construction read lands, then a fresh read returns the new feed. */
const feedNamesReport = async (): Promise<void> => {
  await settle()
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/sent-files/all/')
    ? new Response(JSON.stringify({ files: [{ fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: Date.now(), sessionId: 'session-two' }] }))
    : original(input, init))
  workspace.library.refresh()
  await settle()
}
const changed = vi.fn()
const visibility = vi.fn<(active: boolean) => void>()

beforeEach(() => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
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
    if (url.includes('/api/v1/roles')) return new Response(JSON.stringify([{ slug: 'surveyor', id: 'roles/surveyor', name: 'Surveyor', outcome: '' }]))
    return new Response('{}')
  }))
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
  localStorage.clear()
  changed.mockClear()
  visibility.mockClear()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => boardCards, origin: () => 'desk', onVisibility: visibility, dock: new Dock("", changed) })
})
/** What the board asked Rex to select: every select-only attach body. */
const selections = (): Record<string, unknown>[] => vi.mocked(fetch).mock.calls
  .filter(([url]) => String(url).endsWith('/api/v1/attach'))
  .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
afterEach(() => { resetLanes(); workspace?.dispose(); vi.useRealTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('prefixes the console with a named channel\'s chair, and in the catch-all with the family\'s top-level', () => {
  const chair = card({ id: 'life/fee-and-mission', uid: 'fee', shuttleRole: 'intendant', createdAt: '2026-01-01' })
  const thread = card({ id: 'life/fee-and-mission/travel', uid: 'travel', orchestrator: 'fee' })
  const seat = card({ id: 'life/intendant', uid: 'int', shuttleChannel: 'Intendant', shuttleSeat: true, createdAt: '2025-01-01' })
  const errand = card({ id: 'life/errand', uid: 'errand', orchestrator: 'int' })
  boardCards = [chair, thread, seat, errand]
  expect([chair, thread, seat, errand].map(each => workspace.channelHandle(each))).toStrictEqual(['fee-and-mission', 'fee-and-mission', 'intendant', 'intendant'])
})

it('routes a linked change to the fiber holding its file on its own host, not the report channel', async () => {
  boardCards = bodyCards = cards.map(c => ({ ...c, workerState: 'running' as const }))
  const send = vi.spyOn(Dock.prototype, 'sendReview').mockResolvedValue(undefined)
  workspace.open(boardCards[0], 'desk', docKey('host-a', '/notes/alpha/report.html', 'host-a')); await settle()
  const report = vi.mocked(buildFileViewer).mock.calls.filter(call => call[1] === '/notes/alpha/report.html').at(-1)![5]!
  report.onNavigate!('/api/v1/file?path=%2Fnotes%2Fbeta%2Freview.change.json&origin=host-b')
  await settle()
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
  workspace.open(cards[0], 'desk')
  await settle()
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

  workspace.open(boardCards[1], 'desk')
  await settle()
  show.mockClear()
  workspace.update()
  expect(show).not.toHaveBeenCalled()

  boardCards = [...boardCards, card({ id: 'work/unrelated', uid: 'unrelated', originId: 'host-c', status: 'active', runtimePhase: 'working' })]
  workspace.update()
  expect(show).not.toHaveBeenCalled()

  boardCards = [boardCards[0], { ...boardCards[1], name: 'Beta working', status: 'active', workerState: 'running', runtimePhase: 'working' }]
  workspace.update()
  expect(show).toHaveBeenCalledOnce()
  expect(document.querySelector('.ws-channel-title')?.textContent).toBe('beta')
})

it('discovers a report only after it exists, including creation on a later refresh', async () => {
  vi.useFakeTimers()
  bodyOverrides.set('host-b:beta', 'No report yet.')
  let exists = false
  const original = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?')
    ? new Response(JSON.stringify({ exists: String(input).includes('report.html') && exists })) : original(input, init))
  workspace.open(cards[1], 'desk'); await settle()
  const key = docKey('host-b', '/notes/beta/report.html', 'host-b')
  expect(workspace.reader.host.get(key)).toBeUndefined()
  expect(document.querySelector('.ws-report-inset')).toBeNull()
  exists = true
  await vi.advanceTimersByTimeAsync(15000); await settle()
  expect(workspace.reader.host.get(key)).toBeDefined()
})

it('brings the constitution forward from the band, and back from it returns to the view', async () => {
  bodyCards = cards.map(card => ({ ...card, shuttleKind: 'oneshot' }))
  workspace.open(bodyCards[0], 'desk'); await settle()
  workspace.open(bodyCards[1], 'desk'); await settle()
  workspace.reader.openDocument(docKey('host-b', '/notes/beta/report.html', 'host-b')); await settle()
  await pressConsoleAct(document.querySelector('.ws-stage-band')!, 'Constitution')
  expect(workspace.reader.document?.kind).toBe('fiber')
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
  await pop(() => workspace.reader.back())
  expect(workspace.isActive).toBe(false)
})

it('gives a constitution a Change page beside its fiber page only when it names a project', async () => {
  const pages = (): (string | null)[] => [...document.querySelectorAll('.ws-page:not(.ws-parked)')].map(page => page.getAttribute('data-key'))
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot' }, { ...cards[1], shuttleKind: 'oneshot', shuttleProjectDir: '/work/beta' }]
  workspace.open(bodyCards[0], 'desk'); await settle()
  expect(pages().some(key => key?.startsWith('change:'))).toBe(false)
  workspace.open(bodyCards[1], 'desk'); await settle()
  const fiber = pages().indexOf(`fiber:host-b:${bodyCards[1].uid}`)
  expect(fiber).toBeGreaterThanOrEqual(0)
  expect(pages()[fiber + 1]).toBe(`change:host-b:${bodyCards[1].uid}`)
})

it('takes a verdict key only in the constitution\'s view, and never on one of its other pages', async () => {
  const original = cards[0]
  cards[0] = { ...original, shuttleKind: 'oneshot', status: 'closed' }
  onTestFinished(() => { cards[0] = original })
  bodyCards = [cards[0]]
  workspace.open(bodyCards[0], 'desk'); await settle()
  const report = docKey('host-a', '/notes/alpha/report.html', 'host-a')
  workspace.reader.openDocument(report); await settle()
  const press = (key: string): KeyboardEvent => { const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }); document.dispatchEvent(event); return event }
  expect(press('t').defaultPrevented).toBe(false)
  expect(workspace.reader.document?.key).toBe(report)
  expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
  workspace.reader.openDocument(workspace.familyDocument(bodyCards[0])!); await settle()
  press('t')
  expect(document.querySelector('.ws-verdict-undo')?.textContent).toMatch(/^Tempered/)
  press('z')
  expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
})

it('gives r no work on a constitution', async () => {
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot', status: 'closed' }]
  workspace.open(bodyCards[0], 'desk'); await settle()
  const event = new KeyboardEvent('keydown', { key: 'r', bubbles: true, cancelable: true })
  document.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
  expect(document.querySelector('.ws-reader textarea:not(.ws-worker-message)')).toBeNull()
})

it('steps constitutions in one history entry and returns the last viewed card to Desk', async () => {
  workspace.dispose()
  bodyCards = [0, 1, 2, 3].map(i => ({ ...cards[0], id: `work/scan-${i}`, uid: `scan-${i}`, name: `Scan ${i}` }))
  const returned = vi.fn()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, deskRows: () => bodyCards,
    origin: () => 'desk', onVisibility: visibility, onReturnCard: returned, dock: new Dock('', changed) })
  workspace.open(bodyCards[0], 'desk'); await settle()
  const length = window.history.length
  for (let i = 1; i < bodyCards.length; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); await settle()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(`scan-${i}`)
  }
  expect(window.history.length).toBe(length)
  await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(workspace.isActive).toBe(false)
  expect(returned).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: bodyCards[3].uid }))
})

it('does not rewrite the address on show, and a page selection takes the reader\'s entry once', async () => {
  bodyCards = [{ ...cards[0], shuttleKind: 'oneshot' }]
  workspace.open(bodyCards[0], 'desk'); await settle()
  const replace = vi.spyOn(window.history, 'replaceState')
  const push = vi.spyOn(window.history, 'pushState')
  for (const runtimePhase of ['waiting', 'working'] as const) {
    bodyCards = [{ ...bodyCards[0], runtimePhase }]
    workspace.update(); await settle()
  }
  expect(replace).not.toHaveBeenCalled()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a')); await settle()
  expect(push).not.toHaveBeenCalled()
  expect(replace).toHaveBeenCalledOnce()
})

it('reopens a file after reload with its view still below, and returns a fresh deep link to its origin', async () => {
  workspace.open(cards[0], 'desk'); await settle()
  const report = docKey('host-a', '/notes/alpha/report.html', 'host-a')
  const table = docKey('host-a', '/notes/alpha/table.html', 'host-a')
  workspace.reader.openDocument(report)
  workspace.reader.openDocument(table)
  const hash = window.location.hash
  workspace.dispose()
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
  await settle()
  expect(workspace.reader.document?.key).toBe(table)
  await pop(() => workspace.reader.back())
  expect(workspace.isActive).toBe(false)
  workspace.dispose()
  window.history.replaceState(null, '', hash)
  workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
  await settle()
  workspace.reader.back()
  expect(workspace.isActive).toBe(false)
  expect(window.location.hash).toBe('#/channels')
})

it('names the view it was opened from as its way back, from a file or another constitution', async () => {
  workspace.open(cards[0], 'desk')
  await settle()
  expect(workspace.reader.document?.kind).toBe('fiber')
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
  await settle()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/table.html', 'host-a'))
  await settle()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
  workspace.open(cards[1]); await settle()
  expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
})

it('moves between documents and back to one without re-reading the channel or its receipt feed', async () => {
  workspace.open(cards[0], 'desk'); await settle()
  const reads = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/api\/v1\/(fibers\/|sent-files\?)/.test(String(url))).length
  const before = reads()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
  await settle()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/table.html', 'host-a'))
  await settle()
  workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
  await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed), find })
    return find
  }
  const type = (find: HTMLInputElement, text: string): void => {
    find.value = text
    find.dispatchEvent(new Event('input', { bubbles: true }))
    workspace.find()
  }
  const press = (el: HTMLElement, key: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }

  const transcriptReads = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('/transcripts/search'))
  const answer = (hits: unknown[]): void => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify({ hits, errors: [] }))
      : original(input, init))
  }
  const ask = async (find: HTMLInputElement): Promise<void> => {
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }))
    await vi.advanceTimersByTimeAsync(250); await settle()
  }

  it('reads transcripts at the board\'s scope only when asked, and steps from the field through every row and its copy path', async () => {
    vi.useFakeTimers()
    const find = setup()
    answer([hit])
    type(find, 'Alpha')
    await vi.advanceTimersByTimeAsync(1000); await settle()
    expect(transcriptReads()).toEqual([])
    expect(document.querySelector('.ws-find-ask')?.textContent).toContain('Search transcripts for “Alpha”')
    await ask(find)
    expect(transcriptReads()).toHaveLength(1)
    expect(transcriptReads()[0]).not.toContain('fiber=')
    const result = document.querySelector<HTMLElement>('[data-section="transcripts"] .ws-search-result')!
    expect(result.querySelector('mark')?.textContent).toBe('Alpha')
    expect(result.title).toBe('/transcripts/alpha.jsonl:2')
    expect(result.querySelector('.ws-search-meta')?.textContent).toContain('claude · b4edf873 · alpha')
    expect(result.querySelector('.ws-search-meta')?.textContent).toContain('13 matches')
    expect(result.querySelector('.ws-search-meta > time.el-time')?.getAttribute('datetime')).toBe(new Date(hit.timestamp).toISOString())
    expect(document.querySelector('[data-section="transcripts"] .kbn-flight-caption')?.textContent).toBe('Transcripts')
    const stops = [...document.querySelectorAll<HTMLElement>('.ws-find-list button')]
    expect(stops[0].classList.contains('ws-channel-row')).toBe(true)
    expect(stops.at(-1)!.textContent).toBe('copy path')
    press(find, 'ArrowDown'); expect(document.activeElement).toBe(stops[0])
    for (const stop of stops.slice(1)) { press(document.activeElement as HTMLElement, 'ArrowDown'); expect(document.activeElement).toBe(stop) }
    press(stops[1], 'ArrowUp'); expect(document.activeElement).toBe(stops[0])
    press(stops[0], 'ArrowUp'); expect(document.activeElement).toBe(find)
  })

  it('opens the constitution a transcript\'s session worked on, and copies its location', async () => {
    vi.useFakeTimers()
    const find = setup()
    const copied = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: copied } })
    answer([{ ...hit, matches: 1 }])
    type(find, 'Alpha'); await ask(find)
    expect(document.querySelector('.ws-search-meta')?.textContent).toContain('1 match ·')
    const copy = document.querySelector<HTMLButtonElement>('.ws-find-extra')!
    copy.click(); await settle()
    expect(copied).toHaveBeenCalledWith('/transcripts/alpha.jsonl:2')
    expect(copy.textContent).toBe('copied')
    expect(workspace.isActive).toBe(false)
    document.querySelector<HTMLElement>('[data-section="transcripts"] .ws-find-pick')!.click(); await settle()
    expect(workspace.isActive).toBe(true)
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('alpha')
  })

  it('never asks for transcripts from a plain Enter in the field', async () => {
    vi.useFakeTimers()
    const find = setup()
    bodyCards = []
    answer([hit])
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(300); await settle()
    press(find, 'Enter'); await vi.advanceTimersByTimeAsync(300); await settle()
    expect(transcriptReads()).toEqual([])
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
    type(find, 'Alpha'); await ask(find)
    type(find, 'Beta'); expect(requests[0].signal.aborted).toBe(true)
    requests[0].resolve(new Response(JSON.stringify({ hits: [hit], errors: [] }))); await settle()
    expect(document.querySelector('.ws-search-result')).toBeNull()
    await ask(find)
    workspace.clearFind(); expect(requests[1].signal.aborted).toBe(true)
    requests[1].resolve(new Response(JSON.stringify({ hits: [hit], errors: [] }))); await settle()
    expect(document.querySelector('.ws-find')).toBeNull()
  })

  it('shows one quiet failure, and a hit with no board card can only be copied', async () => {
    vi.useFakeTimers()
    const find = setup()
    const original = vi.mocked(fetch).getMockImplementation()!
    let fail = true
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/transcripts/search')
      ? new Response(JSON.stringify(fail ? { error: 'offline' } : { hits: [{ ...hit, fibers: [] }], errors: [] }), { status: fail ? 502 : 200 })
      : original(input, init))
    type(find, 'Alpha'); await ask(find)
    expect(document.querySelectorAll('.ws-search-note:not(:empty)')).toHaveLength(1)
    expect(document.querySelector('[data-section="transcripts"] .ws-search-note')?.textContent).toBe('Transcript search unavailable.')
    fail = false
    type(find, 'Alph'); await ask(find)
    expect(document.querySelector('[data-section="transcripts"] .ws-search-note')).toBeNull()
    expect(document.querySelector('[data-section="transcripts"] .ws-find-pick')?.getAttribute('aria-disabled')).toBe('true')
    expect(document.querySelector('.ws-find-extra')?.textContent).toBe('copy path')
  })

  it('in the reader, searches its constitution: a chip names it, its own transcripts read unasked, and Backspace widens to the board', async () => {
    vi.useFakeTimers()
    const find = setup()
    const chip = document.createElement('button')
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed), find, findChip: chip })
    answer([hit])
    workspace.openFromDesk(bodyCards[0]); await settle()
    expect(workspace.isActive).toBe(true)
    type(find, 'Alpha')
    expect(chip.hidden).toBe(false)
    expect(chip.textContent).toBe('in Alpha')
    await vi.advanceTimersByTimeAsync(250); await settle()
    expect(transcriptReads()).toHaveLength(1)
    expect(new URL(transcriptReads()[0], 'http://board').searchParams.get('fiber')).toBe('work/alpha')
    expect(document.querySelector('[data-section="transcripts"] .kbn-flight-caption')?.textContent).toBe('Its transcripts')
    expect(document.querySelector('[data-section="constitutions"]')).toBeNull()
    type(find, '')
    press(find, 'Backspace')
    expect(chip.hidden).toBe(true)
    expect(document.querySelector('[data-section="constitutions"]')).not.toBeNull()
  })

  const searches = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('/api/v1/search?'))
  const withScope = (findScope: WorkspaceOptions['findScope']): { find: HTMLInputElement; chip: HTMLButtonElement } => {
    const find = setup()
    const chip = document.createElement('button')
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => bodyCards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed), find, findChip: chip, findScope })
    return { find, chip }
  }

  it('widened by the chip with words in the field, searches the board afresh: its own read, its own picks', async () => {
    vi.useFakeTimers()
    const picked = vi.fn()
    const { find, chip } = withScope(() => ({ chip: 'in Chronicle', sections: [constitutionsSection({ shuttleBase: '', cards: () => bodyCards, pick: picked })] }))
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(chip.textContent).toBe('in Chronicle')
    expect(searches()).toHaveLength(1)
    chip.click(); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(chip.hidden).toBe(true)
    expect(searches(), 'the board reads for itself').toHaveLength(2)
    expect(document.querySelector('.ws-find-ask'), 'the board asks before reading transcripts').not.toBeNull()
    document.querySelector<HTMLElement>('[data-section="constitutions"] .ws-find-pick')!.click(); await settle()
    expect(picked).not.toHaveBeenCalled()
    expect(workspace.isActive).toBe(true)
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('alpha')
  })

  it('widened from the reader with words in the field, reads the board\'s transcripts afresh when asked', async () => {
    vi.useFakeTimers()
    const { find, chip } = withScope(undefined)
    answer([hit])
    workspace.openFromDesk(bodyCards[0]); await settle()
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(transcriptReads()).toHaveLength(1)
    chip.click(); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(document.querySelector('[data-section="transcripts"] .ws-search-result'), 'the reader\'s transcripts are not the board\'s').toBeNull()
    await ask(find)
    expect(transcriptReads()).toHaveLength(2)
    expect(transcriptReads()[1]).not.toContain('fiber=')
  })

  it('in the reader, an empty field lists the constitutions, the one being read first and current; words search the thread alone', async () => {
    vi.useFakeTimers()
    const { find } = withScope(undefined)
    workspace.openFromDesk(bodyCards[1]); await settle()
    type(find, '')
    const rows = [...document.querySelectorAll<HTMLElement>('[data-section="constitutions"] .ws-find-pick')]
    expect(rows.map(row => row.getAttribute('aria-label'))).toEqual(['Beta', 'Alpha'])
    expect(rows.map(row => row.getAttribute('aria-current'))).toEqual(['true', null])
    expect(find.getAttribute('aria-expanded')).toBe('true')
    expect(document.getElementById(find.getAttribute('aria-controls')!)?.contains(rows[0])).toBe(true)
    type(find, 'Alpha'); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(document.querySelector('[data-section="constitutions"]')).toBeNull()
    expect(searches(), 'the thread does not search the record').toEqual([])
    type(find, '')
    // Enter goes somewhere: past the constitution being read, to the next.
    press(find, 'Enter'); await settle()
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('alpha')
  })

  it('finds what was said across the whole board once its one read lands, and a pick opens its constitution', async () => {
    vi.useFakeTimers()
    const { find } = withScope(undefined)
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/api/v1/board/family?all=true')
      ? new Response(JSON.stringify({ family: null, records: [{ id: 'p1', kind: 'post', timestamp: Date.now() - 1000, fiber: 'alpha', to: { label: 'Cail' }, text: 'The **mask threshold** is ready' }], reach_ms: 86_400_000, waiting: {} }))
      : original(input, init))
    type(find, 'mask threshold'); await settle()
    const said = document.querySelector<HTMLElement>('[data-section="said"] .ws-find-pick')
    expect(said?.getAttribute('aria-label')).toBe('alpha: The mask threshold is ready')
    expect(said?.querySelector('mark')?.textContent).toBe('mask threshold')
    said!.click(); await settle()
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('alpha')
  })

  it('names a constitution found by its words with them, and says politely when nothing is found', async () => {
    vi.useFakeTimers()
    const { find } = withScope(undefined)
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/api/v1/search?')
      ? new Response(JSON.stringify({ results: String(input).includes('checked') ? [{ id: 'work/beta', name: 'Beta', where: ['body'], excerpt: 'A checked result.' }] : [] }))
      : original(input, init))
    type(find, 'checked'); await vi.advanceTimersByTimeAsync(250); await settle()
    expect(document.querySelector('[data-section="constitutions"] .ws-find-pick')?.getAttribute('aria-label')).toBe('Beta: A checked result.')
    // Two letters: the record is read, and transcripts (three at least) are not offered.
    type(find, 'zz')
    expect(document.querySelector('.ws-find [role="status"]')?.textContent).toBe('Searching…')
    await vi.advanceTimersByTimeAsync(250); await settle()
    expect(document.querySelector('.ws-find [role="status"]')?.textContent).toBe('Nothing found.')
  })

  it('reads the whole board\'s records in one request for its Said, once per opening', async () => {
    vi.useFakeTimers()
    const { find } = withScope(undefined)
    const familyReads = (): string[] => vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter(url => url.includes('/api/v1/board/family'))
    const before = familyReads().length
    type(find, ''); type(find, 'Al'); type(find, 'Alpha'); await settle()
    expect(familyReads().slice(before)).toHaveLength(1)
    expect(familyReads().at(-1)).toContain('all=true')
  })

  it('Escape in the field puts Find away and leaves the reader be, though the list closed beneath it', async () => {
    vi.useFakeTimers()
    const { find } = withScope(undefined)
    workspace.openFromDesk(bodyCards[0]); await settle()
    find.focus()
    type(find, 'Al')
    workspace.clearFind()
    find.value = 'Al'
    press(find, 'Escape')
    expect(find.value).toBe('')
    expect(document.activeElement).not.toBe(find)
    expect(workspace.isActive).toBe(true)
  })
})

describe('workspace reader integration', () => {
  it('s in the constitution\'s view requests rest', async () => {
    workspace.dispose()
    const onRest = vi.fn()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed), onRest })
    const original = cards[0], constitution = { ...original, shuttleKind: 'oneshot' as const }
    cards[0] = constitution
    onTestFinished(() => { cards[0] = original })
    bodyCards = [constitution]
    workspace.open(constitution, 'desk', workspace.familyDocument(constitution)); await settle(); await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true, cancelable: true }))
    expect(onRest).toHaveBeenCalledWith(expect.objectContaining({ uid: 'alpha' }), workspace.reader.el)
  })
  it('names the office the feed carries and repaints the page when it changes', async () => {
    const original = cards[0]
    const roles = (): string[] => [...document.querySelectorAll('.ws-fiber-role')].map(role => role.textContent ?? '')
    try {
      // The body read carries no office; the feed's card does.
      cards[0] = { ...original, shuttleRole: 'surveyor' }
      workspace.open(cards[0]); await settle(); await settle()
      expect(roles()).toEqual(['surveyor'])
      cards[0] = { ...original, shuttleRole: 'scribe' }
      workspace.update(); await settle()
      expect(roles()).toEqual(['scribe'])
      cards[0] = original
      workspace.update(); await settle()
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
    workspace.open(role); await settle(); await settle()
    expect(holds()).toEqual(['Alpha'])
    expect(document.querySelector<HTMLElement>('.ws-stage-band')?.hidden).toBe(true)
    expect(document.querySelector('[data-part="role-holders"]')).toBeNull()
    const page = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    for (const chrome of ['.ws-dock', '.kbn-detail-controls', '.kbn-ctl-history-toggle', '.kbn-detail-directive', '.kbn-ctl-verdict']) {
      expect(page.querySelector(chrome), chrome).toBeNull()
    }
    // A role is outside the feed; its holds still follow office assignments.
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    workspace.update(); await settle()
    expect(holds()).toEqual([])
    expect(document.querySelector('[data-part="role-holds"]')).toBeNull()
    cards[0] = { ...original, shuttleKind: 'oneshot', shuttleRole: 'surveyor' }
    workspace.update(); await settle()
    document.querySelector<HTMLButtonElement>('.ws-role-hold')!.click()
    await settle(); await settle()
    expect(document.querySelector('.ws-selected .ov-name')?.textContent).toBe('alpha')
    workspace.reader.openDocument(`fiber:host-a:alpha`); await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [live], origin: () => 'desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(reviewing); await settle()
    vi.useFakeTimers()
    const pair = shownActs()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    expect(pair.dataset.verdictPending).toBe('discarded')
    expect(pair.querySelector(':scope > .ws-verdict-undo')?.textContent).toBe('Discarded·undo z')
    vi.advanceTimersByTime(3000)
    pair.querySelector<HTMLButtonElement>('.ws-verdict-undo button')!.click()
    expect(pair.hasAttribute('data-verdict-pending')).toBe(false)
    pair.querySelector<HTMLButtonElement>('.kbn-ctl-temper')!.click()
    expect(commit).not.toHaveBeenCalled()
    expect(shownActs().querySelectorAll('.ws-verdict-undo')).toHaveLength(1)
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(reviewing); await settle()
    vi.useFakeTimers()
    workspace.queueVerdict(reviewing, 'composted')
    expect(shownActs().querySelectorAll('.ws-verdict-undo')).toHaveLength(1)
    live = change === 'removed' ? [] : [{ ...reviewing,
      ...(change === 'replacement' ? { uid: 'UID-B' } : { originId: 'host-b' }) }]
    bodyCards = live
    vi.advanceTimersByTime(6000); await settle()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
    expect(commit).not.toHaveBeenCalled()
  })
  it('a moves in-flight or draft work to review through the shared verb after an undo window, z cancels, and it is inert elsewhere', async () => {
    workspace.dispose()
    const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    const open = async (fiber: KanbanCard, commit: (card: KanbanCard, target: ColumnKind) => void): Promise<HTMLElement> => {
      bodyCards = [fiber]
      workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [fiber], origin: () => 'desk',
        onVisibility: visibility, dock: new Dock('', changed, commit) })
      workspace.open(fiber); await settle()
      return shownActs()
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
    vi.advanceTimersByTime(6000); await settle()
    expect(commit).not.toHaveBeenCalled()
    press('a')
    vi.advanceTimersByTime(3999)
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); await settle()
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
      vi.advanceTimersByTime(6000); await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(app); await settle()
    vi.useFakeTimers()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    workspace.queueVerdict(app, 'composted')
    expect(confirm).toHaveBeenCalledOnce()
    expect(document.querySelectorAll('.ws-verdict-undo')).toHaveLength(0)
    confirm.mockReturnValue(true)
    workspace.queueVerdict(app, 'composted')
    expect(confirm).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(6000); await settle()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(commit).toHaveBeenCalledExactlyOnceWith(app, 'composted')
    // A worker that starts during the undo window was never confirmed.
    const finished = card({ id: 'work/done', uid: 'done-uid', originId: 'host-a', status: 'open', shuttleKind: 'oneshot' })
    live = [finished]; commit.mockClear(); confirm.mockClear()
    workspace.queueVerdict(finished, 'tempered')
    expect(confirm).not.toHaveBeenCalled()
    live = [{ ...finished, status: 'active', workerState: 'running' }]
    vi.advanceTimersByTime(6000); await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [], origin: () => 'desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(linked); await settle()
    vi.useFakeTimers()
    workspace.queueVerdict(linked, 'tempered')
    const renamed = { ...linked, id: 'work/moved', path: 'work/moved/moved.md' }
    bodyCards = result === 'missing' ? [] : [result === 'replacement' ? { ...linked, uid: 'replacement-uid' } : renamed]
    vi.mocked(fetch).mockClear()
    vi.advanceTimersByTime(6000); await settle()
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/v1/fibers/linked-uid?body=true&origin=host-a&routed=1'))).toBe(true)
    if (result === 'same identity') expect(commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ uid: linked.uid, id: renamed.id, originId: linked.originId }), 'tempered')
    else expect(commit).not.toHaveBeenCalled()
  })
  const reader = (): Reader => workspace.reader
  const walked = (): string[] => (reader() as unknown as { deskCards(): KanbanCard[] }).deskCards().map(row => row.uid ?? row.id)
  const landed = (): string | null | undefined => document.querySelector('.shuttle-toast .toast-message')?.textContent
  const titled = (): string | null | undefined => document.querySelector('.ws-channel-title')?.textContent
  const step = async (key: string): Promise<void> => { document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key !== key.toLowerCase(), bubbles: true, cancelable: true })); await settle() }
  it('steps the Desk with j/k wherever it opens', async () => {
    workspace.dispose()
    const returned = vi.fn()
    const grouped = [{ ...cards[0], status: 'closed', column: 'awaitingReview' as const }, { ...cards[1], status: 'active', column: 'inFlight' as const }]
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => grouped, origin: () => 'channels', onVisibility: visibility,
      deskRows: () => [grouped[1], grouped[0]], onReturnCard: returned, dock: new Dock('', changed),
    })
    workspace.open(grouped[0], 'channels'); await settle()
    expect(walked()).toEqual(['beta', 'alpha'])
    await step('k')
    expect(titled()).toBe('beta')
    await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(workspace.isActive).toBe(false)
    expect(returned).not.toHaveBeenCalled()
  })
  it('walks the Desk\'s sections as one flow with j/k, and stops J/K at each section', async () => {
    workspace.dispose()
    const flight = (uid: string, runtimePhase?: KanbanCard['runtimePhase']): KanbanCard =>
      ({ ...cards[1], id: `work/${uid}`, uid, name: uid, path: `work/${uid}/${uid}.md`, status: 'active', column: 'inFlight', turn: TURN_OF_PHASE[runtimePhase ?? ''] ?? 'no-signal', workerState: 'running', runtimePhase })
    const feed = [{ ...cards[0], status: 'closed', column: 'awaitingReview' as const }, flight('w1', 'working'), flight('n1', 'waiting'), flight('w2', 'working'), flight('n2', 'blocked'), { ...cards[1], uid: 'draft', id: 'work/draft', name: 'draft' }]
    const order = deskOrder(new ThreadIndex(feed), new Map())
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, deskRows: () => order.rows, deskPlacement: card => order.placements.get(deskCardKey(card)), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const names = order.rows.map(row => row.name)
    // The blocked n2 waits on you; the idle n1 works; the close awaits review.
    expect(order.rows.map(row => order.placements.get(deskCardKey(row))!.group)).toEqual(['Waiting on you', 'Working', 'Working', 'Working', 'Awaiting review', 'Drafts'])
    expect([names[0], names[4]]).toEqual(['n2', 'Alpha'])
    workspace.open(order.rows[0], 'desk'); await settle()
    expect(walked()).toEqual(order.rows.map(row => row.uid ?? row.id))
    // Off the end of one section, j goes on into the next.
    await step('j'); expect(titled()).toBe(names[1])
    await step('j'); expect(titled()).toBe(names[2])
    await step('J'); expect(titled()).toBe('alpha')
    await step('J'); expect(titled()).toBe('draft')
    await step('K'); expect(titled()).toBe('alpha')
    await step('K'); expect(titled()).toBe(names[2])
    await step('K'); expect(titled()).toBe('n2')
  })
  it('keeps an off-Desk thread beside its nearest ancestor on the Desk, in that family\'s section', async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const raw = [
      thread({ id: 'draft', status: 'open' }),
      thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      // A quiet thread: the Desk names only the members that move.
      thread({ id: 'hub/sub', orchestrator: 'hub', status: 'open' }),
      thread({ id: 'settled', status: 'closed', tempered: true }),
      thread({ id: 'settled/ask', orchestrator: 'settled', status: 'active', ask: { text: 'Which cut?', at: '2026-07-02T12:00:00Z' } }),
      thread({ id: 'review', status: 'closed' }),
    ]
    const feed = raw, order = deskOrder(new ThreadIndex(feed), new Map())
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, deskRows: () => order.rows, deskPlacement: card => order.placements.get(deskCardKey(card)), threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    // A tempered top-level stands on the Desk while a thread of it waits.
    expect(order.rows.map(row => row.uid)).toEqual(['settled', 'settled-ask', 'hub', 'review', 'draft'])
    workspace.open(feed[2], 'desk', 'fiber:host-a:hub-sub'); await settle()
    expect(walked()).toEqual(['settled', 'settled-ask', 'hub', 'hub-sub', 'review', 'draft'])
    await step('k')
    expect(landed()).toBe('Working · hub')
    workspace.open(feed[3], 'desk'); await settle()
    await step('j')
    expect(landed()).toBe('Waiting on you · settled/ask')
    await step('J')
    expect(landed()).toBe('Working · hub')
  })
  it("leads a thread up its ancestry, by the band's trail and by b", async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [
      thread({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'hub/sub', orchestrator: 'hub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
      thread({ id: 'hub/sub/leaf', orchestrator: 'hub-sub', status: 'active', workerState: 'running', runtimePhase: 'working' }),
    ]
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const title = (): string | null | undefined => document.querySelector('.ws-stage-band .ws-band-title')?.textContent
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const press = async (key: string): Promise<void> => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); await settle() }
    workspace.open(feed[0], 'desk'); await settle()
    // Slugs throughout: the channel's slug, then whom the console speaks to; a lone family's channel is its top-level.
    expect(title()).toBe('hub')
    // The view draws the fiber's acts in its head; the console stands them as buttons where it has room.
    expect(document.querySelector('.ws-selected .ov-head .ov-tools .ws-acts-settings')).not.toBeNull()
    // A root has no orchestrator: no way back on its line, and b does nothing.
    expect(document.querySelector<HTMLElement>('.ws-stage-band .ws-settings-ancestry')?.hidden).toBe(true)
    await press('b')
    expect(title()).toBe('hub')
    // A thread opens on its own view.
    workspace.openFromDesk(feed[1]); await settle()
    expect([selected(), title()]).toStrictEqual(['family:host-a:hub-sub', 'hub/sub'])
    // b opens its orchestrator's view.
    await press('b')
    expect([selected(), title()]).toStrictEqual(['family:host-a:hub', 'hub'])
    workspace.open(feed[2], 'desk', 'fiber:host-a:hub-sub-leaf'); await settle()
    const links = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-stage-band .ws-settings-ancestry .ws-ancestry-link')]
    expect(links().map(b => b.textContent)).toEqual(['hub', 'sub'])
    links()[0].click(); await settle()
    expect(title()).toBe('hub')
  })
  it('lists the sent files from the toggle, newest first', async () => {
    workspace.open(cards[0], 'desk'); await settle()
    const toggle = document.querySelector<HTMLButtonElement>('.ws-files-toggle')!
    expect(toggle.hidden).toBe(false)
    toggle.click(); await settle()
    const rows = [...document.querySelectorAll<HTMLElement>('.kbn-conversation-menu .uf-file-row')]
    expect(rows.map(row => row.dataset.key)).toEqual(['host-a:/notes/alpha/table.html', 'host-a:/notes/alpha/report.html'])
  })
  it('hides the toggle for a constitution with no sent files', async () => {
    workspace.open(cards[1], 'desk'); await settle()
    expect(document.querySelector<HTMLElement>('.ws-files-toggle')!.hidden).toBe(true)
  })
  it('speaks to the view\'s own constitution: its band, its keys and its line', async () => {
    workspace.dispose()
    const hub = card({ id: 'hub', uid: 'hub', originId: 'host-a', name: 'Hub', status: 'active', shuttleKind: 'oneshot' })
    const leaf = card({ id: 'hub/leaf', uid: 'leaf', originId: 'host-a', name: 'Leaf', orchestrator: 'hub', status: 'active', shuttleKind: 'oneshot', sessionUuid: 'session', workerState: 'running' })
    const feed = [hub, leaf], dock = new Dock('', changed)
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock })
    const queue = vi.spyOn(workspace, 'queueVerdict').mockReturnValue(true)
    const conversation = vi.spyOn(dock, 'openConversation').mockReturnValue(true)
    workspace.openFromDesk(hub); await settle()
    expect(document.querySelector('.ws-band-title')?.textContent).toBe('hub')
    // A thread's row opens its own view, whose band speaks to it.
    document.querySelector<HTMLElement>('.ws-selected .ov-thread[data-fiber="leaf"]')!.click(); await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('family:host-a:leaf')
    expect(document.querySelector('.ws-band-title')?.textContent).toBe('hub/leaf')
    const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
    press('x'); expect(queue).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'leaf' }), 'composted')
    press('c'); expect(conversation).toHaveBeenLastCalledWith(expect.objectContaining({ uid: 'leaf' }))
    const input = document.querySelector<HTMLElement>('.ws-worker-message')!
    expect(input.dataset.placeholder).toBe('Message leaf')
    input.textContent = 'Hello'; input.dispatchEvent(new Event('input'))
    const send = document.querySelector<HTMLButtonElement>('.ws-worker-primary')!
    expect(send.getAttribute('aria-label')).toBe('Send Leaf')
    send.click(); await settle()
    const dispatch = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/api/v1/dispatch'))!
    expect(JSON.parse(String(dispatch[1]!.body))).toMatchObject({ fiber_id: 'hub/leaf', user_message: 'Hello', resume_mode: 'continue' })
  })
  it('lands every constitution on its own view, first in its run, and a fiber with neither threads nor a shuttle block on its own page', async () => {
    workspace.dispose()
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/leaf', orchestrator: 'hub', status: 'active' }), thread({ id: 'lone', status: 'active' })]
    bodyCards = feed
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    const pages = (): (string | null)[] => [...document.querySelectorAll('.ws-page')].map(page => page.getAttribute('data-key'))
    workspace.open(feed[0], 'desk'); await settle()
    expect(selected()).toBe('family:host-a:hub')
    expect(pages()[0]).toBe('family:host-a:hub')
    expect(document.querySelector('.ws-selected .ov-name')?.textContent).toBe('hub')
    workspace.open(feed[1], 'desk'); await settle()
    expect(selected()).toBe('family:host-a:hub-leaf')
    expect(document.querySelector('.ws-selected .ov-name')?.textContent).toBe('leaf')
    expect([...document.querySelectorAll('.ws-selected .ov-up .thread-row-slug')].map(el => el.textContent)).toStrictEqual(['hub'])
    workspace.open(feed[2], 'desk'); await settle()
    expect(selected()).toBe('family:host-a:lone')
    expect(workspace.familyDocument(card({ id: 'note', originId: 'host-a' }))).toBeUndefined()
  })
  it('lands a Desk click on a constitution\'s view, even after reading a page of it, a draft\'s included', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' }), thread({ id: 'hub/draft', orchestrator: 'hub', status: 'open' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    workspace.open(feed[1], 'desk', 'fiber:host-a:hub-mid'); await settle()
    expect(selected()).toBe('fiber:host-a:hub-mid')
    workspace.openFromDesk(feed[1]); await settle()
    expect(selected()).toBe('family:host-a:hub-mid')
    workspace.openFromDesk(feed[0]); await settle()
    expect(selected()).toBe('family:host-a:hub')
    workspace.openFromDesk(feed[2]); await settle()
    expect(selected()).toBe('family:host-a:hub-draft')
  })
  it('opens the page a session asks for: its constitution, its tapestry, or its view', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, fiberDir: `/notes/${over.id}`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/mid', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?')
      ? Response.json({ exists: new URL(String(input), 'http://workspace.test').searchParams.get('path') === '/notes/hub/mid/tapestry.html' })
      : original(input, init))
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    await workspace.openFiber('hub-mid', 'host-a', 'constitution'); await settle()
    expect(selected()).toBe('fiber:host-a:hub-mid')
    await workspace.openFiber('hub-mid', 'host-a', 'tapestry'); await settle()
    expect(selected()).toBe(docKey('host-a', '/notes/hub/mid/tapestry.html', 'host-a', '/notes/hub/mid'))
    await workspace.openFiber('hub-mid', 'host-a', 'files'); await settle()
    expect(selected()).toBe('family:host-a:hub-mid')
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [thread], origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    await workspace.openFiber('report-only', 'host-a', 'tapestry'); await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [thread, ...cards], origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const pending = workspace.openFiber('slow-pin', 'host-a', 'tapestry')
    await settle()
    expect(answer).toBeDefined()
    workspace.open(cards[0], 'desk'); await settle()
    const route = window.location.hash
    expect(route).toContain('alpha@host-a')
    answer(Response.json({ exists: true }))
    await pending; await settle()
    expect(window.location.hash).toBe(route)
  })

  it('does not steer Rex or voice when looking at or opening a constitution', async () => {
    const worker = card({ id: 'hub', uid: 'hub', originId: 'host-a', shuttleHost: 'host-a', shuttleKind: 'oneshot', status: 'active', path: 'hub.md', sessionUuid: 'session-hub', tmuxSession: 'worker-hub', workerState: 'running' })
    bodyCards = [worker]
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => [worker], origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    expect(await workspace.look(worker)).toBe(false)
    workspace.openFromDesk(worker); await settle()
    expect(selections()).toEqual([])
  })
  it('draws a lone constitution\'s view as its head with its pages, a draft\'s too, where its acts live', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'lone', status: 'active' }), thread({ id: 'draft', status: 'open' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.openFromDesk(feed[0]); await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('family:host-a:lone')
    expect(document.querySelectorAll('.ws-selected .ov-thread')).toHaveLength(0)
    expect(document.querySelector('.ws-selected .ov-head [data-part="constitution"]')).not.toBeNull()
    workspace.openFromDesk(feed[1]); await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('family:host-a:draft')
    expect(document.querySelector('.ws-selected .ov-head .ws-acts-verbs')).not.toBeNull()
  })
  it('draws the map under its label bar, whose back is the way back, with no document menu', async () => {
    const thread = (over: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard =>
      card({ uid: over.id.replace(/\//g, '-'), name: over.id, originId: 'host-a', shuttleKind: 'oneshot', path: `${over.id}.md`, ...over })
    const feed = [thread({ id: 'hub', status: 'active' }), thread({ id: 'hub/a', orchestrator: 'hub', status: 'active' })]
    bodyCards = feed
    workspace.dispose()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[0], 'desk'); await settle()
    expect(document.querySelector('.ws-selected .ws-menu-button')).toBeNull()
    expect(document.querySelector('.ws-selected .ws-expand-button')).toBeNull()
    expect(document.querySelector('.ws-stage-band .ws-band-back, .ws-stage-band .ws-band-leave')).toBeNull()
    expect(document.querySelector('.ws-selected .ws-labelbar .ws-document-back')).not.toBeNull()
  })
  it('steps the sections of the Desk, a seat and a schedule together in Roles & standing', async () => {
    workspace.dispose()
    const draft = card({ id: 'desk/draft', shuttleKind: 'oneshot' })
    const turn = card({ id: 'desk/turn', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'waiting' })
    const working = card({ id: 'desk/working', status: 'active', shuttleKind: 'oneshot', workerState: 'running', runtimePhase: 'working' })
    const review = card({ id: 'desk/review', status: 'closed', shuttleKind: 'oneshot' })
    const seat = card({ id: 'roles/editor', status: 'open', shuttleKind: 'standing', shuttleRole: 'editor', shuttleSeat: true })
    const stashed = card({ id: 'desk/stashed', shuttleKind: 'oneshot', effectiveHorizon: 'stashed' })
    const scheduled = card({ id: 'roles/scheduled', status: 'active', shuttleKind: 'standing', shuttleSchedule: '0 9 * * *', nextLaunchAt: '2026-10-30T09:00:00Z' })
    const order = deskOrder(new ThreadIndex([draft, turn, working, review, seat, stashed, scheduled]), new Map())
    const rows = order.rows
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => [...rows], deskRows: () => rows, deskPlacement: card => order.placements.get(deskCardKey(card)),
      threadIndex: () => new ThreadIndex(rows), origin: () => 'desk',
      onVisibility: visibility, dock: new Dock('', changed),
    })
    workspace.open(rows[0], 'desk'); await settle()
    expect(walked()).toEqual(rows.map(row => row.uid ?? row.id))
    expect(rows.map(row => row.id).slice(0, 2).sort()).toEqual(['desk/turn', 'desk/working'])
    expect(rows.map(row => row.id).slice(2)).toEqual(['desk/review', 'desk/draft', 'desk/stashed', 'roles/editor', 'roles/scheduled'])
    const sections: string[] = []
    for (let n = 0; n < 4; n++) { await step('J'); sections.push(landed()!.split(' · ')[0]) }
    expect(sections).toEqual(['Awaiting review', 'Drafts', 'Resting', 'Roles & standing'])
  })
  it('finds sent files from the phone\'s sheet on a cold Desk, without entering Reader until one is picked', async () => {
    workspace.dispose()
    document.body.replaceChildren()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(fetch).mockClear()
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const previous = document.createElement('button')
    document.body.append(previous); previous.focus()
    const route = window.location.hash
    workspace.findConstitution()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe(route)
    const find = document.querySelector<HTMLInputElement>('.ws-find-sheet input')!
    expect(document.activeElement).toBe(find)
    const files = (): number => document.querySelectorAll('.ws-find-sheet [data-section="files"] .ws-find-pick').length
    find.value = 'table.html'; find.dispatchEvent(new Event('input'))
    expect(files()).toBe(0)
    await settle()
    expect(files()).toBe(1)
    expect(document.activeElement).toBe(find)
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/sent-files/all/'))).toHaveLength(1)
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/api/v1/fibers/'))).toBe(false)
    find.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(previous)
    expect(document.querySelector('.ws-find-sheet')).toBeNull()
    workspace.findConstitution()
    const input = document.querySelector<HTMLInputElement>('.ws-find-sheet input')!
    const reads = vi.mocked(fetch).mock.calls.length
    input.value = 'table.html'; input.dispatchEvent(new Event('input'))
    expect(vi.mocked(fetch).mock.calls.length).toBe(reads)
    expect(files()).toBe(1)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()
    expect(workspace.isActive).toBe(true)
    expect(workspace.reader.el.querySelector('.ws-channel-title')?.textContent).toBe('alpha')
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
      workspace.open(cards[0], 'desk', landing === 'report.html' ? undefined : key); await settle()
      const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
      // Before the body, the selected page shows; the strip and ticks wait unseen, and stepping does nothing.
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      expect(workspace.reader.el.querySelector('.ws-tabs,.ws-page-ticks')).toBeNull()
      for (const press of ['G', 'l']) document.dispatchEvent(new KeyboardEvent('keydown', { key: press, bubbles: true, cancelable: true }))
      await settle()
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      release(); await settle(); await settle()
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
    workspace.open(cards[0]); await settle(); await settle()
    const prose = (): string => document.querySelector('.ws-prose')?.textContent ?? ''
    // The body is in hand: its prose shows and the loading note is gone, while the run waits.
    expect(prose()).toContain('The result is ready.')
    expect(document.querySelector('.ws-body-status')).toBeNull()
    expect(workspace.reader.el.querySelector('.ws-tabs,.ws-page-choice')).toBeNull()
    workspace.update(); await settle()
    release(); await settle(); await settle()
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
    workspace.open(cards[0]); await settle(); await settle()
    const table = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.open(cards[0], 'desk', table); await settle()
    const selected = (): string | null | undefined => document.querySelector('.ws-selected')?.getAttribute('data-key')
    expect(selected()).toBe(table)
    release(); await settle(); await settle()
    expect(selected()).toBe(table)
  })
  it('offers a sent page for download under its own name, through its owner', async () => {
    const table = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.open(cards[0], 'desk', table); await settle(); await settle()
    const download = document.querySelector<HTMLAnchorElement>('.ws-selected .ws-download')!
    expect(download.getAttribute('href')).toBe('/api/v1/file?path=%2Fnotes%2Falpha%2Ftable.html&origin=host-a')
    expect(download.download).toBe('table.html')
  })
  it('owner-routes file mtimes in Unix seconds for embeds and body links without reordering the strip', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/file-info?')) return new Response(JSON.stringify({ exists: true, modified_at: url.includes('report.html') ? 2000000000 : 1900000000 }))
      return original(input, init)
    })
    await feedNamesReport()
    workspace.open(cards[0]); await settle()
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
    await settle()
    const selectedKey = document.querySelector('.ws-selected')?.getAttribute('data-key')
    expect(workspace.reader.host.get(selectedKey!)?.doc.modifiedAt).toBe(new Date(1900000000 * 1000).toISOString())
  })
  it('opens on its report while owner file times are still being read', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (input, init) => String(input).includes('/file-info?') ? new Promise<Response>(() => {}) : original(input, init))
    await feedNamesReport()
    workspace.open(cards[0]); await settle()
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
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => shared, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })

    const reportA = docKey('host-a', '/notes/shared/report.html', 'host-a')
    const reportB = docKey('host-b', '/notes/shared/report.html', 'host-b')
    workspace.open(shared[0]); await settle()
    expect(workspace.reader.host.get(reportA)?.doc.provenance).toContainEqual({ kind: 'sent', time: 10, session: 'session-a' })
    const receiptCache = (workspace as unknown as { receipts: Map<string, { files: Array<{ uid?: string; host?: string }> }> }).receipts
    expect(receiptCache.get(JSON.stringify(['host-a', 'shared-uid']))?.files[0]).toMatchObject({ uid: 'shared-uid', host: 'host-a' })
    const byteOwned = workspace.reader.host.get(docKey('archive-host', '/remote/atlas.html', 'host-a'))
    expect(byteOwned?.doc.owner).toBe('archive-host')
    expect(byteOwned?.doc.provenance).toContainEqual({ kind: 'sent', time: 11, session: 'session-byte-owner' })
    workspace.open(shared[1]); await settle()
    expect(workspace.reader.host.get(reportB)?.doc.provenance).toContainEqual({ kind: 'sent', time: 20, session: 'session-b' })
    expect(workspace.reader.host.get(reportB)?.doc.provenance).not.toContainEqual(expect.objectContaining({ session: 'session-a' }))

    workspace.open(shared[0]); await settle()
    expect(workspace.reader.host.get(reportA)?.doc.provenance).toContainEqual({ kind: 'sent', time: 10, session: 'session-a' })
    workspace.open(shared[1]); await settle()
    failA = true
    workspace.open(shared[0]); await settle()
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
    await settle()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const frame = workspace.reader.host.get(reportKey)!
    const iframe = frame.content.querySelector('iframe')!
    expect(frame.el.classList.contains('ws-selected')).toBe(true)
    expect(window.location.hash).toContain(encodeURIComponent(reportKey))
    workspace.reader.openDocument('fiber:host-a:alpha')
    expect(frame.el.classList.contains('ws-receded')).toBe(true)
    workspace.reader.openDocument(reportKey)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }))
    expect(frame.el.classList.contains('ws-expanded')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(frame.el.classList.contains('ws-expanded')).toBe(false)
    workspace.reader.hide()
    expect(frame.el.classList.contains('ws-parked')).toBe(true)
    workspace.open(cards[0])
    await settle()
    expect(workspace.reader.host.get(reportKey)?.content.querySelector('iframe')).toBe(iframe)
    expect(frame.doc.provenance.filter(p => p.kind === 'sent')).toHaveLength(1)
  })

  it.each([false, true])('loads a neighbouring HTML page ahead of the reader only on a desktop (phone: %s)', async phone => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: phone && query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    await feedNamesReport()
    workspace.open(cards[0])
    await settle()
    const key = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const page = workspace.reader.host.get(key)!
    expect(workspace.reader.document?.kind).toBe('family')
    expect(!!page.content.querySelector('iframe')).toBe(!phone)
    workspace.reader.openDocument(key)
    await settle()
    expect(page.content.querySelector('iframe')).not.toBeNull()
  })

  it('opens a constitution\'s report under the band, and keeps body links and embeds on its fiber page', async () => {
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    await feedNamesReport()
    workspace.open(cards[0])
    await settle()
    expect(workspace.reader.document?.kind).toBe('family')
    workspace.reader.openDocument(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
    await settle()
    expect(workspace.reader.document?.name).toBe('report.html')
    const band = document.querySelector<HTMLElement>('.ws-stage-band')!
    expect(band.hidden).toBe(false)
    // The console is docked under the stage.
    expect(band.previousElementSibling?.classList.contains('ws-stage')).toBe(true)
    expect(document.querySelector('.ws-tab,.ws-thumbbar')).toBeNull()

    await pressConsoleAct(band, 'Constitution')
    expect(document.querySelector('.ws-page.ws-selected .ws-fiber-prose')).not.toBeNull()
    expect(workspace.reader.document?.kind).toBe('fiber')
    const article = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    expect(article.querySelector('.ws-dock')).toBeNull()
    expect(article.querySelector('.kbn-detail-lede')?.textContent).toContain('A checked result.')
    expect(band.hidden).toBe(false)
    const link = document.querySelector<HTMLAnchorElement>('.ws-selected a[data-file-path]')!
    link.click()
    await settle()
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
      shuttleBase: '', cards: () => ownerCards, origin: () => 'desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    const band = (): HTMLElement => document.querySelector<HTMLElement>('.ws-stage-band')!
    const name = (): string | null | undefined => band().querySelector('.ws-band-title')?.textContent
    const said = (): string | null | undefined => band().querySelector('.ws-band-title')?.getAttribute('title')
    workspace.open(ownerCards[0]); await settle()
    expect(band().hidden).toBe(false)
    expect([name(), said()]).toStrictEqual(['shared', 'Alpha copy'])
    const dock = band().querySelector('.ws-dock')
    workspace.open(ownerCards[1]); await settle()
    expect(said()).toBe('Beta copy')
    expect(band().querySelector('.ws-dock')).toBe(dock)
    expect(band().querySelectorAll('.ws-dock')).toHaveLength(1)
    workspace.open(ownerCards[2]); await settle()
    expect(band().hidden).toBe(true)
    expect(band().children).toHaveLength(0)
    workspace.open(ownerCards[0]); await settle()
    expect(band().hidden).toBe(false)
    expect(said()).toBe('Alpha copy')
  })

  it('retargets a renamed owner+uid band through Workspace.update', async () => {
    let liveCards = [card({ id: 'a/task', uid: 'stable-task', originId: 'host-a',
      path: 'a/task/task.md', fiberDir: '/notes/a/task', feltStore: '/notes/.felt',
      shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'host-a', shuttleProjectDir: '/work/a' })]
    bodyCards = liveCards
    workspace.dispose()
    const transition = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => liveCards, origin: () => 'desk', onVisibility: visibility,
      dock: new Dock('', changed, transition, vi.fn()),
    })
    workspace.open(liveCards[0])
    await settle()
    const band = document.querySelector<HTMLElement>('.ws-stage-band .ws-dock')!
    liveCards = [{ ...liveCards[0], id: 'b/task', path: 'b/task/task.md', fiberDir: '/notes/b/task',
      feltStore: '/new/.felt', shuttleHost: 'host-b', shuttleProjectDir: '/work/b',
      workerState: 'running', tmuxSession: 'new-worker', sessionUuid: 'new-session', runtimePhase: 'working', turn: 'working', column: 'inFlight' }]
    workspace.update()
    expect(document.querySelector('.ws-stage-band .ws-dock')).toBe(band)
    expect(await consoleActs(band)).toContain('Open conversation')
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const fresh = band.querySelector<HTMLButtonElement>('.ws-worker-acts button[data-verb="New session"]')!
    fresh.click()
    await settle()
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
    await settle()
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/dispatch'))!
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ fiber_id: 'b/task', origin: 'host-a', user_message: '', resume_mode: 'fresh' })
  })

  it('Escape gives inline and reader popovers first refusal, then collapses and returns', async () => {
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    workspace.open(cards[0])
    await settle()
    const escape = (): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true, cancelable: true }))
    const popover = vi.spyOn(workspace.dock, 'handleEscape').mockReturnValueOnce(true).mockReturnValue(false)
    escape()
    expect(popover).toHaveBeenCalledOnce()
    expect(document.querySelector('.ws-selected.ws-expanded')).not.toBeNull()

    const menuButton = document.querySelector<HTMLButtonElement>('.ws-phone-document-menu')!
    menuButton.focus(); menuButton.click()
    await settle()
    expect(document.querySelector('.ws-menu[data-open]')).not.toBeNull()
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.ws-menu[data-open]')).toBeNull()
    expect(document.activeElement).toBe(menuButton)
    expect(popover).toHaveBeenCalledOnce()
    escape()
    expect(document.querySelector('.ws-selected.ws-expanded')).toBeNull()
    expect(workspace.isActive).toBe(true)
    await pop(escape)
    expect(workspace.isActive).toBe(false)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    popover.mockRestore()
  })

  it('phone Back returns from the reader once; the inline controls add no history entry', async () => {
    workspace.dispose()
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('max-width'), addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    // A fresh entry, so the session history ends here whatever earlier tests went back over.
    window.history.pushState(null, '', '/')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const historyLength = window.history.length
    workspace.open(cards[0])
    await settle()
    const key = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const iframe = workspace.reader.host.get(key)!.content.querySelector('iframe')
    expect(window.history.length).toBe(historyLength + 1)
    const nextBack = (): Promise<void> => new Promise(resolve => { window.addEventListener('popstate', () => resolve(), { once: true }); window.history.back() })
    await nextBack()
    await settle()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe('')
    expect(workspace.reader.host.get(key)?.content.querySelector('iframe')).toBe(iframe)
    expect(visibility).toHaveBeenLastCalledWith(false)
  })

  it('opens the real worker conversation from the band and with c, without a panel on the fiber page', async () => {
    const live = { ...cards[0], shuttleKind: 'oneshot' as const, shuttleAgent: 'codex-sol', tmuxSession: 'terminal-alpha', shuttleHost: 'daemon-a', terminalBackend: 'rex' as const }
    const openWorker = vi.fn()
    bodyCards = [{ ...live, terminalBackend: undefined }]
    workspace.dispose()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => [live], origin: () => 'desk', onVisibility: visibility,
      dock: new Dock('', changed, undefined, openWorker),
    })
    workspace.open(live)
    await settle()
    // The console's menu and c reach the conversation; the top bar draws no second opener.
    expect(document.querySelector('.ws-navbar .ws-acts-console')).toBeNull()
    await pressConsoleAct(document.querySelector('.ws-stage-band')!, 'Open conversation')
    expect(openWorker).toHaveBeenLastCalledWith('terminal-alpha', 'daemon-a', undefined)
    openWorker.mockClear()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(openWorker).toHaveBeenCalledWith('terminal-alpha', 'daemon-a', undefined)
    expect(workspace.isActive).toBe(true)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    expect(document.querySelector('.ws-stage-band .ws-dock')).not.toBeNull()
    expect(document.querySelector('.ws-fiber-prose .ws-dock')).toBeNull()
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
      shuttleBase: '', cards: () => orderedCards, origin: () => 'desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.open(orderedCards[0])
    await settle()
    expect(workspace.reader.document?.key).toBe('fiber:host-a:first')
    workspace.open(orderedCards[1]); await settle()
    expect(workspace.reader.document?.key).toBe('fiber:host-b:second')
    const prose = workspace.reader.host.get('fiber:host-b:second')!.content
    expect(prose.querySelector('.ws-prose-documents')).toBeNull()
    expect(document.querySelector('.ws-tab')).toBeNull()
  })

  it('leaves the reader for its view by Escape from an opened file', async () => {
    workspace.open(cards[0]); await settle()
    const key = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.reader.openDocument(key)
    expect(workspace.reader.document?.key).toBe(key)
    await pop(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(workspace.isActive).toBe(false)
  })

  it('uses j/k for constitution order and held arrows for document scrolling', async () => {
    workspace.open(cards[1])
    await settle()
    const ordered = [cards[0], cards[1]]
    workspace.open(ordered[0])
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(slug(ordered[1]))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    await settle()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(slug(ordered[0]))

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
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }))
    expect(workspace.reader.el.classList.contains('ws-keyboard')).toBe(true)
    document.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    expect(workspace.reader.el.classList.contains('ws-keyboard')).toBe(false)
  })

  it('keeps label controls and their keyboard focus through metadata polls', async () => {
    workspace.open(cards[0])
    await settle()
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-document-back')!
    control.focus()
    workspace.update()
    expect(document.querySelector('.ws-selected .ws-document-back')).toBe(control)
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
    workspace.open(cards[0]); await settle()
    expect(selected()).toBe('fiber:host-a:alpha')
    deliver(); await settle()
    expect(workspace.reader.host.get(reportKey)).toBeTruthy()
    expect(selected()).toBe('fiber:host-a:alpha')
    expect(window.location.hash).not.toContain(encodeURIComponent(reportKey))
    // A routed page paints at once from a provisional frame, before its receipts.
    workspace.dispose()
    window.history.replaceState(null, '', '/')
    workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, dock: new Dock('', changed) })
    const tableKey = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(tableKey)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    expect(selected()).toBe(tableKey)
    const frame = workspace.reader.host.get(tableKey)!.el
    deliver(); await settle()
    expect(selected()).toBe(tableKey)
    expect(workspace.reader.host.get(tableKey)!.el).toBe(frame)
  })

  it('paints a routed page while file metadata is still unanswered', async () => {
    const original = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation((input, init) => String(input).includes('/file-info?') ? new Promise<Response>(() => {}) : original(input, init))
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(reportKey)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
  })

  it('keeps a fresh deep-linked file addressable even outside the document index, returning directly to Channels', async () => {
    const gone = docKey('host-a', '/notes/alpha/gone.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(gone)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    expect(workspace.reader.document?.key).toBe(gone)
    workspace.reader.back()
    expect(workspace.isActive).toBe(false)
    expect(window.location.hash).toBe('#/channels')
  })

  it('keeps an explicit prose selection made while the body is loading', async () => {
    let deliver: (value: Response) => void = () => {}
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/v1/fibers/work/')
      ? new Promise<Response>(resolve => { deliver = resolve }) : originalFetch(url)))
    workspace.open(cards[0])
    workspace.reader.openDocument('fiber:host-a:alpha')
    deliver(fiberReadResponse(cards[0]))
    await settle()
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
    await settle()
    workspace.open(managed)
    await settle()
    const band = document.querySelector<HTMLElement>('.ws-stage-band .ws-dock')!
    expect(band.querySelector('.kbn-detail-controls-toggle')?.textContent).toContain('codex-sol')
  })

  it('gives an unknown routed fiber its own retryable failure page', async () => {
    workspace.open(cards[0])
    await settle()
    window.history.replaceState(null, '', '#/board/no-card@host-b')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await settle()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('no-card')
    expect(document.querySelector('.ws-selected')?.textContent).toContain('Fiber not found on host-b')
    expect(document.querySelector('.ws-selected')?.textContent).toContain('Retry')
    expect(window.location.hash).toContain('no-card@host-b')
  })

  it('mouse entry does not focus chrome, but keyboard entry does', async () => {
    workspace.open(cards[1])
    await settle()
    workspace.open(cards[0])
    await settle()
    expect(document.activeElement).not.toBe(document.querySelector('.ws-return'))
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-document-back')!
    const press = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    control.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await settle()
    expect(document.activeElement).toBe(document.querySelector('.ws-return'))
  })

  it('keeps Alt-arrow stepping in Desk order and ignores messages from unrelated frames', async () => {
    workspace.open(cards[1])
    await settle()
    const ordered = [cards[0], cards[1]]
    const hash = window.location.hash
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shuttle-workspace-key', key: 'ArrowRight' }, source: window }))
    expect(window.location.hash).toBe(hash)
    workspace.open(ordered[0])
    await settle()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await settle()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(slug(ordered[1]))
    expect(window.location.hash).toContain(`${ordered[1].uid ?? ordered[1].id}@${ordered[1].originId}`)
    expect(visibility).toHaveBeenCalledWith(true)
  })

  it('restores a Desk-opened channel over Desk after reload', async () => {
    workspace.open(cards[0])
    await settle()
    expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'desk' } })

    workspace.dispose()
    document.body.replaceChildren()
    const onView = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => cards, origin: () => 'channels', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    await settle()

    expect(onView).toHaveBeenCalledWith('desk')
    expect(document.querySelector('.ws-return')?.getAttribute('aria-label')).toBe('Back to Desk')
  })

  it('restores the Channels return for a file route after reload', async () => {
    workspace.suspend('channels')
    await settle()
    await feedNamesReport()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    workspace.open(cards[0], 'channels', reportKey)
    await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'channels', layer: true } })

    workspace.dispose()
    document.body.replaceChildren()
    const onView = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => boardCards, origin: () => 'desk', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    await settle()
    expect(onView).toHaveBeenCalledWith('channels')
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(reportKey)

    const returned = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    await returned
    await settle()
    expect(window.location.hash).toBe('#/channels')
    expect(workspace.reader.isActive).toBe(false)
  })

  it('returns to Channels in one step after reloading on a second file', async () => {
    workspace.suspend('channels')
    await settle()
    await feedNamesReport()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const tableKey = docKey('host-a', '/notes/alpha/table.html', 'host-a')
    workspace.open(cards[0], 'channels', reportKey)
    await settle()
    expect(workspace.reader.host.get(tableKey)).toBeTruthy()
    workspace.reader.openDocument(tableKey)
    await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(tableKey)
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'channels', layer: true } })

    workspace.dispose()
    document.body.replaceChildren()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => boardCards, origin: () => 'desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    await settle()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(tableKey)

    const returned = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    workspace.reader.back()
    await returned
    await settle()
    expect(window.location.hash).toBe('#/channels')
  })

  it('redirects the old Board address to Channels', async () => {
    workspace.dispose()
    window.history.replaceState(null, '', '#/board')
    const onView = vi.fn()
    workspace = makeWorkspace(document.body, {
      shuttleBase: '', cards: () => cards, origin: () => 'desk', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    await settle()
    expect(window.location.hash).toBe('#/channels')
    workspace.open(cards[0])
    await settle()
    await pop(() => workspace.returnToOrigin())
    expect(window.location.hash).toBe('#/channels')
  })
})

describe('a constitution\'s view', () => {
  /** Trees of threads as parent indices: node n > 0 hangs under some earlier node. */
  const trees = fc.array(fc.nat(), { minLength: 1, maxLength: 6 }).map(picks => picks.map((pick, n) => pick % (n + 1)))
  const step = fc.oneof(
    fc.record({ act: fc.constantFrom('open', 'desk', 'row', 'up'), at: fc.nat() }),
    fc.record({ act: fc.constant('b'), at: fc.constant(0) }),
  )
  it('is always of the constitution it shows, its band and its keys speaking to it, however it is entered and walked', async () => {
    await fc.assert(fc.asyncProperty(trees, fc.array(step, { minLength: 1, maxLength: 8 }), async (parents, steps) => {
      const ids = ['root', ...parents.map((_, n) => `t${n + 1}`)]
      const path = (n: number): string => n === 0 ? 'root' : `${path(parents[n - 1])}/${ids[n]}`
      const feed = ids.map((id, n) => card({
        id: path(n), uid: id, name: id === 'root' ? 'Root' : id, originId: 'host-a', shuttleKind: 'oneshot', status: 'active', path: `${path(n)}.md`,
        ...(n ? { orchestrator: ids[parents[n - 1]] } : {}),
      }))
      bodyCards = feed
      workspace.dispose()
      const dock = new Dock('', changed)
      vi.spyOn(dock, 'openConversation').mockReturnValue(true)
      workspace = makeWorkspace(document.body, { shuttleBase: '', cards: () => feed, threadIndex: () => new ThreadIndex(feed), origin: () => 'desk', onVisibility: visibility, dock })
      const queue = vi.spyOn(workspace, 'queueVerdict').mockReturnValue(true)
      const title = (): string | null | undefined => document.querySelector('.ws-stage-band .ws-band-title')?.textContent
      const press = (key: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) }
      workspace.openFromDesk(feed[0]); await settle()
      for (const { act, at } of steps) {
        const target = feed[at % feed.length]
        if (act === 'open') workspace.open(target, 'desk')
        else if (act === 'desk') workspace.openFromDesk(target)
        else if (act === 'row') document.querySelector<HTMLElement>(`.ws-selected .ov-thread[data-fiber="${target.uid}"]`)?.click()
        else if (act === 'up') document.querySelector<HTMLElement>(`.ws-selected .ov-ancestor[data-fiber="${target.uid}"]`)?.click()
        else press('b')
        await settle()
        const shown = document.querySelector('.ws-selected')?.getAttribute('data-key')?.replace('family:host-a:', '')
        const card = feed.find(each => each.uid === shown)
        expect(card).toBeDefined()
        expect(document.querySelector('.ws-selected .ov-name')?.textContent).toBe(card!.id.split('/').pop())
        expect(title()).toBe(card!.uid === 'root' ? 'root' : `root/${card!.uid}`)
        press('x')
        expect(queue.mock.lastCall?.[0].uid).toBe(card!.uid)
      }
    }), { numRuns: 20 })
  }, 120_000)
})
