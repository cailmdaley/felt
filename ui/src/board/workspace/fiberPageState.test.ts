import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { fiberPageKicker, restReachable, reviewReachable, verdictsFor } from './fiberPageState.js'

it('offers a standing constitution Discard alone, never Temper, wherever it stands but retired', () => {
  for (const status of ['open', 'active'])
    for (const effectiveHorizon of ['now', 'stashed'] as const)
      for (const workerState of [undefined, 'running'] as const) {
        const standing = card({ id: 'standing', status, shuttleKind: 'standing', effectiveHorizon, workerState })
        expect(verdictsFor(standing)).toEqual(['discard'])
        expect(reviewReachable(standing)).toBe(false)
      }
  for (const tempered of [undefined, true, false])
    expect(verdictsFor(card({ id: 'retired', status: 'closed', shuttleKind: 'standing', tempered }))).toEqual([])
  expect(verdictsFor(card({ id: 'oneshot', status: 'open', shuttleKind: 'oneshot' }))).toEqual(['temper', 'discard'])
})

it('offers no verdicts for an idle standing seat, whether paused or armed; a running one retires', () => {
  for (const status of ['open', 'active']) {
    const seat = card({ id: 'seat', status, shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden' })
    expect(verdictsFor(seat)).toEqual([])
  }
  expect(verdictsFor(card({ id: 'seat', status: 'active', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden', workerState: 'running' }))).toEqual(['discard'])
})

it('names a standing constitution at rest by its schedule', () => {
  expect(fiberPageKicker(card({ id: 'armed', status: 'active', shuttleKind: 'standing' }))).toBe('Scheduled')
  expect(fiberPageKicker(card({ id: 'paused', status: 'open', shuttleKind: 'standing' }))).toBe('Schedule paused')
  expect(fiberPageKicker(card({ id: 'put-down', status: 'open', shuttleKind: 'oneshot', effectiveHorizon: 'stashed' }))).toBe('Resting')
})

describe('Rest eligibility', () => {
  it('reaches constitutions regardless of status, verdict or horizon, and a standing one until it retires', () => {
    for (const shuttleKind of ['oneshot', 'standing'] as const)
      for (const status of ['open', 'active', 'closed'])
        for (const tempered of [undefined, true, false])
          for (const effectiveHorizon of ['now', 'stashed'] as const)
            expect(restReachable(card({ id: 'work', shuttleKind, status, tempered, effectiveHorizon })))
              .toBe(shuttleKind === 'oneshot' || status !== 'closed')
    expect(restReachable(card({ id: 'agent', shuttleKind: undefined, shuttleAgent: 'claude-opus' }))).toBe(true)
    expect(restReachable(card({ id: 'seat', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden' }))).toBe(true)
  })

  it('does not offer Shuttle rest for ordinary notes or non-Shuttle cycles', () => {
    const note = card({ id: 'note', shuttleKind: undefined, shuttleAgent: undefined })
    expect(restReachable(note)).toBe(false)
    expect(restReachable({ ...note, isCycle: true })).toBe(false)
  })
})
