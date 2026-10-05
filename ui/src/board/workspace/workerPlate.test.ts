// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { workerPlate, workerPlateFacts } from './workerPlate.js'

const now = Date.parse('2026-10-04T14:00:00Z')
describe('owner-observed worker plate', () => {
  it('uses live launch time, not stale dispatch metadata', () => {
    const task = card({ id: 'task', workerState: 'running', runtimePhase: 'working', workerStartedAt: now - 12 * 60000, dispatchedAt: '2025-01-01T00:00:00Z' })
    expect(workerPlateFacts(task, now)).toEqual({ state: 'aloft', elapsed: '12 m', working: true })
  })
  it('shows no invented age without a valid launch time', () => {
    expect(workerPlateFacts(card({ id: 'task', workerState: 'running' }), now)).toEqual({ state: 'aloft', working: false })
    expect(workerPlateFacts(card({ id: 'task', workerState: 'running', dispatchedAt: 'invalid' }), now).elapsed).toBeUndefined()
  })
  it('does not breathe for waiting, unknown, attention, or blocked workers', () => {
    for (const runtimePhase of [undefined, 'waiting', 'attention', 'blocked']) {
      expect(workerPlateFacts(card({ id: 'task', workerState: 'running', runtimePhase }), now).working).toBe(false)
    }
    expect(workerPlateFacts(card({ id: 'task', workerState: 'blocked', runtimePhase: 'working' }), now).working).toBe(false)
  })
  it('ignores a durable old session on a workerless fiber', () => {
    expect(workerPlateFacts(card({ id: 'task', dispatchedAt: '2025-01-01T00:00:00Z', sessionUuid: 'old-session' }), now)).toEqual({ state: 'no worker', working: false })
  })
  it('keeps the conversation target and its click handler', () => {
    const target = document.createElement('button')
    let opened = false
    target.addEventListener('click', () => { opened = true })
    const plate = workerPlate(card({ id: 'task', workerState: 'running', runtimePhase: 'working' }), target)
    expect(plate).toBe(target)
    plate.click()
    expect(opened).toBe(true)
    expect(plate.querySelector('.ws-worker-dot')?.getAttribute('aria-hidden')).toBe('true')
    expect(plate.classList.contains('ws-turn-active')).toBe(true)
  })
})
