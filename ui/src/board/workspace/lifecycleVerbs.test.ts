// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { card } from '../testFixtures.js'
import { labelVerb, leadVerb, lifecycleVerbsFor, verbSpec, type LifecycleVerb } from './lifecycleVerbs.js'

const labels = (verbs: ReturnType<typeof lifecycleVerbsFor>, over: Parameters<typeof card>[0]) =>
  verbs.map(verb => verbSpec(verb, card(over)).label)

describe('a standing constitution names its schedule’s verbs', () => {
  const armed = { id: 'armed', status: 'active', shuttleKind: 'standing', shuttleSchedule: '0 9 * * 1-5' } as const
  const asking = { ...armed, id: 'asking', ask: { text: 'Archive these?', at: '2026-01-01T09:00:00Z' } }
  const running = { ...armed, id: 'running', workerState: 'running' } as const
  const paused = { ...armed, id: 'paused', status: 'open', effectiveHorizon: 'stashed' } as const

  it('offers Pause schedule and Retire between runs', () => {
    for (const verbs of [lifecycleVerbsFor(card(armed), true)])
      expect(labels(verbs, armed)).toEqual(['Pause schedule', 'Retire'])
    expect(card(armed).column).toBe('resting')
    expect(verbSpec('rest', card(armed)).icon).toBe('pause')
  })

  it('leads with Temper run while a run waits on the human — mid-run or asking', () => {
    for (const over of [asking, running]) {
      for (const verbs of [lifecycleVerbsFor(card(over), true)])
        expect(labels(verbs, over)).toEqual(['Temper run', 'Pause schedule', 'Retire'])
    }
    expect(card(asking).column).toBe('inFlight')
  })

  it('offers Resume schedule and Retire while paused, from Resting', () => {
    expect(card(paused).column).toBe('resting')
    for (const verbs of [lifecycleVerbsFor(card(paused), true)])
      expect(labels(verbs, paused)).toEqual(['Resume schedule', 'Retire'])
    expect(verbSpec('rest', card(paused)).icon).toBe('resume')
  })

  it('never offers Close for review, Temper between runs or paused, and nothing once retired', () => {
    for (const over of [armed, paused])
      expect(lifecycleVerbsFor(card(over), true)).not.toContain('temper')
    for (const over of [armed, asking, running, paused])
      expect(lifecycleVerbsFor(card(over), true)).not.toContain('review')
    expect(lifecycleVerbsFor(card({ ...armed, status: 'closed', tempered: false }), true)).toEqual([])
  })

  it('labels its buttons with the card’s word and key', () => {
    const labelled = (verb: LifecycleVerb, over: Parameters<typeof card>[0], target?: string): string => {
      const button = document.createElement('button'); labelVerb(button, verb, card(over), target); return button.title
    }
    expect(labelled('rest', paused, 'paused')).toBe('Resume schedule paused (s)')
    expect(labelled('discard', armed)).toBe('Retire (x)')
    expect(labelled('discard', { id: 'once', status: 'active' })).toBe('Discard (x)')
  })

  it('wears Temper run on its button’s face while a run waits, else its schedule’s verb', () => {
    for (const over of [asking, running]) expect(leadVerb(card(over), lifecycleVerbsFor(card(over), true))).toBe('temper')
    for (const over of [armed, paused]) expect(leadVerb(card(over), lifecycleVerbsFor(card(over), true))).toBe('rest')
  })
})

describe('a row’s verb button wears the verb that fits its state', () => {
  const lead = (over: Parameters<typeof card>[0], canRest = true) => leadVerb(card(over), lifecycleVerbsFor(card(over), canRest))
  it('closes working work for review, tempers work awaiting it, and rests work at rest', () => {
    expect(lead({ id: 'working', status: 'active', shuttleKind: 'oneshot', workerState: 'running' })).toBe('review')
    expect(lead({ id: 'draft', status: 'open', shuttleKind: 'oneshot', column: 'drafts' })).toBe('review')
    expect(lead({ id: 'done', status: 'closed', shuttleKind: 'oneshot', column: 'awaitingReview' })).toBe('temper')
    expect(lead({ id: 'resting', status: 'open', shuttleKind: 'oneshot', effectiveHorizon: 'stashed' })).toBe('rest')
  })
  it('never leads with Discard: a card offering only Discard keeps it in the menu', () => {
    for (const over of [{ id: 'a', status: 'active' }, { id: 'b', status: 'closed', column: 'awaitingReview' }, { id: 'c', status: 'open', effectiveHorizon: 'stashed' }] as const)
      expect(lead(over, false)).not.toBe('discard')
    expect(leadVerb(card({ id: 'd', status: 'active' }), ['discard'])).toBeUndefined()
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

  it('keeps only its clock while resting among the Roles', () => {
    const seat = { id: 'post', status: 'active', shuttleKind: 'standing', shuttleSeat: true, shuttleRole: 'vizier', column: 'roles' } as const
    expect(labels(lifecycleVerbsFor(card(seat), true), seat)).toEqual(['Pause schedule'])
    const plain = { id: 'desk', status: 'open', shuttleKind: 'oneshot', shuttleSeat: true, shuttleRole: 'editor', column: 'roles' } as const
    expect(lifecycleVerbsFor(card(plain), true)).toEqual([])
  })
})
