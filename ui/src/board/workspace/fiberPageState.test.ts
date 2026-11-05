import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { restReachable, verdictsFor } from './fiberPageState.js'

it('does not offer Temper for open standing cards on any planning surface', () => {
  for (const effectiveHorizon of ['now', 'stashed'] as const)
    for (const tempered of [undefined, true, false])
      for (const workerState of [undefined, 'running'] as const) {
        const draft = card({ id: 'draft', status: 'open', shuttleKind: 'standing', effectiveHorizon, tempered, workerState })
        expect(verdictsFor(draft)).toEqual(tempered == null ? ['discard'] : [])
      }
  expect(verdictsFor(card({ id: 'oneshot', status: 'open', shuttleKind: 'oneshot' }))).toEqual(['temper', 'discard'])
  for (const status of ['active', 'closed'])
    expect(verdictsFor(card({ id: 'run', status, shuttleKind: 'standing', workerState: status === 'active' ? 'running' : undefined }))).toEqual(['temper', 'discard'])
})

describe('Rest eligibility', () => {
  it('reaches constitutions regardless of status, verdict, horizon or kind', () => {
    for (const shuttleKind of ['oneshot', 'standing'] as const)
      for (const status of ['open', 'active', 'closed'])
        for (const tempered of [undefined, true, false])
          for (const effectiveHorizon of ['now', 'stashed'] as const)
            expect(restReachable(card({ id: 'work', shuttleKind, status, tempered, effectiveHorizon }))).toBe(true)
    expect(restReachable(card({ id: 'agent', shuttleKind: undefined, shuttleAgent: 'claude-opus' }))).toBe(true)
    expect(restReachable(card({ id: 'seat', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'warden' }))).toBe(true)
  })

  it('does not offer Shuttle rest for ordinary notes or non-Shuttle cycles', () => {
    const note = card({ id: 'note', shuttleKind: undefined, shuttleAgent: undefined })
    expect(restReachable(note)).toBe(false)
    expect(restReachable({ ...note, isCycle: true })).toBe(false)
  })
})
