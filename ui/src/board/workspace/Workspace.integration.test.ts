// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { ColumnKind, KanbanCard } from '../KanbanTypes.js'
import { Workspace } from './Workspace.js'
import { Dock } from './Dock.js'
import { docKey } from './documents.js'
import { resetLanes } from '../requestLanes.js'

vi.mock('../FileViewerPanel.js', () => ({
  readThumbnailMetadata: vi.fn(async () => {}),
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
const cards = [
  card({ id: 'work/alpha', uid: 'alpha', name: 'Alpha', originId: 'host-a', fiberDir: '/notes/alpha', path: 'work/alpha/alpha.md' }),
  card({ id: 'work/beta', uid: 'beta', name: 'Beta', originId: 'host-b', fiberDir: '/notes/beta', path: 'work/beta/beta.md' }),
]
const body = 'The result is ready.\n\n:::{embed} report.html\n:title: Report\n:::\n\n[Data](data.csv)'
let bodyCards: KanbanCard[] = cards
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
  return new Response(JSON.stringify({
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
  }))
}
// Microtask depth varies with the Node runtime (undici fetch/Response hops), so drain generously.
const flush = async (): Promise<void> => { for (let i = 0; i < 200; i++) await Promise.resolve() }
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
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  bodyCards = cards
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
  workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock("", changed) })
})
afterEach(() => { resetLanes(); workspace?.dispose(); vi.useRealTimers(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('workspace reader integration', () => {
  it('names the roster the feed carries and repaints the page when it changes', async () => {
    const original = cards[0]
    const roles = (): string[] => [...document.querySelectorAll('.ws-fiber-role')].map(role => role.textContent ?? '')
    try {
      // The body read carries no roster; the feed's card does, and it holds across the read.
      cards[0] = { ...original, roles: ['surveyor'] }
      workspace.open(cards[0]); await flush(); await flush()
      expect(roles()).toEqual(['surveyor'])
      cards[0] = { ...original, roles: ['surveyor', 'scribe'] }
      workspace.update(); await flush()
      expect(roles()).toEqual(['surveyor', 'scribe'])
      cards[0] = original
      workspace.update(); await flush()
      expect(roles()).toEqual([])
    } finally { cards[0] = original }
  })

  it('gives a role page its holds from the feed and none of a constitution\'s controls', async () => {
    const original = cards[0]
    const role = card({ id: 'roles/surveyor', uid: 'surveyor-uid', name: 'Surveyor', originId: 'host-a', fiberDir: '/roles/surveyor', path: 'roles/surveyor/surveyor.md' })
    cards[0] = { ...original, shuttleKind: 'oneshot', roles: ['surveyor'] }
    bodyCards = [...cards, role]
    onTestFinished(() => { cards[0] = original })
    const holds = (): string[] => [...document.querySelectorAll('.ws-role-hold-name')].map(name => name.textContent ?? '')
    workspace.open(role); await flush(); await flush()
    expect(holds()).toEqual(['Alpha'])
    const page = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    for (const chrome of ['.ws-dock', '.kbn-detail-controls', '.kbn-ctl-history-toggle', '.kbn-detail-directive', '.kbn-ctl-verdict']) {
      expect(page.querySelector(chrome), chrome).toBeNull()
    }
    // A role is outside the feed; its holds still follow the feed's rosters.
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    workspace.update(); await flush()
    expect(holds()).toEqual([])
    expect(document.querySelector('[data-part="role-holds"]')).toBeNull()
    cards[0] = { ...original, shuttleKind: 'oneshot', roles: ['surveyor'] }
    workspace.update(); await flush()
    document.querySelector<HTMLButtonElement>('.ws-role-hold')!.click()
    await flush(); await flush()
    expect(document.querySelector('.ws-selected [data-part="fiber-title"]')?.textContent).toBe('Alpha')
    expect(document.querySelector('.ws-fiber-prose .ws-dock')).not.toBeNull()
  })

  it('draws a key verdict in place of the pair, takes a click verdict after undo, and commits only the live identity after a move', async () => {
    workspace.dispose()
    const reviewing = card({ id: 'work/review', uid: 'stable-review', name: 'Review', originId: 'host-a',
      path: 'work/review/review.md', fiberDir: '/notes/review', status: 'closed', shuttleKind: 'oneshot' })
    let live = reviewing
    bodyCards = [reviewing]
    const commit = vi.fn()
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => [live], origin: () => 'Desk',
      onVisibility: visibility, dock: new Dock('', changed, commit) })
    workspace.open(reviewing); await flush()
    vi.useFakeTimers()
    const pair = document.querySelector<HTMLElement>('.ws-fiber-acts .kbn-ctl-verdict')!
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
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'Desk',
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
      workspace = new Workspace(document.body, { shuttleBase: '', cards: () => [fiber], origin: () => 'Desk',
        onVisibility: visibility, dock: new Dock('', changed, commit) })
      workspace.open(fiber); await flush()
      return document.querySelector<HTMLElement>('.ws-fiber-acts .kbn-ctl-verdict')!
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
      shuttleSurface: 'app', sessionUuid: 'thread-1' })
    let live = [app]
    bodyCards = live
    const commit = vi.fn()
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => live, origin: () => 'Desk',
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
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => [], origin: () => 'Desk',
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
  it('groups the sidebar as Drafts, In flight\'s bands and Awaiting review wherever it opens, skipping an empty band, stepping it with j/k', async () => {
    workspace.dispose()
    localStorage.setItem('shuttle:workspace:sidebar', 'true')
    const returned = vi.fn()
    const grouped = [{ ...cards[0], status: 'closed' }, { ...cards[1], status: 'active' }]
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => grouped, origin: () => 'Board', onVisibility: visibility,
      onReturnCard: returned, dock: new Dock('', changed),
    })
    workspace.open(grouped[0], 'Board'); await flush()
    expect([...document.querySelectorAll('.ws-sidebar .kbn-flight-caption')].map(el => el.textContent)).toEqual(['Working', 'Awaiting review'])
    expect(document.querySelectorAll('.ws-sidebar .kbn-card')).toHaveLength(2)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })); await flush()
    expect(document.querySelector('.ws-sidebar [aria-current="true"]')?.getAttribute('data-channel-uid')).toBe('beta')
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Beta')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(returned).toHaveBeenCalledWith(expect.objectContaining({ uid: 'beta', originId: 'host-b' }))
  })
  it.each(['draft', 'aloft', 'holding', 'review'])('shows a %s head’s queue without putting its children in any lifecycle group or navigation count', async band => {
    workspace.dispose()
    localStorage.setItem('shuttle:workspace:sidebar', 'true')
    const head = { ...cards[0], status: band === 'draft' ? 'open' : band === 'review' ? 'closed' : 'active', runtimePhase: band === 'holding' ? 'waiting' : 'working' }
    const queued = { ...cards[1], dependsOn: [head.uid!.toUpperCase()], dependsOnShape: 'scalar' as const, foldedUnder: head.id }
    const review = { ...queued, id: 'work/review', uid: 'review', name: 'Review', status: 'closed', dependsOn: [queued.id], foldedUnder: undefined }
    const foldedAloft = { ...queued, id: 'work/folded-aloft', uid: 'folded-aloft', status: 'active', runtimePhase: 'working', workerState: 'running' as const, tmuxSession: 'aloft-worker', foldedUnder: undefined }
    const foldedHolding = { ...queued, id: 'work/folded-holding', uid: 'folded-holding', status: 'active', runtimePhase: 'waiting', foldedUnder: undefined }
    const other = { ...cards[1], id: 'work/other', uid: 'other', name: 'Other', status: 'closed' }
    const feed = [review, head, queued, foldedAloft, foldedHolding, other]
    bodyCards = feed
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => feed, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(head, 'Desk'); await flush()
    const rows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.ws-sidebar .ws-channel-row')]
    expect(rows().map(row => row.dataset.channelUid)).toEqual(['alpha', 'other'])
    const chip = rows()[0].querySelector<HTMLButtonElement>('.kbn-card-queued')!
    expect(chip.textContent).toBe('+4 queued')
    chip.click()
    expect(chip.getAttribute('aria-expanded')).toBe('true')
    expect(rows()[0].querySelector<HTMLOListElement>('.kbn-card-queued-list')!.hidden).toBe(false)
    rows()[0].querySelector<HTMLElement>('.kbn-card-queued-row[data-card-uid="beta"]')!.click(); await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Beta')
    expect(rows().map(row => row.dataset.channelUid)).toEqual(['alpha', 'other'])
    expect([...document.querySelectorAll('.ws-sidebar-index-count')].reduce((sum, el) => sum + Number(el.textContent), 0)).toBe(2)
    // A child opened from the peek steps from its head, never becoming a stop.
    const press = async (key: string): Promise<void> => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === key.toUpperCase(), bubbles: true, cancelable: true })); await flush()
    }
    const current = (): string | undefined => rows().find(row => row.getAttribute('aria-current') === 'true')?.dataset.channelUid
    await press('j'); expect(current()).toBe('other')
    await press('k'); expect(current()).toBe('alpha')
    await press('J'); expect(current()).toBe(band === 'review' ? 'alpha' : 'other')
    await press('K'); expect(current()).toBe('alpha')
    expect(rows().map(row => row.dataset.channelUid)).toEqual(['alpha', 'other'])
  })
  it('captions In flight as its Question and Working bands even from an interleaved feed, and J/K stops at each', async () => {
    workspace.dispose()
    localStorage.setItem('shuttle:workspace:sidebar', 'true')
    const flight = (uid: string, runtimePhase?: KanbanCard['runtimePhase']): KanbanCard =>
      ({ ...cards[1], id: `work/${uid}`, uid, name: uid, path: `work/${uid}/${uid}.md`, status: 'active', runtimePhase })
    const feed = [{ ...cards[0], status: 'closed' }, flight('w1', 'working'), flight('n1', 'waiting'), flight('w2', 'working'), flight('n2', 'blocked'), { ...cards[1], uid: 'draft', id: 'work/draft', name: 'draft' }]
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => feed, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[0], 'Desk'); await flush()
    const current = (): string | null | undefined => document.querySelector('.ws-sidebar [aria-current="true"]')?.getAttribute('data-channel-uid')
    expect([...document.querySelectorAll<HTMLElement>('.ws-sidebar .ws-channel-row')].map(row => row.dataset.channelUid)).toEqual(['draft', 'n1', 'n2', 'w1', 'w2', 'alpha'])
    expect([...document.querySelectorAll('.ws-sidebar .kbn-flight-caption')].map(el => el.textContent)).toEqual(['Drafts', 'Question', 'Working', 'Awaiting review'])
    const press = async (key: string): Promise<void> => { document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === key.toUpperCase(), bubbles: true, cancelable: true })); await flush() }
    await press('K'); expect(current()).toBe('w1')
    await press('j'); expect(current()).toBe('w2')
    await press('K'); expect(current()).toBe('n1')
    await press('J'); expect(current()).toBe('w2')
    await press('J'); expect(current()).toBe('alpha')
  })
  it('draws one index strip naming each J/K stop and its count, marks the open group, and lands a click as J/K would', async () => {
    workspace.dispose()
    localStorage.setItem('shuttle:workspace:sidebar', 'true')
    const flight = (uid: string, runtimePhase?: KanbanCard['runtimePhase']): KanbanCard =>
      ({ ...cards[1], id: `work/${uid}`, uid, name: uid, path: `work/${uid}/${uid}.md`, status: 'active', runtimePhase })
    const feed = [flight('w1', 'working'), flight('w2', 'working'), flight('n1', 'waiting'), { ...cards[0], status: 'closed' }]
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => feed, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
    workspace.open(feed[3], 'Desk'); await flush()
    const entries = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-sidebar-index-entry')]
    const current = (): string | null | undefined => document.querySelector('.ws-sidebar [aria-current="true"]')?.getAttribute('data-channel-uid')
    // Empty groups draw no entry; the strip abbreviates Awaiting review, its caption does not.
    expect(entries().map(entry => entry.textContent)).toEqual(['Question1', 'Working2', 'Review1'])
    expect(entries().map(entry => entry.getAttribute('aria-label'))).toEqual(['Question, 1', 'Working, 2', 'Awaiting review, 1'])
    expect(entries().filter(entry => entry.getAttribute('aria-current') === 'location').map(entry => entry.title)).toEqual(['Awaiting review'])
    entries()[1].click(); await flush()
    expect(current()).toBe('w1')
    expect(entries().find(entry => entry.getAttribute('aria-current') === 'location')?.title).toBe('Working')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); await flush()
    expect(current()).toBe('w2')
    entries()[2].click(); await flush()
    expect(current()).toBe('alpha')
    // Back in Working, the click lands on the card last open there.
    entries()[1].click(); await flush()
    expect(current()).toBe('w2')
  })
  it('indexes fleet filenames on a cold Desk and refreshes an open picker without entering Reader', async () => {
    workspace.dispose()
    document.body.replaceChildren()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    vi.mocked(fetch).mockClear()
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
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
      const run = [workspace.reader.el.querySelector('.ws-tabs')!, workspace.reader.barPosition, workspace.reader.el.querySelector('.ws-page-ticks')!]
      const tabs = (): string[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].map(tab => tab.classList.contains('ws-tab-anchor') ? '§' : tab.dataset.tabKey!)
      const selected = (): string | undefined => document.querySelector<HTMLElement>('.ws-tab[aria-selected="true"]')?.dataset.tabKey
      // Before the body, the selected page shows; the strip, ticks and count wait unseen, and stepping does nothing.
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      for (const el of run) expect(el.classList.contains('ws-run-pending'), el.className).toBe(true)
      for (const press of ['G', 'l', 'h']) document.dispatchEvent(new KeyboardEvent('keydown', { key: press, bubbles: true, cancelable: true }))
      await flush()
      expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(key)
      release(); await flush(); await flush()
      for (const el of run) expect(el.classList.contains('ws-run-pending'), el.className).toBe(false)
      // The body declares the report, which runs left of the fiber page; the sent table runs right.
      expect(tabs()).toEqual([docKey('host-a', '/notes/alpha/report.html', 'host-a'), '§', docKey('host-a', '/notes/alpha/table.html', 'host-a')])
      expect(selected()).toBe(key)
      // Once the run lands, the same keys step through it.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: landing === 'report.html' ? 'G' : 'g', bubbles: true, cancelable: true })); await flush()
      expect(selected()).not.toBe(key)
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
    const strip = workspace.reader.el.querySelector('.ws-tabs')!
    const prose = (): string => document.querySelector('.ws-prose')?.textContent ?? ''
    // The body is in hand: its prose shows and the loading note is gone, while the run waits.
    expect(prose()).toContain('The result is ready.')
    expect(document.querySelector('.ws-body-status')).toBeNull()
    expect(strip.classList.contains('ws-run-pending')).toBe(true)
    const choice = workspace.reader.el.querySelector('.ws-page-choice')!
    const live = workspace.reader.el.querySelector(':scope > .ws-sr-only[aria-live]')!
    expect(choice.getAttribute('aria-disabled')).toBe('true')
    expect(live.textContent).toBe('')
    // A feed-poll repaint in this window keeps the strip pending.
    workspace.update(); await flush()
    expect(strip.classList.contains('ws-run-pending')).toBe(true)
    release(); await flush(); await flush()
    expect(strip.classList.contains('ws-run-pending')).toBe(false)
    expect(choice.getAttribute('aria-disabled')).toBe('false')
    expect(live.textContent).toBe('Note, 2 of 3')
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].map(tab => tab.classList.contains('ws-tab-anchor') ? '§' : tab.dataset.tabKey!)
    expect(tabs).toEqual([docKey('host-a', '/notes/alpha/report.html', 'host-a'), '§', docKey('host-a', '/notes/alpha/table.html', 'host-a')])
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
    const order = [...document.querySelectorAll('.ws-tab')].map(tab => tab.getAttribute('aria-label'))
    // The declared report sits left of the fiber page, the sent table right; the report's newer file time moves neither.
    expect(order).toEqual(['Report', 'Note', 'table.html'])
    const metadataRequests = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes('/file-info?'))
    expect(metadataRequests.every(([url]) => String(url).includes('origin=host-a'))).toBe(true)
    document.querySelector<HTMLButtonElement>('.ws-tab[aria-label="Note"]')!.click()
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
    expect([...document.querySelectorAll('.ws-tab')].map(tab => tab.getAttribute('aria-label'))).toContain('table.html')
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
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => shared, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })

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
    const reportIndex = workspace.reader.host.get(reportKey) ? [...document.querySelectorAll('.ws-tab')].findIndex(tab => tab.getAttribute('aria-selected') === 'true') : -1
    const away = reportIndex === document.querySelectorAll('.ws-tab').length - 1 ? 'ArrowLeft' : 'ArrowRight'
    document.dispatchEvent(new KeyboardEvent('keydown', { key: away, altKey: true, bubbles: true }))
    expect(frame.el.classList.contains('ws-receded')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: away === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft', altKey: true, bubbles: true }))
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

  it('keeps body links and embeds while placing the outcome above inline controls', async () => {
    // Inline controls belong to a fiber on the Desk's lifecycle.
    const original = cards[0]
    cards[0] = { ...original, shuttleKind: 'oneshot' }
    onTestFinished(() => { cards[0] = original })
    workspace.open(cards[0])
    await flush()
    const article = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    const header = article.querySelector('header')!
    const band = article.querySelector<HTMLElement>('.ws-dock')!
    const outcome = article.querySelector<HTMLElement>('.kbn-detail-lede')!
    expect(header.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(outcome.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()

    const proseTab = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].find(b => b.getAttribute('aria-label') === 'Constitution')!
    proseTab.click()
    const link = document.querySelector<HTMLAnchorElement>('.ws-selected a[data-file-path]')!
    link.click()
    await flush()
    expect(workspace.reader.host.get(docKey('host-a', '/notes/alpha/report.html', 'host-a'))).toBeDefined()
    const dataFrame = workspace.reader.host.get(docKey('host-a', '/notes/alpha/data.csv', 'host-a'))!
    expect(dataFrame.doc.provenance.some(p => p.kind === 'link')).toBe(true)
    expect(dataFrame.el.classList.contains('ws-selected')).toBe(true)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
  })

  it('toggles the sidebar without replacing the selected iframe or its window', async () => {
    await feedNamesReport()
    workspace.open(cards[0])
    await flush()
    const frame = workspace.reader.host.get(docKey('host-a', '/notes/alpha/report.html', 'host-a'))!
    const iframe = frame.content.querySelector('iframe')!
    const innerWindow = iframe.contentWindow
    const toggle = document.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    expect(toggle.querySelector('svg')).not.toBeNull()
    expect(toggle.title).toBe('Constitutions · s')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(workspace.reader.el.classList.contains('ws-with-sidebar')).toBe(false)
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(workspace.reader.el.querySelector('.ws-sidebar')?.getAttribute('aria-label')).toBe('Constitutions')
    expect(workspace.reader.el.querySelector('.ws-sidebar .ws-channel-find')?.getAttribute('aria-label')).toBe('Find a constitution')
    expect(localStorage.getItem('shuttle:workspace:sidebar')).toBe('true')
    expect(frame.content.querySelector('iframe')).toBe(iframe)
    expect(iframe.contentWindow).toBe(innerWindow)
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(frame.content.querySelector('iframe')).toBe(iframe)
  })

  it('retains each composer draft by owner and uid across channel switches', async () => {
    const ownerCards = [
      card({ id: 'work/shared', uid: 'same-uid', name: 'Alpha copy', originId: 'host-a', fiberDir: '/notes/a', path: 'work/shared/shared.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }),
      card({ id: 'work/shared', uid: 'same-uid', name: 'Beta copy', originId: 'host-b', fiberDir: '/notes/b', path: 'work/shared/shared.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }),
    ]
    bodyCards = ownerCards
    workspace.dispose()
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => ownerCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.open(ownerCards[0])
    await flush()
    const bandA = workspace.dock.bandFor(ownerCards[0]).el
    const textareaA = bandA.querySelector<HTMLTextAreaElement>('textarea')!
    textareaA.value = 'host A draft'
    textareaA.dispatchEvent(new Event('input', { bubbles: true }))

    workspace.open(ownerCards[1])
    await flush()
    const bandB = workspace.dock.bandFor(ownerCards[1]).el
    const textareaB = bandB.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textareaB).not.toBe(textareaA)
    expect(textareaB.value).toBe('')
    textareaB.value = 'host B draft'

    workspace.open(ownerCards[0])
    await flush()
    expect(workspace.dock.bandFor(ownerCards[0]).el).toBe(bandA)
    expect(bandA.querySelector('textarea')).toBe(textareaA)
    expect(textareaA.value).toBe('host A draft')
    workspace.open(ownerCards[1])
    await flush()
    expect(workspace.dock.bandFor(ownerCards[1]).el.querySelector('textarea')).toBe(textareaB)
    expect(textareaB.value).toBe('host B draft')
  })

  it('retargets a renamed owner+uid band through Workspace.update without losing its draft', async () => {
    let liveCards = [card({ id: 'a/task', uid: 'stable-task', originId: 'host-a',
      path: 'a/task/task.md', fiberDir: '/notes/a/task', feltStore: '/notes/.felt',
      shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'host-a', shuttleProjectDir: '/work/a' })]
    bodyCards = liveCards
    workspace.dispose()
    const transition = vi.fn()
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => liveCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed, transition),
    })
    workspace.open(liveCards[0])
    await flush()
    const band = document.querySelector<HTMLElement>('.ws-fiber-prose .ws-dock')!
    const draft = band.querySelector<HTMLTextAreaElement>('textarea')!
    draft.value = 'Keep this draft'
    liveCards = [{ ...liveCards[0], id: 'b/task', path: 'b/task/task.md', fiberDir: '/notes/b/task',
      feltStore: '/new/.felt', shuttleHost: 'host-b', shuttleProjectDir: '/work/b',
      workerState: 'running', tmuxSession: 'new-worker', sessionUuid: 'new-session', runtimePhase: 'working' }]
    workspace.update()
    expect(band.querySelector('textarea')).toBe(draft)
    expect(draft.value).toBe('Keep this draft')
    expect(document.querySelectorAll('.kbn-card-worker:not(.ws-sidebar *):not(.ws-navbar *):not(.ws-fiber-acts *)')).toHaveLength(0)
    expect(document.querySelectorAll('.ws-fiber-acts .kbn-card-worker')).toHaveLength(1)
    expect(document.querySelector('.ws-navbar .ws-head-worker .kbn-card-worker')?.textContent).toMatch(/^aloft/)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    band.querySelector<HTMLButtonElement>('.kbn-ctl-sends .kbn-ctl-send:not(.kbn-ctl-resume)')!.click()
    expect(confirm).toHaveBeenCalledOnce()
    vi.useFakeTimers()
    confirm.mockReturnValue(true)
    // In flight, the status line carries the verdict pair.
    document.querySelector<HTMLButtonElement>('.ws-fiber-acts .kbn-ctl-temper')!.click()
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
    band.querySelector<HTMLButtonElement>('.kbn-ctl-resume')!.click()
    await flush()
    const request = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/dispatch'))!
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ fiber_id: 'b/task', origin: 'host-a', user_message: 'Keep this draft' })
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
    const band = workspace.dock.bandFor(cards[0])
    const popover = vi.spyOn(band, 'handleEscape').mockReturnValueOnce(true).mockReturnValue(false)
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
    const returned = new Promise(resolve => window.addEventListener('popstate', resolve, { once: true }))
    escape()
    await returned
    expect(workspace.isActive).toBe(false)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    popover.mockRestore()
  })

  it('a refused Desk start lands on its fiber with the host-specific inline recovery prompt', async () => {
    const managed: KanbanCard = { ...cards[0], shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' }
    workspace.openStartPrompt(managed, { reason: 'arm_refused', needs: 'project_dir', host: 'host-a', message: 'Choose a project directory.' })
    const band = workspace.dock.bandFor(managed).el
    expect(document.activeElement).toBe(band.querySelector('textarea'))
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
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
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
    const live = { ...cards[0], shuttleKind: 'oneshot' as const, shuttleAgent: 'codex-sol', tmuxSession: 'terminal-alpha', shuttleHost: 'daemon-a' }
    const openWorker = vi.fn()
    bodyCards = [live]
    workspace.dispose()
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => [live], origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed, undefined, openWorker),
    })
    workspace.open(live)
    await flush()
    expect(document.querySelector('.ws-dock .kbn-card-worker')).toBeNull()
    const head = document.querySelector<HTMLButtonElement>('.ws-navbar .ws-head-worker button.kbn-card-worker')!
    head.click()
    expect(openWorker).toHaveBeenLastCalledWith('terminal-alpha', 'daemon-a')
    openWorker.mockClear()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }))
    expect(openWorker).toHaveBeenCalledWith('terminal-alpha', 'daemon-a')
    expect(workspace.isActive).toBe(true)
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    expect(document.querySelector('.ws-fiber-prose .ws-dock')).not.toBeNull()
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
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => orderedCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.open(orderedCards[0])
    await flush()
    const labels = (): string[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].map(tab => tab.getAttribute('aria-label') ?? '')
    const firstOrder = labels()
    expect(firstOrder).toEqual(['notes.md', 'table.html', 'shared', 'Note'])

    workspace.open(orderedCards[1])
    await flush()
    // Each channel orders its declarations as its own body does, its report beside the fiber page.
    expect(labels()).toEqual(['table.html', 'notes.md', 'shared', 'Note'])
    // Nothing named a page before the channel painted, so it stays on its own page.
    expect(document.querySelector('.ws-tab[aria-selected="true"]')?.getAttribute('aria-label')).toBe('Note')
    const note = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].find(tab => tab.getAttribute('aria-label') === 'Note')!
    note.click()
    const prose = workspace.reader.host.get(`fiber:host-b:second`)!.content
    expect(prose.querySelector('.ws-prose-documents')).toBeNull()
    expect(labels()).toEqual(['table.html', 'notes.md', 'shared', 'Note'])
  })

  it('uses the shared Reader keymap for single-step tab roving focus', async () => {
    workspace.open(cards[0])
    await flush()
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')]
    const first = tabs[0]
    first.focus()
    const right = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
    first.dispatchEvent(right)
    expect(right.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    expect(tabs.filter(tab => tab.tabIndex === 0)).toHaveLength(1)
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
    tabs[1].dispatchEvent(left)
    expect(left.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(first)
    expect(tabs.filter(tab => tab.getAttribute('aria-selected') === 'true')).toHaveLength(1)
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

    document.querySelector<HTMLButtonElement>('.ws-tab-anchor')!.click()
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
    workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, dock: new Dock('', changed) })
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

  it('sends a routed page the loaded channel does not hold to the report', async () => {
    const gone = docKey('host-a', '/notes/alpha/gone.html', 'host-a')
    window.history.replaceState(null, '', `#/board/alpha@host-a/${encodeURIComponent(gone)}`)
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe(docKey('host-a', '/notes/alpha/report.html', 'host-a'))
    expect([...document.querySelectorAll('.ws-tab')].map(tab => tab.getAttribute('aria-label'))).not.toContain('gone.html')
  })

  it('keeps an explicit prose selection made while the body is loading', async () => {
    let deliver: (value: Response) => void = () => {}
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/v1/fibers/work/')
      ? new Promise<Response>(resolve => { deliver = resolve }) : originalFetch(url)))
    workspace.open(cards[0])
    document.querySelector<HTMLButtonElement>('.ws-tab')!.click()
    deliver(fiberReadResponse(cards[0]))
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-a:alpha')
  })

  it('waits for authoritative metadata before caching a cold constitution control band', async () => {
    const managed = card({ id: 'work/cold', uid: 'cold', name: 'Cold constitution', originId: 'host-a',
      fiberDir: '/notes/cold', path: 'work/cold/cold.md', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol' })
    let deliver!: (value: Response) => void
    const originalFetch = fetch
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/api/v1/fibers/cold?')
      ? new Promise<Response>(resolve => { deliver = resolve }) : originalFetch(url)))
    const bandFor = vi.spyOn(workspace.dock, 'bandFor')
    window.history.replaceState(null, '', '#/board/cold@host-a')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(document.querySelector('.ws-selected .ws-dock')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(bandFor).not.toHaveBeenCalled()
    deliver(fiberReadResponse(managed))
    await flush()
    workspace.open(managed)
    await flush()
    const band = document.querySelector<HTMLElement>('.ws-fiber-prose .ws-dock')!
    const textarea = band.querySelector<HTMLTextAreaElement>('textarea')!
    expect(textarea).not.toBeNull()
    expect(band.querySelector('.kbn-detail-controls-toggle')?.textContent).toContain('codex-sol')
    textarea.value = 'Unsent cold-entry draft'
    workspace.open(cards[0])
    await flush()
    workspace.open(managed)
    await flush()
    expect(workspace.dock.bandFor(managed).el).toBe(band)
    expect(band.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('Unsent cold-entry draft')
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
    expect(document.activeElement).not.toBe(document.querySelector('.ws-tab[aria-selected="true"]'))
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!
    const press = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    control.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(document.querySelector('.ws-tab[aria-selected="true"]'))
  })

  it('keeps Alt-arrow stepping in sidebar order and ignores messages from unrelated frames', async () => {
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
    expect(document.querySelector('.ws-return')?.textContent).toBe('‹ Desk')
    expect(window.history.state).toMatchObject({ shuttleWorkspace: { originView: 'desk' } })

    workspace.dispose()
    document.body.replaceChildren()
    const onView = vi.fn()
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => cards, origin: () => 'Board', onVisibility: visibility, onView,
      dock: new Dock('', changed),
    })
    await flush()

    expect(onView).toHaveBeenCalledWith('desk')
    expect(document.querySelector('.ws-return')?.textContent).toBe('‹ Desk')
  })

  it('restores overview scroll after returning from a channel opened on the Board', async () => {
    workspace.mountOverview(document.body)
    workspace.showBoard()
    await flush()
    workspace.overview.opened(cards[0])
    const overview = workspace.overview.el
    overview.scrollTop = 432
    overview.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"]')!.click()
    await flush()
    expect(workspace.reader.isActive).toBe(true)
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
    workspace.overview.el.querySelector<HTMLButtonElement>('.ws-overview-folio[data-uid="alpha"]')!.click()
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

    document.querySelector<HTMLButtonElement>('.ws-return')!.click()
    await new Promise(resolve => setTimeout(resolve, 0))
    await flush()
    workspace.showBoard()
    await flush()
    expect(workspace.reader.isActive).toBe(false)
    expect(workspace.overview.el.hidden).toBe(false)
    expect(window.location.hash).toBe('#/board')
  })
})
