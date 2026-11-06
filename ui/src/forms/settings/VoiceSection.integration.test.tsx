// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { VoiceSection } from './VoiceSection'

const api = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('./settingsApi', async original => ({ ...await original<object>(), loadConfigFile: api.load, saveConfigFile: api.save }))
const host = { origin: 'recorder', label: 'recorder', isLocal: false, stale: false, host: 'recorder', hubHost: 'hub', nativeFolderPicker: false, expandedFeltStores: [] }
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('saves changed voice settings on the selected host without dropping other keys', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  api.load.mockResolvedValue({ text: JSON.stringify({ enabled: false, voice: { words: 23, extra: 'kept' }, other: true }), digest: 'before' })
  api.save.mockResolvedValue({ digest: 'after' })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(<VoiceSection shuttleBase="" host={host} onChanged={vi.fn()} />) })
  const checkbox = container.querySelector<HTMLInputElement>('input[type=checkbox]')!
  expect(checkbox.checked).toBe(false)
  expect(container.textContent).toContain('Quiet seconds')
  await act(async () => { checkbox.click() })
  const quiet = container.querySelectorAll<HTMLInputElement>('input[type=number]')[1]
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(quiet, '0.5')
    quiet.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(quiet.validity.valid).toBe(true)
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(api.save).toHaveBeenCalledOnce()
  const [, owner, id, text, digest] = api.save.mock.calls[0]
  expect(owner).toEqual(host); expect(id).toBe('voice'); expect(digest).toBe('before')
  expect(JSON.parse(text)).toEqual({ enabled: true, cold_minutes: 5, voice: { words: 23, quiet_seconds: 0.5, extra: 'kept' }, meeting: { words: 150, quiet_seconds: 10 }, other: true })
  expect(api.load).toHaveBeenCalledTimes(1)
  const cold = container.querySelector<HTMLInputElement>('input[aria-label="Cold minutes"]') ?? container.querySelectorAll<HTMLInputElement>('input[type=number]')[4]
  expect(cold.value).toBe('5')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(cold, '2.5')
    cold.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(cold.validity.valid).toBe(true)
  await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
  expect(JSON.parse(api.save.mock.calls[1][3]).cold_minutes).toBe(2.5)
  act(() => root.unmount())
})
