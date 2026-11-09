// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { headerLifecycleVerbsFor, iconVerb, lifecycleVerbsFor, verbSpec } from './lifecycleVerbs.js'

const labels = (verbs: ReturnType<typeof lifecycleVerbsFor>, over: Parameters<typeof card>[0]) =>
  verbs.map(verb => verbSpec(verb, card(over)).label)

describe('a standing constitution names its schedule’s verbs', () => {
  const armed = { id: 'armed', status: 'active', shuttleKind: 'standing', shuttleSchedule: '0 9 * * 1-5' } as const
  const asking = { ...armed, id: 'asking', ask: { text: 'Archive these?', at: '2026-01-01T09:00:00Z' } }
  const running = { ...armed, id: 'running', workerState: 'running' } as const
  const paused = { ...armed, id: 'paused', status: 'open', effectiveHorizon: 'stashed' } as const

  it('offers Pause schedule and Retire while armed — between runs, mid-run, or asking', () => {
    for (const over of [armed, asking, running]) {
      for (const verbs of [lifecycleVerbsFor(card(over), true), headerLifecycleVerbsFor(card(over), true)])
        expect(labels(verbs, over)).toEqual(['Pause schedule', 'Retire'])
    }
    expect(card(asking).column).toBe('inFlight')
    expect(card(armed).column).toBe('resting')
  })

  it('offers Resume schedule and Retire while paused, from Resting', () => {
    expect(card(paused).column).toBe('resting')
    for (const verbs of [lifecycleVerbsFor(card(paused), true), headerLifecycleVerbsFor(card(paused), true)])
      expect(labels(verbs, paused)).toEqual(['Resume schedule', 'Retire'])
    expect(verbSpec('rest', card(paused)).icon).toBe('resume')
  })

  it('never offers Temper or Close for review, and nothing once retired', () => {
    for (const over of [armed, asking, running, paused])
      expect(lifecycleVerbsFor(card(over), true)).not.toContain('temper')
    for (const over of [armed, asking, running, paused])
      expect(lifecycleVerbsFor(card(over), true)).not.toContain('review')
    expect(lifecycleVerbsFor(card({ ...armed, status: 'closed', tempered: false }), true)).toEqual([])
  })

  it('labels its buttons with the card’s word and key', () => {
    const button = iconVerb('rest', card(paused), 'paused')
    expect(button.title).toBe('Resume schedule paused (s)')
    expect(iconVerb('discard', card(armed)).title).toBe('Retire (x)')
    expect(iconVerb('discard', card({ id: 'once', status: 'active' })).title).toBe('Discard (x)')
  })
})

describe('a seat with a pulse names Rest as its schedule’s', () => {
  const pulse = { every: '59m' }
  const armed = { id: 'vizier', status: 'active', shuttleKind: 'oneshot', shuttleSeat: true, shuttleRole: 'vizier', shuttlePulse: pulse, workerState: 'running' } as const
  const atRest = { id: 'vizier', status: 'open', shuttleKind: 'oneshot', shuttleSeat: true, shuttleRole: 'vizier', shuttlePulse: pulse } as const

  it('pauses an armed pulse and resumes one at rest, keeping a oneshot’s other verbs', () => {
    expect(labels(lifecycleVerbsFor(card(armed), true), armed)).toEqual(['Close for review', 'Pause schedule', 'Temper', 'Discard'])
    expect(verbSpec('rest', card(atRest)).label).toBe('Resume schedule')
    expect(verbSpec('rest', card({ id: 'plain', status: 'active', shuttleKind: 'oneshot' })).label).toBe('Rest')
  })
})
