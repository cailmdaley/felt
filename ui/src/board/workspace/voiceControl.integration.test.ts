// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures'
import { Voice, type VoiceStatus } from '../voice'
import { voiceControl } from './voiceControl'

const status: VoiceStatus = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'a', origin: 'local', name: 'Alpha' }, pending: { fiber_id: 'a', words: 2, text: 'hello there' }, last: null, error: null }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('shows pending words only on their card and replaces them when sent', () => {
  const voice = new Voice('')
  voice.status = status
  const here = voiceControl(voice, card({ id: 'a' }), vi.fn())
  const away = voiceControl(voice, card({ id: 'b' }), vi.fn())
  document.body.append(here.chip, here.pending, away.chip, away.pending)
  expect(here.chip.textContent).toBe('Voice · Here')
  expect(here.pending.textContent).toBe('hello there')
  expect(away.chip.textContent).toBe('Voice · Alpha')
  expect(away.pending.textContent).toBe('')
  voice.status = { ...status, pending: null, state: 'yielded' }
  // Simulate the controller's update notification.
  ;(voice as unknown as { notify: () => void }).notify()
  expect(here.pending.textContent).toBe('')
  expect(here.chip.textContent).toBe('Voice · Meeting')
  here.dispose(); away.dispose()
})
it('shows a refused mute in the chip menu rather than silently losing it', async () => {
  const voice = new Voice('')
  voice.status = status
  vi.spyOn(voice, 'set').mockRejectedValue(new Error('Recorder unavailable'))
  const control = voiceControl(voice, card({ id: 'a' }), vi.fn())
  const composer = document.createElement('div'); composer.className = 'kbn-ctl-composer'
  composer.append(control.chip); document.body.append(composer)
  ;(control.chip as HTMLButtonElement).click()
  ;[...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(item => item.textContent === 'Mute')!.click()
  await Promise.resolve(); await Promise.resolve()
  expect(control.chip.textContent).toBe('Voice · Failed')
  ;(control.chip as HTMLButtonElement).click()
  expect(document.body.textContent).toContain('Recorder unavailable')
  control.dispose()
})
it('keeps the mobile menu read-only while still allowing the destination to open', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const voice = new Voice('')
  voice.status = status
  const open = vi.fn()
  const control = voiceControl(voice, card({ id: 'b' }), open)
  const composer = document.createElement('div'); composer.className = 'kbn-ctl-composer'
  composer.append(control.chip); document.body.append(composer)
  ;(control.chip as HTMLButtonElement).click()
  const items = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')]
  expect(items.map(item => item.textContent)).toEqual(['Open Alpha'])
  items[0].click()
  expect(open).toHaveBeenCalledWith('a', 'local')
  control.dispose()
})
