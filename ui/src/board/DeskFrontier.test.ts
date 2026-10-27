// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { installFrontierDetails } from './DeskFrontier.js'
import { ThreadIndex } from './threads.js'
import { card } from './testFixtures.js'

const now = Date.parse('2026-07-02T12:00:00Z')
it.each([
  ['waiting', 7, '7m'], ['identity_pending', 4, '4m'], ['waiting', 420, '7h'], ['working', 11, '11m'],
])('keeps the %s age before the family tail and menu without a state word or dot', (phase, minutes, elapsed) => {
  const parent = card({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: phase, lastActivityAt: now - minutes * 60000, workerStartedAt: now - minutes * 60000 })
  const child = card({ id: 'hub/work', orchestrator: parent.id, status: 'active', workerState: 'running', runtimePhase: 'working' })
  const host = document.createElement('div'), end = document.createElement('div'), menu = document.createElement('button')
  menu.className = 'kbn-card-menu'; menu.textContent = '•••'; end.append(menu); host.append(end)
  installFrontierDetails(host, end, parent, new ThreadIndex([parent, child]), vi.fn(), now)
  expect([...end.children].map(el => el.className)).toEqual(['kbn-row-elapsed', 'kbn-thread-count', 'kbn-card-menu'])
  const age = end.querySelector('.kbn-row-elapsed')!
  expect(age.textContent).toBe(elapsed)
  expect(age.childElementCount).toBe(0)
})

it('draws an age without descendants, and omits it when the pill has no age', () => {
  const host = document.createElement('div'), end = document.createElement('div')
  const parent = card({ id: 'hub', status: 'active', workerState: 'running', runtimePhase: 'waiting', lastActivityAt: now - 7 * 60000 })
  installFrontierDetails(host, end, parent, new ThreadIndex([parent]), vi.fn(), now)
  expect(end.textContent).toBe('7m')
  end.replaceChildren()
  const quiet = card({ id: 'quiet' })
  installFrontierDetails(host, end, quiet, new ThreadIndex([quiet]), vi.fn(), now)
  expect(end.children).toHaveLength(0)
})
