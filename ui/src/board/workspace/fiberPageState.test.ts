import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { fiberPageKicker, restReachable, reviewReachable, verdictsFor } from './fiberPageState.js'

it('offers a standing constitution Retire, and Temper only while an armed run waits on the human', () => {
  for (const status of ['open', 'active'])
    for (const effectiveHorizon of ['now', 'stashed'] as const)
      for (const workerState of [undefined, 'running'] as const)
        for (const ask of [undefined, { text: 'Cut these?', at: '2026-01-01T09:00:00Z' }]) {
          const standing = card({ id: 'standing', status, shuttleKind: 'standing', effectiveHorizon, workerState, ask })
          const waiting = status === 'active' && (workerState !== undefined || ask !== undefined)
          expect(verdictsFor(standing)).toEqual(waiting ? ['temper', 'discard'] : ['discard'])
          expect(reviewReachable(standing)).toBe(false)
        }
  for (const tempered of [undefined, true, false])
    expect(verdictsFor(card({ id: 'retired', status: 'closed', shuttleKind: 'standing', tempered }))).toEqual([])
  expect(verdictsFor(card({ id: 'oneshot', status: 'open', shuttleKind: 'oneshot' }))).toEqual(['temper', 'discard'])
})

it('offers no verdicts for an idle standing seat, whether paused or armed; a running one tempers its run or retires', () => {
  for (const status of ['open', 'active']) {
    const seat = card({ id: 'seat', status, shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden' })
    expect(verdictsFor(seat)).toEqual([])
  }
  expect(verdictsFor(card({ id: 'seat', status: 'active', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden', workerState: 'running' }))).toEqual(['temper', 'discard'])
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

describe('a thread with its orchestrator for review', () => {
  const withOrchestrator = card({ id: 'hub/fit', shuttleKind: 'oneshot', status: 'closed', column: 'orchestratorReview' })
  const marked = card({ id: 'hub/marked', shuttleKind: 'oneshot', status: 'closed', reviewMark: { note: 'the fit moved by 2 sigma', at: '2026-11-09T10:00:00Z' } })

  it('says so, and the human can still settle it or move it to review', () => {
    expect(fiberPageKicker(withOrchestrator)).toBe('With its orchestrator for review')
    expect(verdictsFor(withOrchestrator)).toEqual(['temper', 'discard'])
    expect(reviewReachable(withOrchestrator)).toBe(true)
  })
  it('a marked thread says why it reached the human', () => {
    expect(marked.column).toBe('awaitingReview')
    expect(fiberPageKicker(marked)).toBe('Marked for your review: the fit moved by 2 sigma')
    expect(fiberPageKicker(card({ id: 'work', shuttleKind: 'oneshot', status: 'closed' }))).toBe('Awaiting your review')
    expect(reviewReachable(marked)).toBe(false)
  })
})
