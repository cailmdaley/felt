// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import type { KanbanCard, KanbanResponse } from './KanbanTypes'
import { card } from './testFixtures'

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
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })))
  board = new KanbanModal({ shuttleBase: 'https://daemon.example' })
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
