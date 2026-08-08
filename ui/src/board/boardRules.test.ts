// Rules the desk depends on, pinned in both hemispheres.
//
// `npm test` runs this file twice — TZ=America/Los_Angeles and TZ=Europe/Paris
// — because the snooze rules turn on CIVIL DAYS and the classic failure is a
// negative-offset zone reading UTC midnight as the previous evening. Every due
// here is therefore built FROM the reference instant with `isoDayLocal`, never
// written as a literal date: a hardcoded `2026-08-12` would name a different
// day either side of the Atlantic and the test would only be checking one.

import { describe, expect, it } from 'vitest'
import { effectiveHorizon, humanizeCron, restingUntil } from './KanbanRules.js'
import { humanizeIdleAge, phasePillLabel } from './KanbanSurfaces.js'
import { isoDayLocal } from './civilDay.js'

const NOW = Date.parse('2026-08-08T15:30:00Z')
const DAY = 86_400_000
const dayFromNow = (n: number): string => isoDayLocal(NOW + n * DAY)

describe('effectiveHorizon — snooze is due + stashed, composed', () => {
  it('rests a stashed card whose due is still ahead', () => {
    const h = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(3) }, NOW)
    expect(h.effectiveHorizon).toBe('stashed')
    expect(h.drifted).toBe(false)
  })

  it('keeps a plain future-dated card on the timeline, not in Resting', () => {
    // The control for the case above: without a stored horizon the same due
    // means "scheduled", and scheduling has always been `soon`.
    expect(effectiveHorizon({ due: dayFromNow(3) }, NOW).effectiveHorizon).toBe('soon')
  })

  it('DRIFT OVERRIDES STASHED — the day arrives and the card returns to the desk', () => {
    // Snooze's return ticket. Without this the card would rest forever holding
    // a date nobody reads, and snooze would be a black hole.
    const today = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(0) }, NOW)
    expect(today.effectiveHorizon).toBe('now')
    expect(today.drifted).toBe(true)

    const overdue = effectiveHorizon({ horizon: 'stashed', due: dayFromNow(-2) }, NOW)
    expect(overdue.effectiveHorizon).toBe('now')
    expect(overdue.drifted).toBe(true)
  })

  it('wakes on the civil day the due NAMES, through felt\'s midnight storage', () => {
    // felt serializes a `due:` as a timestamp at midnight in whatever offset
    // wrote it. Both of these name tomorrow's date as a civil day, so both must
    // still be resting — reading either as an instant loses a day somewhere.
    for (const offset of ['Z', '+02:00', '-07:00']) {
      const due = `${dayFromNow(1)}T00:00:00${offset}`
      expect(effectiveHorizon({ horizon: 'stashed', due }, NOW).effectiveHorizon).toBe('stashed')
    }
  })

  it('leaves a dateless rest resting', () => {
    expect(effectiveHorizon({ horizon: 'stashed' }, NOW).effectiveHorizon).toBe('stashed')
  })
})

describe('restingUntil', () => {
  it('names the wake day for a snoozed card', () => {
    expect(restingUntil({ horizon: 'stashed', due: dayFromNow(4) }, NOW)).toBe(dayFromNow(4))
  })

  it('is undefined for a dateless rest and for a card the drift already woke', () => {
    expect(restingUntil({ horizon: 'stashed' }, NOW)).toBeUndefined()
    expect(restingUntil({ horizon: 'stashed', due: dayFromNow(-1) }, NOW)).toBeUndefined()
  })

  it('is undefined for a scheduled card — that one is on the timeline, not resting', () => {
    expect(restingUntil({ due: dayFromNow(2) }, NOW)).toBeUndefined()
  })
})

describe('humanizeIdleAge', () => {
  it('reads one unit, coarsening as it grows', () => {
    expect(humanizeIdleAge(0)).toBe('0m')
    expect(humanizeIdleAge(45_000)).toBe('0m')          // no seconds, ever
    expect(humanizeIdleAge(12 * 60_000)).toBe('12m')
    expect(humanizeIdleAge(59 * 60_000)).toBe('59m')
    expect(humanizeIdleAge(60 * 60_000)).toBe('1h')
    expect(humanizeIdleAge(3 * 3_600_000 + 40 * 60_000)).toBe('3h')
    expect(humanizeIdleAge(23 * 3_600_000)).toBe('23h')
    expect(humanizeIdleAge(2 * DAY + 5 * 3_600_000)).toBe('2d')
  })

  it('never renders a negative or absent age as anything but 0m', () => {
    expect(humanizeIdleAge(-5_000)).toBe('0m')
    expect(humanizeIdleAge(undefined)).toBe('0m')
    expect(humanizeIdleAge(Number.NaN)).toBe('0m')
  })
})

describe('phasePillLabel', () => {
  it('always clocks a waiting worker', () => {
    expect(phasePillLabel('waiting', NOW - 12 * 60_000, NOW)).toBe('⏸ waiting · 12m')
    expect(phasePillLabel('waiting', NOW - 3 * 3_600_000, NOW)).toBe('⏸ waiting · 3h')
    expect(phasePillLabel('waiting', NOW - 2 * DAY, NOW)).toBe('⏸ waiting · 2d')
  })

  it('clocks attention only once it has gone an hour unanswered', () => {
    expect(phasePillLabel('attention', NOW - 4 * 60_000, NOW)).toBe('☞︎ needs you now')
    expect(phasePillLabel('attention', NOW - 90 * 60_000, NOW)).toBe('☞︎ needs you now · 1h')
  })

  it('falls back to the bare label with no activity stamp', () => {
    expect(phasePillLabel('waiting', undefined, NOW)).toBe('⏸ waiting')
    expect(phasePillLabel('dispatched', NOW - DAY, NOW)).toBe('▸ dispatched')
  })
})

describe('humanizeCron', () => {
  it('says the cadences a person says', () => {
    expect(humanizeCron('0 9 * * 1-5')).toBe('weekdays 9:00')
    expect(humanizeCron('30 6 * * *')).toBe('daily 6:30')
    expect(humanizeCron('0 8 * * 1')).toBe('Mon 8:00')
    expect(humanizeCron('15 20 * * 0,6')).toBe('weekends 20:15')
    expect(humanizeCron('0 7 * * 1,3,5')).toBe('Mon, Wed, Fri 7:00')
  })

  it('stays silent rather than lie about a schedule it cannot say', () => {
    expect(humanizeCron('*/15 * * * *')).toBeUndefined()   // many hours
    expect(humanizeCron('0 9 1 * *')).toBeUndefined()      // day-of-month
    expect(humanizeCron('0 9 * 3 *')).toBeUndefined()      // one month only
    expect(humanizeCron('not a cron')).toBeUndefined()
    expect(humanizeCron('')).toBeUndefined()
    expect(humanizeCron(undefined)).toBeUndefined()
  })
})
