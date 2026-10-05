// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import { KanbanSurfaceRenderer } from './KanbanSurfaces'
import { Mic, type MicHandlers } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import type { RelayEvents } from '../phone/session'
import { MOBILE_MEDIA } from './mobile'
import { parseMeetingRecord, type MeetingRecord, type MeetingStatus } from './meeting'
import type { KanbanCard, KanbanResponse } from './KanbanTypes'
import { card } from './testFixtures'

vi.mock('../phone/relay', () => ({ RelayLink: vi.fn(function () {
  return { open: vi.fn(), close: vi.fn(), send: vi.fn(), nudge: vi.fn() }
}) }))

interface BoardState {
  container: HTMLElement | null
  surfaces: KanbanSurfaceRenderer
  lastResponse: KanbanResponse
  meetingStatus: MeetingStatus
  fetchMeetingStatus(): Promise<void>
  fetchAndRender(): Promise<void>
  showBanner(message: string, tone: string): void
  dock: { buildMeeting(card: KanbanCard, error: HTMLElement, send: Send): HTMLElement }
  teardownState(): void
}
interface Send {
  compose: () => Promise<string>
  busy: () => boolean
  setBusy: ReturnType<typeof vi.fn>
  sent: ReturnType<typeof vi.fn>
}
/** A composer's send state with nothing pasted: the note is `compose`'s. */
const sendWith = (compose: () => Promise<string> = async () => ''): Send =>
  ({ compose, busy: () => false, setBusy: vi.fn(), sent: vi.fn() })
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
  it('marks hidden and bfcache suspension on the board session and paints the interruption on return', async () => {
    find<HTMLButtonElement>('.kbn-phone-connect').click()
    await flush()
    board.phoneAudio.mount()
    let visibility: DocumentVisibilityState = 'hidden'
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
    const backgrounded = vi.spyOn(board.phoneAudio.session, 'backgrounded')
    const returned = vi.spyOn(board.phoneAudio.session, 'returned')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(backgrounded).toHaveBeenCalledOnce()
    handlers.onChunk(new ArrayBuffer(4))
    expect(board.phoneAudio.session.warning).toBeNull()
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
    expect(backgrounded).toHaveBeenCalledTimes(2)
    expect(opened.close).not.toHaveBeenCalled()
    visibility = 'visible'
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    expect(returned).toHaveBeenCalledOnce()
    expect(find('.kbn-phone-warning').textContent).toContain('Audio may be missing from')
    handlers.onChunk(new ArrayBuffer(4))
    expect(find('.kbn-phone-warning').textContent).toContain('Audio may be missing from')
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
    expect(opened.close).toHaveBeenCalledOnce()
  })

  it('starts a joined Phone from the actual menu gesture and binds confirmed recording even when delivery fails', async () => {
    vi.spyOn(state, 'fetchAndRender').mockResolvedValue()
    const order: string[] = []
    vi.stubGlobal('AudioContext', class {
      constructor() { order.push('context') }
      resume() { order.push('resume'); return Promise.resolve() }
      close() { return Promise.resolve() }
    })
    for (const reply of [
      { ok: true, status: 200, payload: { delivery: { delivery: 'message', delivered: true } } },
      { ok: true, status: 202, payload: { delivery: { delivered: null, detail: 'queued' } } },
      { ok: false, status: 502, payload: { recording: true, error: 'delivery failed' } },
    ]) {
      board.phoneAudio.cancel()
      state.meetingStatus.meeting = null
      const opening = defer<Mic>()
      vi.mocked(Mic.open).mockImplementation(() => { order.push('mic'); return opening.promise })
      fetcher.mockImplementation(async (url: string) => ({
        ok: url.endsWith('/join') ? reply.ok : true,
        status: reply.status,
        json: async () => url.endsWith('/join') ? { meeting: current, ...reply.payload } : { available: true, meeting: current },
      }))
      const menu = state.dock.buildMeeting(card({ id: 'science/task', originId: 'scribe-host' }), document.createElement('div'), sendWith())
      document.body.append(menu)
      menu.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
      order.length = 0
      fetcher.mockClear()
      const phone = [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Phone')!
      phone.click()
      expect(order).toEqual(['context', 'resume', 'mic'])
      expect(fetcher).not.toHaveBeenCalled()
      opening.resolve(opened as unknown as Mic)
      await flush()
      expect(fetcher).toHaveBeenCalledWith('https://audio.example/api/v1/meeting/join', expect.objectContaining({
        body: JSON.stringify({ fiber_id: 'science/task', origin: 'scribe-host', meeting: { mode: 'phone' } }),
      }))
      expect(RelayLink).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'wss://audio.example/api/v1/meeting/audio?launch=L1' }))
      expect(board.phoneAudio.session.mic).toBe(opened)
      expect(state.meetingStatus.meeting).toMatchObject({ launch: 'L1' })
      menu.remove()
    }
  })

  it('releases a joined Phone attempt on hard start failure without binding a relay', async () => {
    state.meetingStatus.meeting = null
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    fetcher.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'hark unavailable' }) })
    const error = document.createElement('div')
    const menu = state.dock.buildMeeting(card({ id: 'science/task' }), error, sendWith())
    menu.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
    menu.querySelector<HTMLButtonElement>('[role="menuitem"]:last-child')!.click()
    await flush()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(RelayLink).not.toHaveBeenCalled()
    expect(error.textContent).toBe('hark unavailable')
  })

  it('composes a Phone note with images only after the pick has opened audio', async () => {
    vi.spyOn(state, 'fetchAndRender').mockResolvedValue()
    state.meetingStatus.meeting = null
    const order: string[] = []
    const opening = defer<Mic>()
    vi.mocked(Mic.open).mockImplementation(() => { order.push('mic'); return opening.promise })
    const send = sendWith(async () => { order.push('compose'); return 'look\n[Image: /h/a.png]' })
    fetcher.mockImplementation(async (url: string) => ({
      ok: true, status: 200,
      json: async () => url.endsWith('/join')
        ? { meeting: current, delivery: { delivery: 'message', delivered: true } }
        : { available: true, meeting: current },
    }))
    const menu = state.dock.buildMeeting(card({ id: 'science/task', originId: 'scribe-host' }), document.createElement('div'), send)
    menu.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
    ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Phone')!.click()
    expect(order).toEqual(['mic'])
    expect(send.setBusy).toHaveBeenCalledWith(true)
    opening.resolve(opened as unknown as Mic)
    await flush()
    await vi.waitFor(() => expect(send.sent).toHaveBeenCalledOnce())
    expect(order).toEqual(['mic', 'compose'])
    const join = fetcher.mock.calls.find(([url]) => String(url).endsWith('/join'))!
    expect(JSON.parse(join[1].body).note).toBe('look\n[Image: /h/a.png]')
    expect(send.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('a failed image upload starts no meeting and releases the opened audio', async () => {
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    state.meetingStatus.meeting = null
    const error = document.createElement('div')
    const send = sendWith(async () => { throw new Error("Couldn't upload images: fiber not found: science/task") })
    const menu = state.dock.buildMeeting(card({ id: 'science/task' }), error, send)
    menu.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
    ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Phone')!.click()
    await vi.waitFor(() => expect(error.textContent).toBe("Couldn't upload images: fiber not found: science/task"))
    expect(opened.close).toHaveBeenCalledOnce()
    expect(RelayLink).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/join'))).toBe(false)
    expect(send.sent).not.toHaveBeenCalled()
    expect(send.setBusy).toHaveBeenLastCalledWith(false)
  })

  it('keeps the note and images when the recording started but its worker did not receive it', async () => {
    vi.spyOn(state, 'fetchAndRender').mockResolvedValue()
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    for (const [reply, received] of [
      [{ ok: false, status: 502, payload: { recording: true, error: 'delivery failed' } }, false],
      [{ ok: true, status: 200, payload: { delivery: { delivery: 'message', delivered: true } } }, true],
    ] as const) {
      state.meetingStatus.meeting = null
      fetcher.mockImplementation(async (url: string) => ({
        ok: url.endsWith('/join') ? reply.ok : true,
        status: reply.status,
        json: async () => url.endsWith('/join') ? { meeting: current, ...reply.payload } : { available: true, meeting: null },
      }))
      const send = sendWith(async () => '[Image: /h/a.png]')
      const menu = state.dock.buildMeeting(card({ id: 'science/task' }), document.createElement('div'), send)
      menu.querySelector<HTMLButtonElement>('.kbn-ctl-meet-btn')!.click()
      ;[...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent === 'Room')!.click()
      await vi.waitFor(() => expect(send.setBusy).toHaveBeenLastCalledWith(false))
      expect(send.sent).toHaveBeenCalledTimes(received ? 1 : 0)
    }
  })

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
    expect(find('.kbn-phone-hint').textContent).toContain('iOS stops the mic when the screen locks')
    events().onLink('reconnecting', null)
    events().onLoss(Date.now(), null)
    expect(find('.kbn-phone-state').textContent).toContain('audio lost since')
    find<HTMLButtonElement>('.kbn-phone-reconnect').click()
    expect(relay().nudge).toHaveBeenCalledOnce()
    opened.health.mockReturnValue('suspended')
    handlers.onInterrupted('audio suspended')
    expect(find('.kbn-phone-warning').textContent).toContain('speech may be missing')
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
    const opening = board.phoneAudio.begin()
    opening.bind(await opening.ready, current)
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
