// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import type { KanbanCard, KanbanResponse } from './KanbanTypes'
import { card } from './testFixtures'
import { saveClaudeOpening } from './conversationOpening'

interface BoardState {
  body: HTMLElement | null
  deskEl: HTMLElement | null
  lastResponse: KanbanResponse | null
  detailModal: { open(card: KanbanCard): void; close(): void }
  render(data: KanbanResponse): void
  teardownState(): void
}

const response = (columns: Partial<KanbanResponse['now']>): KanbanResponse => ({
  now: { drafts: [], inFlight: [], awaitingReview: [], ...columns },
  timeline: { past: [], futureDated: [] },
  stash: [], pinned: [], folded: [], cycles: [], originStaleness: {}, staleness: {},
}) as unknown as KanbanResponse

const worker = (over: Partial<KanbanCard>): KanbanCard => card({
  id: 'debug',
  status: 'active',
  tmuxSession: 'shuttle-debug',
  lastActivityAt: Date.now() - 5 * 60_000,
  ...over,
})

const pill = (): HTMLElement | null => document.querySelector<HTMLElement>('.kbn-detail-aloft')

let board: KanbanModal
let state: BoardState

beforeEach(() => {
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  board = new KanbanModal({ shuttleBase: 'https://daemon.example', onOpenWorker: vi.fn() })
  state = board as unknown as BoardState
  state.body = document.createElement('div')
  state.deskEl = document.createElement('div')
})

afterEach(() => {
  state.detailModal.close()
  state.teardownState()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the open card follows its worker', () => {
  it('updates an already open detail pill when its opening preference changes', () => {
    const live = worker({ workerAgent: 'claude-opus', sessionLink: 'https://claude.ai/code/session_test' })
    state.lastResponse = response({ inFlight: [live] })
    state.detailModal.open(live)
    expect(pill()?.tagName).toBe('BUTTON')
    saveClaudeOpening('app')
    ;(state.detailModal as unknown as { refreshConversationOpening(): void }).refreshConversationOpening()
    expect(pill()?.tagName).toBe('A')
    expect((pill() as HTMLAnchorElement).href).toBe('claude://claude.ai/code/session_test')
  })
  it('repaints a Waiting pill as Aloft when a poll reports the worker working', () => {
    const waiting = worker({ runtimePhase: 'waiting' })
    state.lastResponse = response({ inFlight: [waiting] })
    state.detailModal.open(waiting)
    expect(pill()?.textContent).toBe('Waiting')

    state.render(response({ inFlight: [worker({ runtimePhase: 'working', lastActivityAt: Date.now() })] }))
    expect(pill()?.textContent).toBe('Aloft')
    expect(document.querySelectorAll('.kbn-detail-aloft')).toHaveLength(1)
  })

  it('shows the phase only where the Desk does: in flight', () => {
    const waiting = worker({ runtimePhase: 'waiting' })
    state.lastResponse = response({ awaitingReview: [waiting] })
    state.detailModal.open(waiting)
    expect(pill()?.textContent).toBe('Aloft')
  })

  it('drops the pill when the worker goes away', () => {
    const waiting = worker({ runtimePhase: 'waiting' })
    state.lastResponse = response({ inFlight: [waiting] })
    state.detailModal.open(waiting)
    state.render(response({ awaitingReview: [worker({ tmuxSession: undefined, runtimePhase: undefined })] }))
    expect(pill()).toBeNull()
  })
})
