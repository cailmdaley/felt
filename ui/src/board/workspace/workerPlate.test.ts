// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { workerPlate, workerPlateFacts } from './workerPlate.js'

const now = Date.parse('2026-10-04T14:00:00Z')
describe('owner-observed worker plate', () => {
  it('ages a working worker only once it has gone quiet', () => {
    const busy = card({ id: 'task', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - 30_000, workerStartedAt: now - 12 * 60000 })
    expect(workerPlateFacts(busy, now)).toEqual({ turn: 'working', word: 'working', elapsed: undefined, busy: true })
    const quiet = card({ id: 'task', workerState: 'running', runtimePhase: 'working', lastActivityAt: now - 18 * 3_600_000 })
    expect(workerPlateFacts(quiet, now).elapsed).toBe('18h')
  })
  it('ages a worker with no signal from its live launch, never stale dispatch metadata', () => {
    const task = card({ id: 'task', workerState: 'running', workerStartedAt: now - 12 * 60000, dispatchedAt: '2025-01-01T00:00:00Z' })
    expect(workerPlateFacts(task, now)).toEqual({ turn: 'no-signal', word: 'no signal', elapsed: '12m', busy: false })
    expect(workerPlateFacts(card({ id: 'task', workerState: 'running', dispatchedAt: 'invalid' }), now).elapsed).toBeUndefined()
  })
  it('breathes for a busy worker whatever the turn, and never otherwise', () => {
    for (const runtimePhase of [undefined, 'waiting', 'attention', 'blocked']) {
      expect(workerPlateFacts(card({ id: 'task', workerState: 'running', runtimePhase }), now).busy).toBe(false)
    }
    expect(workerPlateFacts(card({ id: 'task', workerState: 'blocked', runtimePhase: 'working' }), now).busy).toBe(false)
    const asking = card({ id: 'task', status: 'active', workerState: 'running', runtimePhase: 'working', ask: { text: 'OK?', at: new Date(now - 60_000).toISOString() } })
    expect(workerPlateFacts(asking, now)).toEqual({ turn: 'question', word: 'question', elapsed: '1m', busy: true })
  })
  it('ignores a durable old session on a workerless fiber', () => {
    expect(workerPlateFacts(card({ id: 'task', dispatchedAt: '2025-01-01T00:00:00Z', sessionUuid: 'old-session' }), now)).toEqual({ turn: 'none', word: 'no worker', elapsed: undefined, busy: false })
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
