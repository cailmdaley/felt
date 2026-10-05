// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanCard } from './KanbanTypes.js'
import { card } from './testFixtures.js'
import { Dock } from './workspace/Dock.js'
import { Reader } from './workspace/Reader.js'
import type { Channel } from './workspace/documents.js'
import { saveClaudeOpening } from './conversationOpening.js'

const worker = (over: Partial<KanbanCard> = {}): KanbanCard => card({
  id: 'debug', uid: 'debug-uid', originId: 'host-a', status: 'active',
  workerState: 'running', tmuxSession: 'shuttle-debug', shuttleHost: 'host-a', workerAgent: 'codex-sol', ...over,
})
const channel = (current: KanbanCard): Channel => {
  const uid = current.uid ?? current.id
  const key = `fiber:${current.originId}:${uid}`
  return { uid, owner: current.originId, name: current.name,
    documents: [{ key, owner: current.originId, path: '/note.md', name: current.name, kind: 'fiber', provenance: [{ kind: 'fiber' }] }],
    labels: ['Note'], body: '' }
}
let dock: Dock
let reader: Reader
let openWorker: ReturnType<typeof vi.fn<(tmuxSessionName: string, shuttleHost?: string) => void>>
beforeEach(() => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  openWorker = vi.fn()
  dock = new Dock('https://daemon.example', vi.fn(), undefined, openWorker, { workerPhase: card => card.status === 'active' })
  reader = new Reader({ shuttleBase: 'https://daemon.example', buildProse: () => document.createElement('div'),
    onRefreshProse: vi.fn(), onSelect: vi.fn(), onReturn: vi.fn(), onChannel: vi.fn(),
    cards: () => [], workerPill: card => dock.workerPillFor(card) })
  document.body.append(reader.el)
})
afterEach(() => { dock.reset(); reader.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
function show(card: KanbanCard): HTMLElement | null {
  reader.show(channel(card), channel(card).documents[0].key, 'Desk', card)
  const band = dock.bandFor(card).el
  expect(band.querySelectorAll('.kbn-card-worker').length).toBeLessThanOrEqual(1)
  const pill = band.querySelector<HTMLElement>('.ws-worker-pill[data-part="act"] .kbn-card-worker')
  // The head draws the same control, to the same destination, whenever the act zone does.
  const head = reader.el.querySelector<HTMLElement>('.ws-navbar .ws-head-worker .kbn-card-worker')
  expect(reader.el.querySelectorAll('.ws-navbar .kbn-card-worker').length).toBeLessThanOrEqual(1)
  expect(!!head).toBe(!!pill)
  if (head && pill) {
    expect(head.dataset.workerState).toBe(pill.dataset.workerState)
    expect(head.getAttribute('aria-label')).toBe(pill.getAttribute('aria-label'))
    expect(head.getAttribute('href')).toBe(pill.getAttribute('href'))
  }
  return pill
}
describe('the fiber page act zone owns the only worker control', () => {
  it('opens the owner terminal without repeating agent or worker state on the fiber', () => {
    const pill = show(worker())!
    expect(pill.tagName).toBe('BUTTON')
    expect(pill.textContent).toBe('aloft')
    pill.click()
    expect(openWorker.mock.calls).toEqual([['shuttle-debug', 'host-a']])
  })
  it("updates the destination when Claude's opening preference changes", () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    saveClaudeOpening('terminal')
    expect(show(live)?.tagName).toBe('BUTTON')
    saveClaudeOpening('app'); dock.refreshConversationOpening()
    expect((show(live) as HTMLAnchorElement).href).toBe('claude://claude.ai/code/session_test')
  })
  it('drops the control when the worker leaves its session', () => {
    expect(show(worker())).not.toBeNull()
    expect(show(worker({ workerState: undefined, tmuxSession: undefined, workerAgent: undefined, status: 'closed' }))).toBeNull()
  })
  it('preserves the app conversation destination', () => {
    const route = 'codex://threads/01a0be38-6c36-7cd1-aec9-53a680d1f693'
    const pill = show(worker({ tmuxSession: undefined, workerSurface: 'app', sessionUuid: 'app-session', desktopLink: route,
      runtimePhase: 'waiting', lastActivityAt: Date.now() - 61_000 })) as HTMLAnchorElement
    expect(pill.textContent).toBe('waiting'); expect(pill.href).toBe(route)
  })
  it('follows owner-observed runtime, ignoring stale phase without a worker', () => {
    expect(show(worker({ runtimePhase: 'waiting', lastActivityAt: Date.now() - 61_000 }))?.textContent).toBe('waiting')
    expect(show(worker({ runtimePhase: 'working', lastActivityAt: Date.now() }))?.textContent).toBe('aloft')
    expect(show(worker({ workerState: undefined, status: 'closed', runtimePhase: 'waiting', lastActivityAt: Date.now() - 61_000 }))?.textContent).toBe('no worker')
  })
})
