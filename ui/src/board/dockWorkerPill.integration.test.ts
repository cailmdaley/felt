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
  tmuxSession: 'shuttle-debug', shuttleHost: 'host-a', workerAgent: 'codex-sol',
  ...over,
})
const channel = (current: KanbanCard): Channel => {
  const uid = current.uid ?? current.id
  const key = `fiber:${current.originId}:${uid}`
  return {
    uid, owner: current.originId, name: current.name,
    documents: [{ key, owner: current.originId, path: '/note.md', name: current.name, kind: 'fiber', provenance: [{ kind: 'fiber' }] }],
    labels: ['Note'], body: '',
  }
}

let dock: Dock
let reader: Reader
let openWorker: ReturnType<typeof vi.fn<(tmuxSessionName: string, shuttleHost?: string) => void>>
let current: KanbanCard

beforeEach(() => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
  openWorker = vi.fn()
  current = worker()
  dock = new Dock('https://daemon.example', vi.fn(), undefined, openWorker, {
    workerPhase: card => card.status === 'active',
  })
  reader = new Reader({
    shuttleBase: 'https://daemon.example', buildProse: () => document.createElement('div'),
    onRefreshProse: vi.fn(), onSelect: vi.fn(), onReturn: vi.fn(), onChannel: vi.fn(),
    cards: () => [current], workerPill: card => dock.workerPillFor(card),
  })
  document.body.append(reader.el)
})

afterEach(() => {
  dock.reset()
  reader.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function show(currentCard: KanbanCard): void {
  const doc = channel(currentCard).documents[0]
  reader.show(channel(currentCard), doc.key, 'Desk', currentCard)
}

describe('the shared navbar and inline worker pill', () => {
  it('opens the actual owner terminal and uses the same pill builder in the fiber band', () => {
    const currentCard = worker()
    const band = dock.bandFor(currentCard)
    const inline = band.el.querySelector<HTMLElement>('.kbn-card-worker')!
    show(currentCard)
    const navbar = reader.el.querySelector<HTMLElement>('.ws-worker-pill .kbn-card-worker')!

    expect(inline.tagName).toBe('BUTTON')
    expect(navbar.tagName).toBe('BUTTON')
    expect(inline.className).toBe(navbar.className)
    expect(inline.textContent).toBe(navbar.textContent)
    navbar.click()
    inline.click()
    expect(openWorker.mock.calls).toEqual([['shuttle-debug', 'host-a'], ['shuttle-debug', 'host-a']])
  })

  it("updates the inline and navbar destinations when Claude's opening preference changes", () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    saveClaudeOpening('terminal')
    const band = dock.bandFor(live)
    show(live)
    expect(band.el.querySelector('.kbn-card-worker')?.tagName).toBe('BUTTON')
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')?.tagName).toBe('BUTTON')

    saveClaudeOpening('app')
    dock.refreshConversationOpening()
    show(live)
    const inline = band.el.querySelector<HTMLAnchorElement>('.kbn-card-worker')!
    const navbar = reader.el.querySelector<HTMLAnchorElement>('.ws-worker-pill .kbn-card-worker')!
    expect(inline.tagName).toBe('A')
    expect(navbar.tagName).toBe('A')
    expect(inline.href).toBe('claude://claude.ai/code/session_test')
    expect(navbar.href).toBe(inline.href)
  })

  it('drops both shared pills when the worker leaves its session', () => {
    const live = worker({ runtimePhase: 'waiting' })
    const band = dock.bandFor(live)
    show(live)
    expect(band.el.querySelector('.kbn-card-worker')).not.toBeNull()
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')).not.toBeNull()

    const departed = worker({ tmuxSession: undefined, workerAgent: undefined, runtimePhase: undefined, status: 'closed' })
    dock.syncRuntime(departed)
    current = departed
    show(departed)
    expect(band.el.querySelector('.kbn-card-worker')).toBeNull()
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')).toBeNull()
  })

  it('repaints Waiting as Aloft in both locations and suppresses phase outside In flight', () => {
    const waiting = worker({ runtimePhase: 'waiting', lastActivityAt: Date.now() - 61_000 })
    const band = dock.bandFor(waiting)
    show(waiting)
    expect(band.el.querySelector('.kbn-card-worker')?.textContent).toBe('Waiting')
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')?.textContent).toBe('Waiting')

    current = worker({ runtimePhase: 'working', lastActivityAt: Date.now() })
    dock.syncRuntime(current)
    show(current)
    expect(band.el.querySelector('.kbn-card-worker')?.textContent).toBe('Aloft')
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')?.textContent).toBe('Aloft')

    const review = worker({ status: 'closed', runtimePhase: 'waiting', lastActivityAt: Date.now() - 61_000 })
    show(review)
    expect(reader.el.querySelector('.ws-worker-pill .kbn-card-worker')?.textContent).toBe('Aloft')
  })
})
