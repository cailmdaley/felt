// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import { KanbanSurfaceRenderer } from './KanbanSurfaces'
import { Mic, type MicHandlers } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import type { RelayEvents } from '../phone/session'
import { MOBILE_MEDIA } from './mobile'
import { parseMeetingRecord, type MeetingRecord, type MeetingStatus } from './meeting'
import type { KanbanResponse } from './KanbanTypes'

vi.mock('../phone/relay', () => ({ RelayLink: vi.fn(function () {
  return { open: vi.fn(), close: vi.fn(), send: vi.fn(), nudge: vi.fn() }
}) }))

interface BoardState {
  container: HTMLElement | null
  surfaces: KanbanSurfaceRenderer
  lastResponse: KanbanResponse
  meetingStatus: MeetingStatus
  fetchMeetingStatus(): Promise<void>
  teardownState(): void
}
const row = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => parseMeetingRecord({
  state: 'loading', title: 'Meeting', phone: true, launch: 'L1', tmux_session: 'hark-pane', ...overrides,
})!
const response = (): KanbanResponse => ({
  now: { drafts: [], inFlight: [], awaitingReview: [] },
  stash: [], pinned: [], cycles: [], originStaleness: {},
}) as unknown as KanbanResponse
const defer = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }
let board: KanbanModal
let state: BoardState
let handlers: MicHandlers
let opened: { close: ReturnType<typeof vi.fn>; health: ReturnType<typeof vi.fn<() => 'ok' | 'suspended'>>; revive: ReturnType<typeof vi.fn<() => Promise<'ok'>>> }
let fetcher: ReturnType<typeof vi.fn>
let current: MeetingRecord
const find = <T extends HTMLElement = HTMLElement>(selector: string): T => document.querySelector<T>(selector)!
const events = (): RelayEvents => vi.mocked(RelayLink).mock.calls.at(-1)![0] as RelayEvents
const relay = () => vi.mocked(RelayLink).mock.results.at(-1)!.value
const redraw = () => state.surfaces.updateMeetingPresentation()

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('AudioContext', class { resume = vi.fn(async () => {}); close = vi.fn(async () => {}) })
  opened = { close: vi.fn(), health: vi.fn(() => 'ok'), revive: vi.fn(async () => 'ok') }
  vi.spyOn(Mic, 'open').mockImplementation((_context, value) => { handlers = value; return Promise.resolve(opened as unknown as Mic) })
  current = row()
  fetcher = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/meeting') ? { available: true, meeting: current } : {} }))
  vi.stubGlobal('fetch', fetcher)
  board = new KanbanModal({ shuttleBase: 'https://audio.example' })
  state = board as unknown as BoardState
  state.container = document.createElement('div')
  state.lastResponse = response()
  state.meetingStatus = { available: true, meeting: current }
  document.body.append(state.container)
  state.container.append(state.surfaces.renderNowSection(state.lastResponse.now, {}))
})
afterEach(() => {
  board.phoneAudio.unmount()
  state.container?.remove()
  state.teardownState()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('board phone meeting card wiring', () => {
  it('adds audio controls only to phone cards and preserves desktop Stop and Terminal', () => {
    expect(find('.kbn-phone-controls')).not.toBeNull()
    expect(find('.kbn-meeting-stop')?.textContent).toBe('Stop')
    expect(find('.kbn-meeting-terminal')).toBeNull()
    state.meetingStatus.meeting = row({ phone: false })
    redraw()
    expect(find('.kbn-phone-controls')).toBeNull()
    expect(find('.kbn-meeting-stop')?.textContent).toBe('Stop')
    // A second board with the existing desktop Terminal callback.
    const terminal = vi.fn()
    const renderer = new KanbanSurfaceRenderer({
      getDragSourceId: () => null, setDragSourceId: vi.fn(), getLastResponse: () => state.lastResponse,
      stopDragAutoScroll: vi.fn(), transition: vi.fn(), setSurface: vi.fn(), pin: vi.fn(), openDetail: vi.fn(),
      getMeeting: () => row({ phone: false }), getPhoneMeeting: () => board.phoneAudio,
      onMeetingStop: vi.fn(), onMeetingTerminal: terminal, onRefresh: vi.fn(),
    })
    const section = renderer.renderNowSection(state.lastResponse.now, {})
    expect(section.querySelector('.kbn-phone-controls')).toBeNull()
    const button = section.querySelector<HTMLButtonElement>('.kbn-meeting-terminal')!
    expect(button.textContent).toBe('Terminal')
    button.click()
    expect(terminal).toHaveBeenCalledWith('hark-pane')
  })

  it('connects a reloaded phone card, paints audio truth, loss and meter, restores, reconnects, and handles background return', async () => {
    expect(find('.kbn-phone-connect').hidden).toBe(false)
    expect(find('.kbn-phone-caveat').hidden).toBe(false)
    find<HTMLButtonElement>('.kbn-phone-connect').click()
    await flush()
    expect(RelayLink).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://audio.example/api/v1/meeting/audio?launch=L1' }))
    expect(find('.kbn-phone-connect').hidden).toBe(true)
    events().onLink('waiting', null)
    expect(find('.kbn-phone-state').textContent).toContain('speech isn’t captured until Listening')
    expect(find('.kbn-phone-caveat').hidden).toBe(true)
    events().onLink('connected', null)
    expect(find('.kbn-phone-state').textContent).toBe('Listening')
    expect(find('.kbn-phone-caveat').hidden).toBe(true) // The lifecycle row can lag the relay.
    handlers.onLevel(0.25)
    expect(find('.kbn-phone-meter').getAttribute('aria-valuenow')).toBe('50')
    expect(find('.kbn-phone-meter-fill').style.width).toBe('50%')
    expect(find('.kbn-phone-hint').textContent).toContain('locking or switching apps may cut the mic')
    events().onLink('reconnecting', null)
    events().onLoss(Date.now(), null)
    expect(find('.kbn-phone-state').textContent).toContain('audio lost since')
    find<HTMLButtonElement>('.kbn-phone-reconnect').click()
    expect(relay().nudge).toHaveBeenCalledOnce()
    opened.health.mockReturnValue('suspended')
    handlers.onInterrupted('audio suspended')
    expect(find('.kbn-phone-warning').textContent).toContain('speech is missing')
    expect(find('.kbn-phone-restore').hidden).toBe(false)
    find<HTMLButtonElement>('.kbn-phone-restore').click()
    await flush()
    expect(opened.revive).toHaveBeenCalledOnce()
    board.phoneAudio.mount()
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(relay().nudge).toHaveBeenCalledTimes(2)
    events().onLink('replaced', 'Another device took the mic')
    expect(opened.close).toHaveBeenCalledOnce()
    expect(find('.kbn-phone-state').textContent).toBe('Another device took the mic')
    expect(find('.kbn-phone-connect').hidden).toBe(false)
  })

  it('never offers an unbound Connect mic and turns off audio only after Stop succeeds', async () => {
    state.meetingStatus.meeting = row({ launch: null })
    redraw()
    expect(find<HTMLButtonElement>('.kbn-phone-connect').disabled).toBe(true)
    find<HTMLButtonElement>('.kbn-phone-connect').click()
    expect(Mic.open).not.toHaveBeenCalled()
    state.meetingStatus.meeting = current
    redraw()
    find<HTMLButtonElement>('.kbn-phone-connect').click()
    await flush()
    const pendingStop = defer<{ ok: boolean; status: number; json(): Promise<object> }>()
    fetcher.mockImplementation((url: string) => url.endsWith('/stop') ? pendingStop.promise : Promise.resolve({ ok: true, json: async () => ({ available: true, meeting: current }) }))
    find<HTMLButtonElement>('.kbn-meeting-stop').click()
    expect(opened.close).not.toHaveBeenCalled()
    expect(find<HTMLButtonElement>('.kbn-meeting-stop').disabled).toBe(true)
    pendingStop.resolve({ ok: true, status: 200, json: async () => ({}) })
    await flush()
    expect(fetcher).toHaveBeenCalledWith('https://audio.example/api/v1/meeting/stop', { method: 'POST' })
    expect(opened.close).toHaveBeenCalledOnce()
    expect(relay().close).toHaveBeenCalledOnce()
  })

  it('installs the capture meeting, selects In flight, and ignores an older null poll without killing its mic', async () => {
    state.meetingStatus.meeting = null
    redraw()
    const older = defer<{ ok: boolean; json(): Promise<object> }>()
    fetcher.mockReturnValueOnce(older.promise)
    const oldRead = state.fetchMeetingStatus()
    const generation = await board.phoneAudio.begin()
    board.phoneAudio.bind(generation, current)
    const pager = find('.kbn-now-board')
    Object.defineProperty(pager, 'clientWidth', { value: 390 })
    board.meetingStarted(current)
    expect(state.meetingStatus.meeting).toBe(current)
    expect(pager.scrollLeft).toBe(390)
    expect(find('.kbn-folio-seg[data-folio="1"]').getAttribute('aria-selected')).toBe('true')
    older.resolve({ ok: true, json: async () => ({ available: true, meeting: null }) })
    await oldRead
    await flush()
    expect(board.phoneAudio.session.mic).toBe(opened)
    expect(opened.close).not.toHaveBeenCalled()
    expect(find('.kbn-phone-controls')).not.toBeNull()
    // An authoritative terminal poll still releases audio.
    current = row({ state: 'failed' })
    await board.refreshMeeting()
    expect(opened.close).toHaveBeenCalledOnce()
  })
})
