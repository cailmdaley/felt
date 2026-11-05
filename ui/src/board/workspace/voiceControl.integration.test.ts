// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures'
import { Voice, type VoiceStatus } from '../voice'
import { voiceControl } from './voiceControl'

const status: VoiceStatus = { available: true, enabled: true, muted: false, state: 'listening', target: { fiber_id: 'a', origin: 'local', name: 'Alpha' }, pending: { fiber_id: 'a', words: 2, text: 'hello there' }, last: null, error: null }
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('shows pending words only on their card and replaces them when sent', () => {
  const voice = new Voice('')
  voice.status = status
  const here = voiceControl(voice, card({ id: 'a' }), vi.fn())
  const open = vi.fn()
  const away = voiceControl(voice, card({ id: 'b' }), open)
  document.body.append(here.chip, here.pending, away.chip, away.pending)
  expect(here.chip.textContent).toBe('Voice · Here')
  expect(here.pending.textContent).toBe('hello there')
  expect(away.chip.textContent).toBe('Voice · Alpha')
  ;(away.chip as HTMLButtonElement).click()
  expect(open).toHaveBeenCalledWith('a', 'local')
  expect(away.pending.textContent).toBe('')
  voice.status = { ...status, pending: null, state: 'yielded' }
  // Simulate the controller's update notification.
  ;(voice as unknown as { notify: () => void }).notify()
  expect(here.pending.textContent).toBe('')
  expect(here.chip.textContent).toBe('Voice · Meeting')
  here.dispose(); away.dispose()
})
