// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaptureForm, type CaptureFormProps } from './CaptureForm'
import { MOBILE_MEDIA } from '../board/mobile'
import type { Host, Project } from './projectModel'
import type { MeetingMode } from './meetingApi'
import type { PhoneCaptureAttempt, PhoneCaptureHooks } from '../board/phoneMeeting'

// Every endpoint and audio hook is fake: these tests cannot start a meeting.
const base = 'https://recorder.example'
const hosts: Host[] = [
  { id: 'local', label: 'Recorder', isLocal: true, nativeFolderPicker: true, browserCapable: true },
  { id: 'remote', label: 'Scribe', isLocal: false, nativeFolderPicker: false, browserCapable: false },
]
const projects: Project[] = hosts.map((host) => ({
  id: `${host.id}:/work`, name: 'Work', path: '/work', originId: host.id, loomPrefix: '',
}))
const modes: MeetingMode[] = ['call', 'room', 'phone']
const agents = [
  { id: 'claude-opus', default: true, chrome_capable: true },
  { id: 'claude-sonnet', default: false, chrome_capable: false },
]
const response = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
let root: Root | null
let status: unknown
let mobile: boolean
let fetcher: ReturnType<typeof vi.fn>
let begin: ReturnType<typeof vi.fn<PhoneCaptureHooks['begin']>>
let bind: ReturnType<typeof vi.fn<PhoneCaptureAttempt['bind']>>
let spawned: ReturnType<typeof vi.fn<CaptureFormProps['onSpawned']>>
let meetingResult: ReturnType<typeof vi.fn<CaptureFormProps['onMeetingResult']>>
const tick = async () => { await act(async () => { await Promise.resolve() }) }
const query = <T extends Element = HTMLElement,>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  expect(element, selector).not.toBeNull()
  return element!
}
const click = (selector: string) => act(() => query<HTMLButtonElement>(selector).click())
const select = (index: number, value: string) => act(() => {
  const element = document.querySelectorAll<HTMLSelectElement>('.form-select')[index]!
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
})
const yap = () => act(() => {
  const element = query<HTMLTextAreaElement>('textarea')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(element, 'A thought')
  element.dispatchEvent(new Event('input', { bubbles: true }))
})
const mount = async (overrides: Partial<CaptureFormProps> = {}, armed = true) => {
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<CaptureForm
    projects={projects} hosts={hosts} shuttleBase={base}
    onSpawned={spawned} onMeetingResult={meetingResult} onCancel={vi.fn()}
    phoneAudio={{ begin }} {...overrides}
  />))
  await tick()
  const toggle = document.querySelector<HTMLButtonElement>('.capture-meeting-toggle')
  if (mobile && armed && toggle?.getAttribute('aria-pressed') === 'false') { await click('.capture-meeting-toggle'); await tick() }
}
const meetingReads = () => fetcher.mock.calls.filter(([url]) => String(url).includes('/meeting'))
const captureBody = (): Record<string, unknown> => {
  const calls = fetcher.mock.calls.filter(([url]) => url === `${base}/api/v1/capture`)
  expect(calls).toHaveLength(1)
  return JSON.parse((calls[0]![1] as RequestInit).body as string)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  mobile = false
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: mobile && query === MOBILE_MEDIA })))
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  status = { available: true, modes, recorder: 'local', meeting: null }
  bind = vi.fn()
  begin = vi.fn(() => ({ ready: Promise.resolve(7), bind, cancel: vi.fn() }))
  spawned = vi.fn()
  meetingResult = vi.fn()
  fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === `${base}/api/v1/agents`) return response(agents)
    if (url.startsWith(`${base}/api/v1/meeting`)) return response(status)
    if (url === `${base}/api/v1/capture` && init?.method === 'POST') {
      const body = JSON.parse(init.body as string)
      return response({ spawned: true, tmux_session: 'fake-scribe', ...(body.meeting ? {
        meeting: { state: 'loading', phone: body.meeting.mode === 'phone', launch: 'fake-launch' },
      } : {}) })
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  vi.stubGlobal('fetch', fetcher)
})
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = null }
  // Radix queues focus restoration on unmount; finish it inside this DOM realm.
  await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)) })
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('rendered Capture capabilities', () => {
  it('uses hub-selected remote recording on mobile, independently of the scribe owner', async () => {
    mobile = true
    status = { available: true, modes, recorder: 'remote', meeting: null }
    await mount()
    expect(meetingReads().map(([url]) => url)).toEqual([`${base}/api/v1/meeting?prefer=phone`])
    expect(query('.capture-meeting-host-label').textContent).toBe('Records on Scribe · scribe on Recorder')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ origin: 'local', meeting: { mode: 'phone' } })
    // The preview is advisory: the hub checks reachability again before starting.
    expect(captureBody()).not.toHaveProperty('recorder')
    expect(begin).toHaveBeenCalledOnce()
  })

  it('accepts a local recorder chosen at Start after a remote preview becomes unavailable', async () => {
    mobile = true
    status = { available: true, modes, recorder: 'remote', meeting: null }
    await mount()
    fetcher.mockImplementation(async (url: string) => url.endsWith('/capture')
      ? response({ spawned: true, meeting: { state: 'loading', phone: true, launch: 'fallback-launch', recorder: 'local' } })
      : response(status))
    click('.form-submit')
    await tick()
    expect(captureBody()).not.toHaveProperty('recorder')
    expect(bind).toHaveBeenCalledWith(7, expect.objectContaining({ recorder: 'local', launch: 'fallback-launch', phone: true }))
    expect(meetingResult).toHaveBeenCalledWith(expect.objectContaining({ meeting: expect.objectContaining({ recorder: 'local' }) }))
  })

  it.each(['network', 'remote uncertainty'])('does not retry an ambiguous meeting start: %s', async (failure) => {
    mobile = true
    await mount()
    fetcher.mockImplementation(async (url: string) => {
      if (!url.endsWith('/capture')) return response(status)
      if (failure === 'network') throw new Error('lost response')
      return { ok: false, status: 502, json: async () => ({ recording_unknown: true, recorder: 'remote', error: 'Inspect the recorder before retrying.' }) }
    })
    click('.form-submit')
    await tick()
    expect(query<HTMLButtonElement>('.form-submit').disabled).toBe(true)
    click('.form-submit')
    await tick()
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/capture'))).toHaveLength(1)
    expect(query('.form-error').textContent).toMatch(/Inspect the recorder/)
  })

  it.each(modes)('desktop offers the recorder modes and submits %s', async (mode) => {
    await mount()
    expect(query('.capture-meeting-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(query('[role="radiogroup"]').hasAttribute('hidden')).toBe(true)
    click('.capture-meeting-toggle')
    expect(query('[role="radiogroup"]').hasAttribute('hidden')).toBe(false)
    expect([...document.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual(['Live', 'Mic only', 'Phone'])
    click(`[role="radio"]:nth-child(${modes.indexOf(mode) + 1})`)
    expect(query('[aria-checked="true"]').textContent).toBe(['Live', 'Mic only', 'Phone'][modes.indexOf(mode)])
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ origin: 'local', meeting: { mode } })
    expect(begin).toHaveBeenCalledTimes(mode === 'phone' ? 1 : 0)
    expect(meetingResult).toHaveBeenCalledOnce()
  })

  it('phone-only desktop has no selector and toggles into a phone submission', async () => {
    status = { available: true, modes: ['phone'], meeting: null }
    await mount()
    expect(query('.capture-meeting-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    click('.capture-meeting-toggle')
    expect(query('.form-submit').textContent).toBe('Start meeting')
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ meeting: { mode: 'phone' } })
    expect(begin).toHaveBeenCalledOnce()
    expect(bind).toHaveBeenCalledWith(7, expect.objectContaining({ launch: 'fake-launch' }))
  })

  it('mobile narrows Mac modes to phone, starts off, and offers no selector', async () => {
    mobile = true
    await mount({}, false)
    expect(query('.capture-meeting-toggle').getAttribute('aria-pressed')).toBe('false')
    expect(query('.form-submit').textContent).toBe('Spawn')
    click('.capture-meeting-toggle')
    expect(query('.capture-meeting-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('[role="radiogroup"]')).toBeNull()
    expect(document.activeElement?.tagName).not.toBe('TEXTAREA')
    click('.capture-meeting-toggle')
    expect(query('.form-submit').textContent).toBe('Spawn')
    click('.capture-meeting-toggle')
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ meeting: { mode: 'phone' } })
    expect(begin).toHaveBeenCalledOnce()
  })

  it.each([
    ['Mac', modes], ['phone-only', ['phone'] as MeetingMode[]],
  ])('remote scribe preserves %s recorder modes without origin routing or refetch', async (_name, offered) => {
    status = { available: true, modes: offered, recorder: 'local', meeting: null }
    // Remote first guards against treating picker order as recorder identity.
    await mount({ hosts: [...hosts].reverse() })
    expect(query('.capture-meeting-host-label').textContent).toBe('Records on Recorder · scribe on Recorder')
    click('.capture-meeting-toggle')
    if (offered.length > 1) click('[role="radio"]:nth-child(2)')
    select(0, 'remote')
    await tick()
    expect(meetingReads().map(([url]) => url)).toEqual([`${base}/api/v1/meeting`])
    expect(query('.capture-meeting-toggle').getAttribute('aria-pressed')).toBe('true')
    expect(query('.capture-meeting-host-label').textContent).toBe('Records on Recorder · scribe on Scribe')
    expect([...document.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual(offered.length > 1 ? ['Live', 'Mic only', 'Phone'] : [])
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ origin: 'remote', meeting: { mode: offered.length > 1 ? 'room' : 'phone' } })
    expect(meetingResult).toHaveBeenCalledWith(expect.objectContaining({ host: 'Scribe' }))
  })

  it('names recorder and scribe even when distinct hosts share a display label', async () => {
    await mount({ hosts: hosts.map((host) => ({ ...host, label: 'Workstation' })) })
    select(0, 'remote')
    expect(query('.capture-meeting-host-label').textContent).toBe('Records on Workstation · scribe on Workstation')
  })

  it.each([
    ['unavailable', { available: false, modes, meeting: null }],
    ['busy', { available: true, modes, meeting: { state: 'live' } }],
  ])('remote scribe cannot enable an %s recorder', async (_name, localStatus) => {
    status = localStatus
    await mount()
    select(0, 'remote')
    await tick()
    expect(meetingReads().map(([url]) => url)).toEqual([`${base}/api/v1/meeting`])
    expect(document.querySelector('.capture-meeting-toggle')).toBeNull()
    yap()
    click('.form-submit')
    await tick()
    expect(captureBody()).not.toHaveProperty('meeting')
    expect(begin).not.toHaveBeenCalled()
    expect(spawned).toHaveBeenCalledOnce()
  })

  it.each([
    ['missing modes', false, { available: true, meeting: null }],
    ['mobile without phone', true, { available: true, modes: ['call', 'room'], meeting: null }],
  ])('does not invent meeting choices for %s', async (_name, narrow, localStatus) => {
    mobile = narrow
    status = localStatus
    await mount()
    expect(document.querySelector('.capture-meeting-toggle')).toBeNull()
    expect(query('.form-submit').textContent).toBe('Spawn')
    expect(query<HTMLButtonElement>('.form-submit').disabled).toBe(true)
  })

  it('offers chrome on a browser-capable remote even when the recorder is headless', async () => {
    await mount({ hosts: hosts.map((host) => ({ ...host, browserCapable: !host.isLocal })) })
    expect(document.querySelector('.form-chrome')).toBeNull()
    select(0, 'remote')
    click('.form-chrome input')
    yap()
    click('.form-submit')
    await tick()
    expect(captureBody()).toMatchObject({ origin: 'remote', chrome: true })
  })

  it.each(['headless host', 'unsupported agent'])('hides and clears chrome after switching to an %s', async (destination) => {
    await mount()
    click('.form-chrome input')
    expect(query<HTMLInputElement>('.form-chrome input').checked).toBe(true)
    const away = () => destination === 'headless host' ? select(0, 'remote') : select(2, 'claude-sonnet')
    const back = () => destination === 'headless host' ? select(0, 'local') : select(2, 'claude-opus')
    away()
    expect(document.querySelector('.form-chrome')).toBeNull()
    back()
    expect(query<HTMLInputElement>('.form-chrome input').checked).toBe(false)
    click('.form-chrome input')
    away()
    yap()
    click('.form-submit')
    await tick()
    const body = captureBody()
    expect(body.chrome ?? false).toBe(false)
    expect(body).toMatchObject(destination === 'headless host' ? { origin: 'remote' } : { agent: 'claude-sonnet' })
    expect(spawned).toHaveBeenCalledOnce()
  })
})
