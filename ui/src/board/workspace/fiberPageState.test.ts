import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { restReachable, reviewReachable, verdictsFor } from './fiberPageState.js'

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

  it('the human can still settle it or move it to review', () => {
    expect(verdictsFor(withOrchestrator)).toEqual(['temper', 'discard'])
    expect(reviewReachable(withOrchestrator)).toBe(true)
  })
  it('a marked thread awaits the human\'s review, and cannot be moved there again', () => {
    expect(marked.column).toBe('awaitingReview')
    expect(reviewReachable(marked)).toBe(false)
  })
})
