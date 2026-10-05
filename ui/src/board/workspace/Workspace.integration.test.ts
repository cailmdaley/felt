// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { Workspace } from './Workspace.js'
import { docKey } from './documents.js'

vi.mock('../FileViewerPanel.js', () => ({
  buildFileViewer: vi.fn((_base: string, path: string, _owner: string, onLoad?: (frame: HTMLIFrameElement, refreshed: boolean) => void) => {
    const wrap = document.createElement('div')
    const iframe = document.createElement('iframe')
    iframe.title = path
    iframe.srcdoc = '<p>Report</p>'
    iframe.addEventListener('load', () => onLoad?.(iframe, false))
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
const flush = async (): Promise<void> => { for (let i = 0; i < 25; i++) await Promise.resolve() }
const conversation = vi.fn<(card: KanbanCard) => void>()
const visibility = vi.fn<(active: boolean) => void>()

beforeEach(() => {
  const stored = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value), clear: () => stored.clear() })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (_cb: FrameRequestCallback) => 1)
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/sent-files/all/')) return new Response(JSON.stringify({ files: [
      { fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: 1, sessionId: 'session-one' },
      { fullPath: '/notes/alpha/report.html', uid: 'alpha', host: 'host-a', timestamp: 2, sessionId: 'session-two' },
      { fullPath: '/notes/alpha/table.html', uid: 'alpha', host: 'host-a', timestamp: 3 },
    ] }))
    if (url.includes('/api/v1/fibers/work/')) return new Response(JSON.stringify({ fibers: [{ fiber: { body, outcome: 'A checked result.' } }] }))
    if (url.includes('/api/v1/fibers')) return new Response(JSON.stringify({ fibers: [] }))
    return new Response('{}')
  }))
  window.history.replaceState(null, '', '/')
  sessionStorage.clear()
  localStorage.clear()
  conversation.mockClear()
  visibility.mockClear()
  workspace = new Workspace(document.body, { shuttleBase: '', cards: () => cards, origin: () => 'Desk', onVisibility: visibility, onConversation: conversation })
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

  it('body links append one page without losing embeds, and Conversation uses only its bridge', async () => {
    workspace.open(cards[0])
    await flush()
    const proseTab = [...document.querySelectorAll<HTMLButtonElement>('.ws-tab')].find(b => b.textContent === 'Note')!
    proseTab.click()
    const link = document.querySelector<HTMLAnchorElement>('.ws-selected a[data-file-path]')!
    link.click()
    await flush()
    expect(workspace.reader.host.get(docKey('host-a', '/notes/alpha/report.html', 'host-a'))).toBeDefined()
    const dataFrame = workspace.reader.host.get(docKey('host-a', '/notes/alpha/data.csv', 'host-a'))!
    expect(dataFrame.doc.provenance.some(p => p.kind === 'link')).toBe(true)
    expect(dataFrame.el.classList.contains('ws-selected')).toBe(true)
    document.querySelector<HTMLButtonElement>('.ws-conversation')!.click()
    expect(conversation).toHaveBeenCalledWith(cards[0])
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
    deliver(new Response(JSON.stringify({ fibers: [{ fiber: { body } }] })))
    await flush()
    expect(document.querySelector('.ws-selected')?.getAttribute('data-key')).toBe('fiber:host-a:alpha')
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
    expect(document.activeElement).not.toBe(document.querySelector('.ws-return'))
    const control = document.querySelector<HTMLButtonElement>('.ws-selected .ws-menu-button')!
    const press = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    control.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flush()
    expect(document.activeElement).toBe(document.querySelector('.ws-return'))
  })

  it('steps channels in supplied Desk order and ignores messages from unrelated frames', async () => {
    workspace.open(cards[0])
    await flush()
    const hash = window.location.hash
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'shuttle-workspace-key', key: 'ArrowRight' }, source: window }))
    expect(window.location.hash).toBe(hash)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
    await flush()
    expect(document.querySelector('.ws-channel-title')?.textContent).toBe('Beta')
    expect(window.location.hash).toContain('beta@host-b')
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
