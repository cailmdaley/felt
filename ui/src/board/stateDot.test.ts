// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { card } from './testFixtures.js'
import { stateDot } from './stateDot.js'

it.each([
  ['working', 'working'], ['waiting', 'idle'], ['attention', 'question'],
  ['identity_pending', 'starting'], ['identity_failed', 'blocked'],
])('draws %s as one wordless chat button, not a backend control', (phase, turn) => {
  const constitution = card({ id: 'work', name: 'Response check', status: 'active', workerState: 'running', runtimePhase: phase })
  const open = vi.fn(), bubble = vi.fn()
  const row = document.createElement('div'), dot = stateDot(constitution, open)
  row.addEventListener('click', bubble); row.append(dot)
  expect(dot.tagName).toBe('BUTTON')
  expect(dot.dataset.turn).toBe(turn)
  expect(dot.textContent).toBe('')
  expect(dot.getAttribute('aria-label')).toBe(`Open Response check — ${turn}`)
  dot.click()
  expect(open).toHaveBeenCalledExactlyOnceWith(constitution)
  expect(bubble).not.toHaveBeenCalled()
})

it('ignores stale working phases without a live worker, but keeps an outstanding ask', () => {
  const quiet = card({ id: 'quiet', status: 'closed', runtimePhase: 'working' })
  expect(stateDot(quiet, vi.fn()).dataset.turn).toBe('none')
  const asking = { ...quiet, status: 'active' as const, ask: { text: 'Which?', at: '2026-07-02T12:00:00Z' } }
  expect(stateDot(asking, vi.fn()).dataset.turn).toBe('question')
})
