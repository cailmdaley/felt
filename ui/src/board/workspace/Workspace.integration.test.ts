// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { Workspace } from './Workspace.js'
import { Dock } from './Dock.js'
import { docKey } from './documents.js'

vi.mock('../FileViewerPanel.js', () => ({
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
const flush = async (): Promise<void> => { for (let i = 0; i < 25; i++) await Promise.resolve() }
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
afterEach(() => { workspace?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('workspace reader integration', () => {
  it('selects the declared report on first entry and retains the same iframe through pages, expand and return', async () => {
    workspace.open(cards[0])
    await flush()
    const reportKey = docKey('host-a', '/notes/alpha/report.html', 'host-a')
    const frame = workspace.reader.host.get(reportKey)!
    const iframe = frame.content.querySelector('iframe')!
    expect(frame.el.classList.contains('ws-selected')).toBe(true)
    expect(window.location.hash).toContain(encodeURIComponent(reportKey))
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true }))
    expect(frame.el.classList.contains('ws-receded')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true }))
    document.querySelector<HTMLButtonElement>('.ws-selected .ws-expand-button')!.click()
    expect(frame.el.classList.contains('ws-expanded')).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(frame.el.classList.contains('ws-expanded')).toBe(false)
    workspace.reader.hide()
    expect(frame.el.classList.contains('ws-parked')).toBe(true)
    workspace.open(cards[0])
    await flush()
    expect(workspace.reader.host.get(reportKey)?.content.querySelector('iframe')).toBe(iframe)
    expect(frame.doc.provenance.filter(p => p.kind === 'sent')).toHaveLength(2)
  })

  it('keeps body links and embeds while placing the inline controls above the outcome', async () => {
    workspace.open(cards[0])
    await flush()
    const article = document.querySelector<HTMLElement>('.ws-fiber-prose')!
    const title = article.querySelector('h1')!
    const band = article.querySelector<HTMLElement>('.ws-dock')!
    const outcome = article.querySelector<HTMLElement>('.kbn-detail-lede')!
    expect(title.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(band.compareDocumentPosition(outcome) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()

    const proseTab = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].find(b => b.textContent === 'Note')!
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
    workspace.open(cards[0])
    await flush()
    const frame = workspace.reader.host.get(docKey('host-a', '/notes/alpha/report.html', 'host-a'))!
    const iframe = frame.content.querySelector('iframe')!
    const innerWindow = iframe.contentWindow
    const toggle = document.querySelector<HTMLButtonElement>('.ws-sidebar-toggle')!
    expect(toggle.textContent).toBe('▥ Constitutions')
    expect(toggle.title).toBe('Constitutions (⌘\\)')
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

  it('Escape gives inline and reader popovers first refusal, then collapses and returns', async () => {
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

  it('opens the real worker conversation from the navbar pill without a panel', async () => {
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
    const pill = document.querySelector<HTMLButtonElement>('.ws-navbar .ws-worker-pill button.kbn-card-worker')!
    expect(pill).toBeDefined()
    expect(document.querySelector('.ws-dock-slot')).toBeNull()
    pill.click()
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
    bodyOverrides.set('host-a:first', 'First result.\n\n:::{embed} report.html\n:::\n\n:::{embed} table.html\n:::')
    bodyOverrides.set('host-b:second', 'Second result.\n\n:::{embed} table.html\n:::\n\n:::{embed} report.html\n:::')
    workspace.dispose()
    workspace = new Workspace(document.body, {
      shuttleBase: '', cards: () => orderedCards, origin: () => 'Desk', onVisibility: visibility,
      dock: new Dock('', changed),
    })
    workspace.open(orderedCards[0])
    await flush()
    const labels = (): string[] => [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].map(tab => tab.textContent ?? '')
    const firstOrder = labels()
    expect(firstOrder).toEqual(['Note', 'shared', 'table.html'])

    workspace.open(orderedCards[1])
    await flush()
    expect(labels()).toEqual(['Note', 'table.html', 'shared'])
    expect(document.querySelector('.ws-tab[aria-selected="true"]')?.textContent).toBe('shared')
    const note = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].find(tab => tab.textContent === 'Note')!
    note.click()
    const prose = workspace.reader.host.get(`fiber:host-b:second`)!.content
    const proseLabels = [...prose.querySelectorAll<HTMLButtonElement>('.ws-prose-documents button')].map(button => button.textContent ?? '')
    expect(labels()).toEqual(['Note', ...proseLabels])
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
    workspace.open(cards[0])
    await flush()
    workspace.overview.opened(cards[1])
    const ordered = workspace.overview.orderedCards()
    expect(ordered.length).toBeGreaterThan(1)
    workspace.open(ordered[0])
    await flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(ordered[1].name)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe(ordered[0].name)

    document.querySelector<HTMLButtonElement>('.ws-tab')!.click()
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
    window.history.replaceState(null, '', '#/board/cold@host-a')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(document.querySelector('.ws-selected .ws-dock')).toBeNull()
    deliver(fiberReadResponse(managed))
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
    workspace.open(cards[0])
    await flush()
    workspace.overview.opened(cards[1])
    const first = workspace.overview.orderedCards()[0]
    workspace.open(first)
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

  it('keeps Alt-arrow stepping in overview order and ignores messages from unrelated frames', async () => {
    workspace.open(cards[0])
    await flush()
    workspace.overview.opened(cards[1])
    const ordered = workspace.overview.orderedCards()
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
