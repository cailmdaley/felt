// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Dock } from './Dock.js'
import { card } from '../testFixtures.js'
import { Voice, type VoiceStatus } from '../voice.js'

const status: VoiceStatus = { available: true, enabled: false, muted: false, state: 'off', target: { fiber_id: 'a', origin: 'local', name: 'Alpha' }, pending: null, last: null, error: null }
const notify = (voice: Voice): void => (voice as unknown as { notify: () => void }).notify()
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
})
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function mount(mobile = false) {
  if (mobile) vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  const voice = new Voice(''); voice.status = { ...status }
  let recording: { state: 'live'; title: string; fiber: string; tail: never[] } | null = null
  const meeting = { current: () => recording, canJoin: () => !recording, modes: () => ['call', 'phone'], join: vi.fn(), stop: vi.fn() }
  const open = vi.fn()
  const dock = new Dock('', vi.fn(), undefined, undefined, { meeting: meeting as never, voice: { controller: voice, open } })
  const band = dock.bandFor(card({ id: 'a', uid: 'a', originId: 'local', shuttleKind: 'oneshot', shuttleAgent: 'codex-sol', shuttleHost: 'local' }))
  document.body.append(band.el)
  const root = band.el
  const main = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-arm')!
  const dropdown = () => root.querySelector<HTMLButtonElement>('.kbn-ctl-meet-dropdown')!
  const menuItems = () => [...root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
  return { voice, dock, root, main, dropdown, menuItems, open, setRecording(value: typeof recording) { recording = value; dock.syncMeeting() } }
}

it('keeps one shared control through idle, listening, mute, recording and yield', () => {
  const v = mount()
  const check = (label: string) => {
    expect(v.root.querySelectorAll('.kbn-ctl-meet')).toHaveLength(1)
    expect(v.root.querySelector('.voice-chip, .kbn-ctl-meet-chip')).toBeNull()
    expect(v.main().textContent).toBe(label)
    expect(v.main().closest('.kbn-ctl-meet')!.hasAttribute('hidden')).toBe(false)
  }
  check('Meeting')
  v.voice.status = { ...status, enabled: true, state: 'listening', pending: { fiber_id: 'a', words: 2, text: 'hello there' } }; notify(v.voice)
  check('Here')
  expect(v.root.querySelector('.voice-pending')!.textContent).toBe('hello there')
  v.dropdown().click(); expect(v.menuItems().map(x => x.textContent)).toContain('Mute'); v.dropdown().click()
  v.voice.status = { ...v.voice.status, muted: true }; notify(v.voice); check('Muted')
  v.dropdown().click(); expect(v.menuItems().map(x => x.textContent)).toContain('Unmute'); v.dropdown().click()
  v.setRecording({ state: 'live', title: 'Standup', fiber: 'other', tail: [] }); check('Recording · other')
  v.voice.status = { ...v.voice.status, muted: false, state: 'yielded' }; notify(v.voice); check('Recording · other')
  v.dropdown().click(); expect(v.menuItems().map(x => x.textContent)).toEqual(expect.arrayContaining(['Mute', 'Stop recording'])); v.dropdown().click()
  v.setRecording(null); check('Meeting')
  v.dock.reset()
})

it('shows failures and unconfirmed notes; voice actions retain error feedback', async () => {
  const v = mount()
  v.voice.status = { ...status, enabled: true, state: 'listening', last: { fiber_id: 'a', at: '2026-11-06T10:00:00Z', status: 'unconfirmed', detail: 'May have arrived' } }; notify(v.voice)
  vi.spyOn(v.voice, 'set').mockRejectedValue(new Error('Recorder unavailable'))
  v.dropdown().click(); expect(v.root.textContent).toContain('Delivery unconfirmed: May have arrived')
  v.menuItems().find(x => x.textContent === 'Mute')!.click()
  await Promise.resolve(); await Promise.resolve()
  expect(v.main().textContent).toBe('Failed')
  v.dropdown().click(); expect(v.root.textContent).toContain('Recorder unavailable')
  v.dock.reset()
})

it('keeps voice read-only on mobile and can open the target', () => {
  const v = mount(true)
  v.voice.status = { ...status, enabled: true, state: 'listening', target: { fiber_id: 'other', origin: 'remote', name: 'Elsewhere' } }; notify(v.voice)
  expect(v.main().textContent).toBe('Elsewhere')
  v.dropdown().click()
  expect(v.menuItems().map(x => x.textContent)).toEqual(['Open Elsewhere'])
  v.menuItems()[0].click(); expect(v.open).toHaveBeenCalledWith('other', 'remote')
  v.dock.reset()
})
