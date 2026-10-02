// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureForm, type CaptureFormProps } from './CaptureForm'
import { MEETING_PROJECT_KEY } from './meetingProject'
import { PhoneMeeting } from '../board/phoneMeeting'
import { Mic } from '../phone/mic'
import { RelayLink } from '../phone/relay'
import { MOBILE_MEDIA } from '../board/mobile'
import type { Host, Project } from './projectModel'

vi.mock('../phone/relay', () => ({ RelayLink: vi.fn(function () {
  return { open: vi.fn(), close: vi.fn(), send: vi.fn(), nudge: vi.fn() }
}) }))

const hosts: Host[] = [
  { id: 'local', label: 'Audio host', isLocal: true, nativeFolderPicker: false, browserCapable: true },
  { id: 'remote', label: 'Scribe host', isLocal: false, nativeFolderPicker: false, browserCapable: false },
]
const projects = [
  { id: 'local:/desk', name: 'Desk', path: '/desk', originId: 'local' },
  { id: 'remote:/first', name: 'First', path: '/first', originId: 'remote' },
  { id: 'remote:/science', name: 'Science', path: '/science', originId: 'remote' },
] as Project[]
const saved = { hostId: 'remote', projectId: 'remote:/science' }
const recording = { state: 'loading', phone: true, launch: 'returned-launch' }
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
let root: Root | null
let phone: PhoneMeeting
let fetcher: ReturnType<typeof vi.fn>
let result: ReturnType<typeof vi.fn<CaptureFormProps['onMeetingResult']>>
let contexts: { close: ReturnType<typeof vi.fn> }[]
let order: string[]
const mic = () => ({ close: vi.fn(), health: vi.fn(() => 'ok' as const), revive: vi.fn(async () => 'ok' as const) })
const tick = async () => { await act(async () => { await Promise.resolve() }) }
const click = (selector: string) => {
  const button = document.querySelector<HTMLButtonElement>(selector)!
  expect(button).not.toBeNull()
  act(() => button.click())
}
const mount = async (overrides: Partial<CaptureFormProps> = {}) => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root!.render(<CaptureForm projects={projects} hosts={hosts} onSpawned={vi.fn()} onCancel={vi.fn()} onMeetingResult={result} phoneAudio={phone} {...overrides} />))
  await tick()
}
const unmount = async () => { if (root) { await act(async () => root!.unmount()); root = null } }
const choices = () => [...document.querySelectorAll<HTMLSelectElement>('.form-select')].map((select) => select.value)
const mobile = (value: boolean) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: value && query === MOBILE_MEDIA, addEventListener: vi.fn(), removeEventListener: vi.fn() })))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mobile(true)
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
  })
  order = []
  contexts = []
  vi.stubGlobal('AudioContext', class {
    close = vi.fn(async () => {})
    constructor() { order.push('context'); contexts.push(this) }
    resume() { order.push('resume'); return Promise.resolve() }
  })
  phone = new PhoneMeeting('https://audio.example', vi.fn(), vi.fn())
  result = vi.fn()
  fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/agents')) return { ok: true, json: async () => [] }
    if (url.endsWith('/meeting')) return { ok: true, json: async () => ({ available: true, modes: ['call', 'room', 'phone'], meeting: null }) }
    order.push('capture')
    return { ok: true, status: 200, json: async () => ({ spawned: true, meeting: recording }) }
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
  await unmount()
  phone.cancel()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

