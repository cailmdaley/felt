// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { VoiceStrip, voiceLine } from './voiceStrip'
import { voiceStatus } from '../testFixtures'
const target = { fiber_id: 'uid', origin: 'owner', name: 'Card name' }
const slug = (id: string) => id === 'uid' ? 'the-card' : undefined
it('shows no destination when off, and the target slug when following', () => {
  const strip = new VoiceStrip()
  strip.paint(voiceLine(voiceStatus({ target }), slug))
  expect(strip.el.hidden).toBe(true)
  strip.paint(voiceLine(voiceStatus({ enabled: true, target }), slug))
  expect(strip.el.textContent).toBe('the-card')
  expect(strip.el.dataset.mode).toBe('following')
})
it('keeps the pin mark and destination while muted or failed', () => {
  const strip = new VoiceStrip()
  strip.paint(voiceLine(voiceStatus({ enabled: true, follow: false, muted: true, state: 'failed', target }), slug))
  expect(strip.el.textContent).toBe('📌 the-card')
  expect(strip.el.dataset.mode).toBe('pinned')
  expect(strip.el.hasAttribute('data-paused')).toBe(true)
  expect(strip.el.title).toBe('Pinned: words go to the-card once unmuted')
})
it('uses the current destination and a path slug for a card outside the board', () => {
  expect(voiceLine(voiceStatus({ enabled: true, target, destination: { ...target, fiber_id: 'outside/other' } }), slug).name).toBe('other')
})
