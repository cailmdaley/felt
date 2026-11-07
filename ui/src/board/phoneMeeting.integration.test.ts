// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal'
import type { Dock } from './workspace/Dock'
import { KanbanSurfaceRenderer } from './KanbanSurfaces'
import { Mic, type MicHandlers } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import type { RelayEvents } from '../phone/session'
import { MOBILE_MEDIA } from './mobile'
import { parseMeetingRecord, type MeetingRecord, type MeetingStatus } from './meeting'
import type { KanbanCard, KanbanResponse } from './KanbanTypes'
import { card, response as boardResponse } from './testFixtures'

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
  joinCardMeeting(card: KanbanCard, mode: 'call', options: object): Promise<unknown>
  dock: Dock
  teardownState(): void
}
const row = (overrides: Partial<MeetingRecord> = {}): MeetingRecord => parseMeetingRecord({
  state: 'loading', title: 'Meeting', phone: true, launch: 'L1', tmux_session: 'hark-pane', ...overrides,
})!
const response = (): KanbanResponse => boardResponse()
const defer = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
/** The band's Listen control for a card, under this page. */
const listen = (subject: KanbanCard): { el: HTMLElement; press(): void; button: HTMLButtonElement; error: HTMLElement } => {
  state.dock.reset()
  state.dock.open(subject)
  const el = state.dock.el
  document.body.append(el)
  const button = el.querySelector<HTMLButtonElement>('.kbn-ctl-meet-arm')!
  return { el, button, press: () => button.click(), error: el.querySelector<HTMLElement>('.ws-band-status .kbn-detail-error')! }
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
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  })
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('AudioContext', class { resume = vi.fn(async () => {}); close = vi.fn(async () => {}) })
  opened = { close: vi.fn(), health: vi.fn(() => 'ok'), revive: vi.fn(async () => 'ok') }
  vi.spyOn(Mic, 'open').mockImplementation((_context, value) => { handlers = value; return Promise.resolve(opened as unknown as Mic) })
  current = row()
  fetcher = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => url.includes('/api/v1/meeting') ? { available: true, modes: ['call', 'phone'], meeting: current } : {} }))
  vi.stubGlobal('fetch', fetcher)
  board = new KanbanModal({ shuttleBase: 'https://audio.example' })
  state = board as unknown as BoardState
  state.container = document.createElement('div')
  state.lastResponse = response()
  state.meetingStatus = { available: true, modes: ['call', 'phone'], meeting: current }
  document.body.append(state.container)
  state.container.append(state.surfaces.renderNowSection(state.lastResponse.now, {}))
})
afterEach(() => {
  state.dock.reset()
  state.dock.el.remove()
  board.phoneAudio.unmount()
  state.container?.remove()
  state.teardownState()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('board phone meeting card wiring', () => {
  it.each([
    [{ meeting: { state: 'live' }, delivery: { delivered: true, delivery: 'message' } }, 200, 'Listening — “Task” its worker is listening.', 'info'],
    [{ recording: true, error: 'owner unreachable', meeting: { state: 'live' } }, 502, 'Listening, but “Task” could not join: owner unreachable', 'error'],
    [{ error: 'recorder unavailable' }, 503, "Couldn't start listening: recorder unavailable", 'error'],
  ] as const)('uses Listening language in join banners', async (payload, status, message, tone) => {
    const banner = vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    vi.spyOn(state, 'fetchAndRender').mockResolvedValue()
    fetcher.mockResolvedValue({ ok: status < 400, status, json: async () => payload })
    await state.joinCardMeeting(card({ id: 'task', name: 'Task' }), 'call', {})
    expect(banner).toHaveBeenCalledWith(message, tone)
  })

  it('pins Join, polling, audio and Stop to the recorder while preserving the agent owner', async () => {
    current = row({ recorder: 'mac-recorder' })
    state.meetingStatus = { available: true, modes: ['call', 'phone'], recorder: 'mac-recorder', meeting: null }
    vi.spyOn(state, 'fetchAndRender').mockResolvedValue()
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    fetcher.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/join')
      ? { meeting: current, delivery: { delivered: true, delivery: 'message' } }
      : { available: true, modes: ['call', 'phone'], recorder: 'mac-recorder', meeting: current } }))
    const control = listen(card({ id: 'science/task', originId: 'agent-owner', shuttleKind: 'oneshot' }))
    expect(control.button.getAttribute('aria-label')).toBe('Listen')
    expect(control.el.querySelector('.kbn-ctl-meet [role="radio"]')).toBeNull()
    control.press()
    await flush()
    await vi.waitFor(() => expect(RelayLink).toHaveBeenCalled())
    const join = fetcher.mock.calls.find(([url]) => url.endsWith('/join'))!
    expect(JSON.parse(join[1].body)).toEqual({ fiber_id: 'science/task', origin: 'agent-owner', meeting: { mode: 'phone' }, resume_mode: 'fresh' })
    expect(RelayLink).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'wss://audio.example/api/v1/meeting/audio?launch=L1&recorder=mac-recorder' }))
    expect(fetcher.mock.calls.some(([url]) => url === 'https://audio.example/api/v1/meeting?recorder=mac-recorder')).toBe(true)
    find<HTMLButtonElement>('.kbn-meeting-stop').click()
    await flush()
    expect(fetcher).toHaveBeenCalledWith('https://audio.example/api/v1/meeting/stop', expect.objectContaining({ body: JSON.stringify({ recorder: 'mac-recorder', launch: 'L1' }) }))
    expect(fetcher.mock.calls.every(([url]) => url.startsWith('https://audio.example/'))).toBe(true)
  })

  it.each([
    [false, ['phone'], false],
    [true, ['call', 'phone'], true],
    [true, ['call'], false],
  ] as const)('gates Join on the device-required mode on mobile=%s with %j', async (mobile, modes, enabled) => {
    vi.stubGlobal('matchMedia', () => ({ matches: mobile, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    state.meetingStatus = { available: true, modes: [...modes], meeting: null }
    const control = listen(card({ id: 'science/task', shuttleKind: 'oneshot' }))
    expect(control.el.querySelector('.kbn-ctl-meet [role="radio"]')).toBeNull()
    expect(control.button.disabled).toBe(!enabled)
    control.press()
    await flush()
    const joins = fetcher.mock.calls.filter(([url]) => url.endsWith('/join'))
    expect(joins).toHaveLength(enabled ? 1 : 0)
    if (enabled) expect(JSON.parse(joins[0][1].body).meeting.mode).toBe(mobile ? 'phone' : 'call')
  })

  it('holds Join after an ambiguous start, even if a status read has no meeting yet', async () => {
    state.meetingStatus.meeting = null
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    fetcher.mockImplementation(async (url: string) => {
      if (url.endsWith('/join')) throw new Error('lost response')
      return { ok: true, status: 200, json: async () => ({ available: true, modes: ['phone'], meeting: null }) }
    })
    const control = listen(card({ id: 'science/task', shuttleKind: 'oneshot' }))
    control.press()
    await flush()
    await vi.waitFor(() => expect(opened.close).toHaveBeenCalledOnce())
    state.dock.syncMeeting()
    expect(control.button.disabled).toBe(true)
    control.press()
    await flush()
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/join'))).toHaveLength(1)
    expect(RelayLink).not.toHaveBeenCalled()
  })

  it('updates the Desk paused state and system audio action on the same recording', () => {
    current = row({ state: 'live', phone: false, system_audio: true, paused: false })
    state.meetingStatus.meeting = current
    redraw()
    const block = find('.kbn-meeting')
    expect(block.querySelector('.kbn-meeting-state')!.textContent).toBe('Recording')
    expect(block.querySelector<HTMLButtonElement>('.kbn-meeting-system-audio')!.disabled).toBe(false)
    current = { ...current, paused: true }
    state.meetingStatus.meeting = current
    redraw()
    expect(block.querySelector('.kbn-meeting-state')!.textContent).toBe('Paused')
    expect(block.getAttribute('aria-label')).toContain('paused')
    block.querySelector<HTMLButtonElement>('.kbn-meeting-system-audio')!.click()
    expect(block.querySelector<HTMLButtonElement>('.kbn-meeting-system-audio')!.disabled).toBe(true)
    expect(fetcher.mock.calls.some(([url]) => url.includes('system-audio'))).toBe(false)
    current = { ...current, paused: false }
    state.meetingStatus.meeting = current
    redraw()
    expect(block.querySelector('.kbn-meeting-state')!.textContent).toBe('Recording')
    expect(block.querySelector<HTMLButtonElement>('.kbn-meeting-system-audio')!.disabled).toBe(false)
  })

  it('shows only definite handoff failures on the Desk', () => {
    const handoff = { status: 'unconfirmed', kind: 'capture', target: 'task', origin: 'host', prompt: null }
    current = row({ state: 'live', handoff })
    state.meetingStatus.meeting = current
    redraw()
    const error = find('.kbn-meeting-error')
    expect(error.hidden).toBe(true)
    expect(error.textContent).toBe('')
    current = { ...current, handoff: { ...handoff, status: 'reported-failure' } }
    state.meetingStatus.meeting = current
    redraw()
    expect(error.hidden).toBe(false)
    expect(error.textContent).toContain('Scribe delivery failed')
  })

  it('sets no timer while idle and looks at a held mic once a second', async () => {
    const timeouts = vi.spyOn(window, 'setTimeout'), intervals = vi.spyOn(window, 'setInterval')
    board.phoneAudio.mount()
    expect([...timeouts.mock.calls, ...intervals.mock.calls].filter(([, ms]) => ms === 1_000)).toHaveLength(0)
    vi.useFakeTimers()
    try {
      const check = vi.spyOn(board.phoneAudio.session, 'check')
      find<HTMLButtonElement>('.kbn-phone-connect').click()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(check.mock.calls.length).toBeGreaterThanOrEqual(2)
    } finally { vi.useRealTimers() }
  })
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
    const banners = vi.spyOn(state, 'showBanner').mockImplementation(() => {})
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
      banners.mockClear()
      state.meetingStatus.meeting = null
      const opening = defer<Mic>()
      vi.mocked(Mic.open).mockImplementation(() => { order.push('mic'); return opening.promise })
      fetcher.mockImplementation(async (url: string) => ({
        ok: url.endsWith('/join') ? reply.ok : true,
        status: reply.status,
        json: async () => url.endsWith('/join') ? { meeting: current, ...reply.payload } : { available: true, modes: ['call', 'phone'], meeting: current },
      }))
      const control = listen(card({ id: 'science/task', originId: 'scribe-host', shuttleKind: 'oneshot' }))
      order.length = 0
      fetcher.mockClear()
      control.press()
      expect(order).toEqual(['context', 'resume', 'mic'])
      expect(fetcher).not.toHaveBeenCalled()
      opening.resolve(opened as unknown as Mic)
      await flush()
      expect(fetcher).toHaveBeenCalledWith('https://audio.example/api/v1/meeting/join', expect.objectContaining({
        body: JSON.stringify({ fiber_id: 'science/task', origin: 'scribe-host', meeting: { mode: 'phone' }, resume_mode: 'fresh' }),
      }))
      expect(RelayLink).toHaveBeenLastCalledWith(expect.objectContaining({ url: 'wss://audio.example/api/v1/meeting/audio?launch=L1' }))
      expect(board.phoneAudio.session.mic).toBe(opened)
      if (reply.status === 202) expect(banners).not.toHaveBeenCalled()
      if (reply.status === 502) expect(banners).toHaveBeenCalledWith(expect.stringContaining('could not join'), 'error')
      expect(state.meetingStatus.meeting).toMatchObject({ launch: 'L1' })
    }
  })

  it('releases a joined Phone attempt on hard start failure without binding a relay', async () => {
    state.meetingStatus.meeting = null
    vi.spyOn(state, 'showBanner').mockImplementation(() => {})
    fetcher.mockResolvedValue({ ok: false, status: 503, json: async () => ({ error: 'hark unavailable' }) })
    const control = listen(card({ id: 'science/task', shuttleKind: 'oneshot' }))
    control.press()
    await flush()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(RelayLink).not.toHaveBeenCalled()
    expect(control.error.textContent).toBe('hark unavailable')
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
      stopDragAutoScroll: vi.fn(), transition: vi.fn(), setSurface: vi.fn(), openDetail: vi.fn(),
      getMeeting: () => row({ phone: false }), getPhoneMeeting: () => board.phoneAudio,
      onMeetingStop: vi.fn(), onMeetingTerminal: terminal,
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
    expect(fetcher).toHaveBeenCalledWith('https://audio.example/api/v1/meeting/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ launch: 'L1' }),
    })
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