describe('phone Capture form wiring', () => {
  it('re-enables mobile Meeting in Phone mode', async () => {
    await mount()
    click('.capture-meeting-toggle')
    click('.capture-meeting-toggle')
    expect(document.querySelector('.capture-meeting-toggle')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(document.querySelector('.form-submit')?.textContent).toBe('Start meeting')
  })

  it('does not offer another meeting while the daemon reports a live recording', async () => {
    fetcher.mockImplementation(async () => ({ ok: true, json: async () => ({ available: true, modes: ['call', 'room', 'phone'], meeting: recording }) }))
    await mount()
    expect(document.querySelector('.capture-meeting-toggle')).toBeNull()
    expect(document.querySelector('.form-submit')?.textContent).toBe('Spawn')
  })

  it('does not cancel an existing mic when a stale Capture sheet tries Start', async () => {
    const opened = mic()
    vi.spyOn(Mic, 'open').mockResolvedValue(opened as unknown as Mic)
    await mount()
    const live = phone.begin()
    live.bind(await live.ready, recording)
    click('.form-submit')
    await tick()
    expect(document.querySelector('.form-error')?.textContent).toContain('already opening or in use')
    expect(opened.close).not.toHaveBeenCalled()
    expect(phone.session.mic).toBe(opened)
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/capture'))).toBe(false)
    await unmount()
    expect(opened.close).not.toHaveBeenCalled()
  })

  it('owns only one Start attempt across same-tick double submission', async () => {
    const opened = mic()
    const pending = deferred<ReturnType<typeof mic>>()
    vi.spyOn(Mic, 'open').mockReturnValue(pending.promise as unknown as Promise<Mic>)
    await mount()
    const button = document.querySelector<HTMLButtonElement>('.form-submit')!
    act(() => { button.click(); button.click() })
    pending.resolve(opened)
    await tick()
    expect(result).toHaveBeenCalledOnce()
    expect(phone.session.mic).toBe(opened)
    expect(opened.close).not.toHaveBeenCalled()
    expect(order.filter((entry) => entry === 'context')).toHaveLength(1)
  })

  it('continues a successful phone start when remembering the project throws', async () => {
    const opened = mic()
    vi.spyOn(Mic, 'open').mockResolvedValue(opened as unknown as Mic)
    await mount()
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('quota') })
    click('.form-submit')
    await tick()
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ error: undefined }))
    expect(phone.session.mic).toBe(opened)
  })

  it('defaults mobile Capture to Phone, restores its successful host/project, and leaves the keyboard closed', async () => {
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify(saved))
    await mount()
    expect(window.matchMedia).toHaveBeenCalledWith(MOBILE_MEDIA)
    expect(document.querySelector('.capture-meeting-toggle')?.getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(choices().slice(0, 2)).toEqual([saved.hostId, saved.projectId])
    expect(document.querySelector('textarea')?.placeholder).toBe('Optional — the scribe works it out as you talk')
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
    expect(document.querySelector('.form-submit')?.textContent).toBe('Start meeting')
  })

  it('keeps desktop defaults and lets desktop explicitly select Phone', async () => {
    mobile(false)
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify(saved))
    await mount()
    expect(document.querySelector('.capture-meeting-toggle')?.getAttribute('aria-pressed')).toBe('false')
    expect(choices().slice(0, 2)).toEqual(['local', 'local:/desk'])
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
    click('.capture-meeting-toggle')
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Call')
    click('[role="radio"]:last-child')
    expect(document.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toBe('Phone')
  })

  it('falls back safely for malformed, stale, mismatched, and unavailable meeting storage', async () => {
    const values = ['not json', '[]', '{}', JSON.stringify({ hostId: 'gone', projectId: 'gone' }), JSON.stringify({ hostId: 'local', projectId: saved.projectId })]
    for (const value of values) {
      localStorage.setItem(MEETING_PROJECT_KEY, value)
      await mount()
      expect(choices().slice(0, 2)).toEqual(['local', 'local:/desk'])
      await unmount()
    }
    const store = localStorage
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('disabled') } })
    await mount()
    expect(choices().slice(0, 2)).toEqual(['local', 'local:/desk'])
    vi.stubGlobal('localStorage', store)
  })

  it('opens gesture audio before awaiting, waits for the mic, binds the returned launch locally, remembers success, and survives sheet unmount', async () => {
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify(saved))
    const pending = deferred<ReturnType<typeof mic>>()
    const opened = mic()
    vi.spyOn(Mic, 'open').mockImplementation(() => { order.push('mic'); return pending.promise as unknown as Promise<Mic> })
    await mount()
    const projectSelect = document.querySelectorAll<HTMLSelectElement>('.form-select')[1]
    act(() => {
      projectSelect.value = 'remote:/first'
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(JSON.parse(localStorage.getItem(MEETING_PROJECT_KEY)!)).toEqual(saved)
    click('.form-submit')
    expect(order).toEqual(['context', 'resume', 'mic'])
    expect(result).not.toHaveBeenCalled()
    pending.resolve(opened)
    await tick()
    const capture = fetcher.mock.calls.find(([url]) => String(url).endsWith('/capture'))!
    expect(JSON.parse((capture[1] as RequestInit).body as string)).toMatchObject({ origin: 'remote', project_dir: '/first', meeting: { mode: 'phone' } })
    expect(RelayLink).toHaveBeenCalledWith(expect.objectContaining({ url: 'wss://audio.example/api/v1/meeting/audio?launch=returned-launch' }))
    expect(JSON.parse(localStorage.getItem(MEETING_PROJECT_KEY)!)).toEqual({ hostId: 'remote', projectId: 'remote:/first' })
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ host: 'Scribe host', error: undefined }))
    await unmount()
    expect(phone.session.mic).toBe(opened)
    expect(opened.close).not.toHaveBeenCalled()
  })

  it('closes the gesture context on mic failure without requesting capture or remembering a selection', async () => {
    vi.spyOn(Mic, 'open').mockRejectedValue(new Error('permission refused'))
    await mount()
    click('.form-submit')
    await tick()
    expect(contexts[0].close).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/capture'))).toBe(false)
    expect(document.querySelector('.form-error')?.textContent).toContain('permission refused')
    expect(localStorage.getItem(MEETING_PROJECT_KEY)).toBeNull()
  })

  it('releases mic on capture failure and keeps the last successful meeting selection', async () => {
    const opened = mic()
    vi.spyOn(Mic, 'open').mockResolvedValue(opened as unknown as Mic)
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify(saved))
    fetcher.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/capture'), status: 503, json: async () => url.endsWith('/meeting') ? { available: true, modes: ['call', 'room', 'phone'], meeting: null } : { error: 'not recording' } }))
    await mount()
    click('.form-submit')
    await tick()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(phone.session.mic).toBeNull()
    expect(RelayLink).not.toHaveBeenCalled()
    expect(result).not.toHaveBeenCalled()
    expect(localStorage.getItem(MEETING_PROJECT_KEY)).toBe(JSON.stringify(saved))
    expect(document.querySelector('.form-error')?.textContent).toBe('not recording')
  })

  it('keeps confirmed recording connected when the remote scribe fails without replacing successful project memory', async () => {
    const opened = mic()
    vi.spyOn(Mic, 'open').mockResolvedValue(opened as unknown as Mic)
    fetcher.mockImplementation(async (url: string) => ({ ok: !url.endsWith('/capture'), status: 500, json: async () => url.endsWith('/meeting') ? { available: true, modes: ['call', 'room', 'phone'], meeting: null } : { recording: true, error: 'scribe unavailable', meeting: recording } }))
    localStorage.setItem(MEETING_PROJECT_KEY, JSON.stringify(saved))
    await mount()
    const projectSelect = document.querySelectorAll<HTMLSelectElement>('.form-select')[1]
    act(() => {
      projectSelect.value = 'remote:/first'
      projectSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    click('.form-submit')
    await tick()
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining("the scribe didn't start") }))
    expect(phone.session.mic).toBe(opened)
    expect(RelayLink).toHaveBeenCalledWith(expect.objectContaining({ url: expect.stringContaining('launch=returned-launch') }))
    expect(opened.close).not.toHaveBeenCalled()
    expect(localStorage.getItem(MEETING_PROJECT_KEY)).toBe(JSON.stringify(saved))
  })

  it('fails closed on a recording response without a launch and reports the continuing recording', async () => {
    const opened = mic()
    vi.spyOn(Mic, 'open').mockResolvedValue(opened as unknown as Mic)
    fetcher.mockImplementation(async (url: string) => ({ ok: true, status: 200, json: async () => url.endsWith('/meeting') ? { available: true, modes: ['call', 'room', 'phone'], meeting: null } : { spawned: true, meeting: { ...recording, launch: null } } }))
    await mount()
    click('.form-submit')
    await tick()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(RelayLink).not.toHaveBeenCalled()
    expect(result).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('mic is off') }))
    expect(localStorage.getItem(MEETING_PROJECT_KEY)).toBeNull()
  })

  it('blocks dismissal during Start and cancels an opening mic if the sheet is externally unmounted', async () => {
    const pending = deferred<ReturnType<typeof mic>>()
    const opened = mic()
    vi.spyOn(Mic, 'open').mockReturnValue(pending.promise as unknown as Promise<Mic>)
    const cancel = vi.fn()
    await mount({ onCancel: cancel })
    click('.form-submit')
    act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(cancel).not.toHaveBeenCalled()
    await unmount()
    const nextMic = mic()
    vi.mocked(Mic.open).mockResolvedValue(nextMic as unknown as Mic)
    const next = phone.begin()
    next.bind(await next.ready, recording)
    pending.resolve(opened)
    await tick()
    expect(opened.close).toHaveBeenCalledOnce()
    expect(phone.session.mic).toBe(nextMic)
    expect(nextMic.close).not.toHaveBeenCalled()
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/capture'))).toBe(false)
    expect(result).not.toHaveBeenCalled()
  })
})
