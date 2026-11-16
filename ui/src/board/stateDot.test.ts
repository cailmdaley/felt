// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { stateDot } from './stateDot.js'

const none = new Map()

it.each([
  ['working', 'working', true], ['waiting', 'working', false], ['attention', 'waiting', false],
  ['identity_pending', 'working', false], ['identity_failed', 'waiting', false],
])('draws a live worker in phase %s as %s, one wordless opening button', (phase, attention, busy) => {
  const constitution = card({ id: 'work', name: 'Response check', status: 'active', workerState: 'running', runtimePhase: phase })
  const open = vi.fn(), bubble = vi.fn()
  const row = document.createElement('div'), dot = stateDot(constitution, none, open)
  row.addEventListener('click', bubble); row.append(dot)
  expect(dot.tagName).toBe('BUTTON')
  expect([dot.dataset.attention, dot.hasAttribute('data-busy')]).toStrictEqual([attention, busy])
  expect(dot.textContent).toBe('')
  dot.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(constitution)
  expect(bubble).not.toHaveBeenCalled()
})

it('ignores stale working phases without a live worker, but keeps an outstanding ask', () => {
  const quiet = card({ id: 'quiet', status: 'closed', tempered: true, runtimePhase: 'working' })
  expect(stateDot(quiet, none, vi.fn()).dataset.attention).toBe('quiet')
  const asking = { ...quiet, status: 'active' as const, column: 'inFlight' as const, turn: 'question' as const, ask: { text: 'Which?', at: '2026-07-02T12:00:00Z' } }
  const dot = stateDot(asking, none, vi.fn())
  expect([dot.dataset.attention, dot.title]).toStrictEqual(['waiting', 'Which?'])
})

it('is gold for a post the board says waits on the human', () => {
  const chair = card({ id: 'chair', uid: 'C', status: 'active' })
  expect(stateDot(chair, new Map([['C', { id: 'p', at: 1, kind: 'post', text: 'Two calls today.' }]]), vi.fn()).dataset.attention).toBe('waiting')
})

it('exposes the dispatch failure on the card without requiring a live worker', () => {
  const reason = 'systemError: the previous Codex turn failed. Resume this conversation to continue.'
  const dot = stateDot(card({ id: 'failed-dispatch', status: 'active', launchError: reason }), none, vi.fn())
  expect(dot.dataset.attention).toBe('waiting')
  expect(dot.title).toBe(reason)
  expect(dot.getAttribute('aria-description')).toBe(reason)
})
