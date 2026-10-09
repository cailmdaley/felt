import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { restReachable } from './fiberPageState.js'

describe('Rest eligibility', () => {
  it('reaches constitutions regardless of status, verdict, horizon or kind', () => {
    for (const shuttleKind of ['oneshot', 'standing'] as const)
      for (const status of ['open', 'active', 'closed'])
        for (const tempered of [undefined, true, false])
          for (const effectiveHorizon of ['now', 'stashed'] as const)
            expect(restReachable(card({ id: 'work', shuttleKind, status, tempered, effectiveHorizon }))).toBe(true)
    expect(restReachable(card({ id: 'agent', shuttleKind: undefined, shuttleAgent: 'claude-opus' }))).toBe(true)
    expect(restReachable(card({ id: 'seat', shuttleKind: 'standing', shuttleSeat: 'warden' }))).toBe(true)
  })

  it('does not offer Shuttle rest for ordinary notes or non-Shuttle cycles', () => {
    const note = card({ id: 'note', shuttleKind: undefined, shuttleAgent: undefined })
    expect(restReachable(note)).toBe(false)
    expect(restReachable({ ...note, isCycle: true })).toBe(false)
  })
})
