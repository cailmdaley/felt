// The civil-day laws, over the zone space.
//
// Every zone-dependent computation on the board lives in civilDay.ts and takes
// its zone as an argument, so these properties put each question to zones drawn
// from the whole IANA database — weighted toward the ones that break things —
// in a single run, whatever zone the process itself happens to be in.
// Instants are drawn across decades, and half of them from within hours of one
// of the drawn zone's own transitions, which is where every bug of this class
// lives.

import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  ascByKey,
  civilDayAt,
  dueCivilDay,
  dueSortMs,
  instantMs,
  isoDayLocal,
  RAIL_START_HOUR,
  railBounds,
  railCivilDay,
  railDayReader,
  sameCivilDue,
  shiftCivilDay,
  wallClock,
  zone,
  type Zone,
} from './civilDay.js'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const RUNS = 200

// ── The zone space ───────────────────────────────────────────────────────────

/** The zones that break things: both signs of offset, the ±12/+14 extremes,
 *  half-hour and 45-minute offsets, DST in both hemispheres, a 30-minute DST
 *  shift, transitions AT midnight (so local midnight does not exist), and
 *  Dublin's negative DST. */
const INTERESTING = [
  'UTC',
  'America/Los_Angeles',
  'Europe/Paris',
  'Etc/GMT+12',
  'Pacific/Pago_Pago',
  'Pacific/Kiritimati',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Australia/Adelaide',
  'Australia/Lord_Howe',
  'America/St_Johns',
  'America/Santiago',
  'America/Havana',
  'America/Asuncion',
  'Asia/Beirut',
  'Africa/Cairo',
  'Africa/Casablanca',
  'Asia/Tehran',
  'Europe/Dublin',
  'America/Sao_Paulo',
]

const zones: fc.Arbitrary<Zone> = fc
  .oneof(
    { weight: 3, arbitrary: fc.constantFrom(...INTERESTING) },
    { weight: 2, arbitrary: fc.constantFrom(...Intl.supportedValuesOf('timeZone')) },
  )
  .map(zone)

// The years drawn: decades of rule changes (zones gaining and dropping DST)
// and none of the handful of days a zone skipped outright, the last of which
// was Samoa's 2011-12-30.
const FIRST_YEAR = 2012
const LAST_YEAR = 2045

/** The instants in a year at which a zone's offset changes, to the minute —
 *  found by bisecting fortnightly samples. Memoized: generators ask often. */
const found = new Map<string, number[]>()
function transitions(z: Zone, year: number): number[] {
  const key = `${z.id}|${year}`
  const known = found.get(key)
  if (known) return known
  const out: number[] = []
  found.set(key, out)
  const end = Date.UTC(year + 1, 0, 1)
  let a = Date.UTC(year, 0, 1)
  while (a < end) {
    let b = Math.min(a + 14 * DAY, end)
    const offA = z.offsetMs(a)
    if (z.offsetMs(b) !== offA) {
      let lo = a
      let hi = b
      while (hi - lo > 60_000) {
        const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000
        if (z.offsetMs(mid) === offA) lo = mid
        else hi = mid
      }
      out.push(hi)
      b = hi
    }
    a = b
  }
  return out
}

/** A zone and an instant in it: uniform over the years half the time, and
 *  otherwise within twelve hours of one of that zone's own transitions. */
const zonedInstants = fc
  .tuple(
    zones,
    fc.integer({ min: FIRST_YEAR, max: LAST_YEAR }),
    fc.boolean(),
    fc.nat(),
    fc.integer({ min: -12 * HOUR, max: 12 * HOUR }),
  )
  .map(([z, year, nearTransition, pick, delta]) => {
    const near = nearTransition ? transitions(z, year) : []
    const ms = near.length > 0
      ? near[pick % near.length] + delta
      : Date.UTC(year, 0, 1) + (pick % (365 * DAY))
    return { z, ms }
  })

/** A zone and a civil day: any day of the years, or — half the time — a day
 *  on which that zone changes its clocks. */
const zonedDays = fc
  .tuple(zones, fc.integer({ min: FIRST_YEAR, max: LAST_YEAR }), fc.boolean(), fc.nat())
  .map(([z, year, transitionDay, pick]) => {
    const near = transitionDay ? transitions(z, year) : []
    const day = near.length > 0
      ? isoDayLocal(near[pick % near.length], z)
      : shiftCivilDay(`${year}-01-01`, pick % 365)
    return { z, day }
  })

/** Any civil day of the years, zone-free. */
const civilDays = fc
  .integer({ min: Date.UTC(FIRST_YEAR, 0, 1) / DAY, max: Date.UTC(LAST_YEAR, 11, 31) / DAY })
  .map((n) => new Date(n * DAY).toISOString().slice(0, 10))

/** A declared UTC offset as a writer spells it: `Z`, `+02:00`, `-0330`. */
const offsets = fc
  .tuple(
    fc.integer({ min: -12 * 4, max: 14 * 4 }).map((q) => q * 15),
    fc.boolean(),
    fc.boolean(),
  )
  .map(([minutes, colon, zulu]) => {
    if (minutes === 0 && zulu) return { minutes, text: 'Z' }
    const sign = minutes < 0 ? '-' : '+'
    const abs = Math.abs(minutes)
    const hh = String(Math.floor(abs / 60)).padStart(2, '0')
    const mm = String(abs % 60).padStart(2, '0')
    return { minutes, text: `${sign}${hh}${colon ? ':' : ''}${mm}` }
  })

/** Every spelling a `due:` naming `day` can arrive in: bare, or midnight in
 *  some declared offset, with or without fractional seconds. */
function spellings(day: string): fc.Arbitrary<string> {
  return fc.oneof(
    fc.constant(day),
    fc.tuple(offsets, fc.constantFrom('', '.0', '.000')).map(
      ([offset, frac]) => `${day}T00:00:00${frac}${offset.text}`,
    ),
  )
}

// ── The oracle ───────────────────────────────────────────────────────────────

/** An instant's wall clock in a zone, read straight off an `en-CA` formatter
 *  (one per zone, reused) — no offset arithmetic, nothing shared with
 *  civilDay.ts. */
const oracleFormats = new Map<string, Intl.DateTimeFormat>()
function oracle(ms: number, z: Zone): { day: string; hour: number; minute: number } {
  let f = oracleFormats.get(z.id)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: z.id,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    oracleFormats.set(z.id, f)
  }
  const p = Object.fromEntries(f.formatToParts(ms).map((x) => [x.type, x.value]))
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) }
}

// ── The laws ─────────────────────────────────────────────────────────────────

describe('civil days and instants, in every zone', () => {
  it('reads an instant’s day and wall clock exactly as Intl does', () => {
    fc.assert(fc.property(zonedInstants, ({ z, ms }) => {
      const want = oracle(ms, z)
      expect(isoDayLocal(ms, z)).toBe(want.day)
      const clock = wallClock(ms, z)
      expect([clock.hour, clock.minute]).toEqual([want.hour, want.minute])
    }), { seed: 0x7a11ce, numRuns: RUNS })
  })

  it('names the leading date of a declared midnight in every viewing zone', () => {
    // The original bug: `2026-07-31T00:00:00Z` read as an instant is Jul 30 in
    // Los Angeles, so a card due Thursday rendered on Wednesday.
    const dues = civilDays.chain((day) => fc.tuple(fc.constant(day), spellings(day)))
    fc.assert(fc.property(dues, zones, ([day, due], z) => {
      expect(dueCivilDay(due, z)).toBe(day)
      expect(isoDayLocal(dueSortMs(due, z)!, z)).toBe(day)
    }), { seed: 0xd0e, numRuns: RUNS })
  })

  it('takes a civil day to the first instant of that day and back', () => {
    // Including the days a zone springs forward at midnight, where the
    // wall-clock midnight does not exist and the day starts at 01:00.
    fc.assert(fc.property(zonedDays, fc.integer({ min: 0, max: 23 }), ({ z, day }, hour) => {
      const start = civilDayAt(day, 0, z)!
      expect(isoDayLocal(start, z)).toBe(day)
      expect(isoDayLocal(start - 1, z)).toBe(shiftCivilDay(day, -1))
      // Any wall hour lands on the day, at that hour — or, if the clocks
      // skipped it, just past the gap.
      const at = civilDayAt(day, hour, z)!
      expect(isoDayLocal(at, z)).toBe(day)
      const clock = wallClock(at, z)
      if (clock.hour !== hour) {
        expect(clock.hour).toBeGreaterThan(hour)
        expect(z.offsetMs(at - HOUR)).not.toBe(z.offsetMs(at))
      }
    }), { seed: 0x5eed, numRuns: RUNS })
  })

  it('puts an instant on its own day’s rail iff its wall hour has reached the start', () => {
    // Drawn with a bias toward the rail edge on transition days: the hour a
    // millisecond subtraction and a wall-clock reading disagree.
    const railEdges = zonedDays.chain(({ z, day }) =>
      fc.integer({ min: -2 * HOUR, max: 2 * HOUR }).map((delta) => ({
        z,
        ms: civilDayAt(day, RAIL_START_HOUR, z)! + delta,
      })),
    )
    fc.assert(fc.property(fc.oneof(zonedInstants, railEdges), fc.integer({ min: 0, max: 12 }), ({ z, ms }, startHour) => {
      const { day, hour } = oracle(ms, z)
      const want = hour >= startHour ? day : shiftCivilDay(day, -1)
      expect(railCivilDay(ms, startHour, z)).toBe(want)
    }), { seed: 0x6a11, numRuns: RUNS })
  })

  it('tiles the timeline with rails: no gaps, no overlaps, each instant in its own', () => {
    fc.assert(fc.property(zonedInstants, ({ z, ms }) => {
      const day = railCivilDay(ms, RAIL_START_HOUR, z)
      const rail = railBounds(day, z)
      expect(rail.startMs).toBeLessThanOrEqual(ms)
      expect(ms).toBeLessThan(rail.endMs)
      // Neighbours abut exactly, and a rail is a day give or take a DST shift.
      expect(railBounds(shiftCivilDay(day, 1), z).startMs).toBe(rail.endMs)
      expect(railBounds(shiftCivilDay(day, -1), z).endMs).toBe(rail.startMs)
      expect(Math.abs(rail.endMs - rail.startMs - DAY)).toBeLessThanOrEqual(HOUR)
    }), { seed: 0x711e, numRuns: RUNS })
  })

  it('reads a run of instants onto the same rails one at a time would', () => {
    const runs = zonedInstants.chain(({ z, ms }) =>
      fc.array(fc.integer({ min: -3 * DAY, max: 3 * DAY }), { minLength: 1, maxLength: 40 })
        .map((steps) => ({ z, times: steps.map((step) => ms + step) })),
    )
    fc.assert(fc.property(runs, fc.boolean(), ({ z, times }, sorted) => {
      const read = railDayReader(z)
      for (const t of sorted ? [...times].sort((a, b) => a - b) : times) {
        expect(read(t)).toBe(railCivilDay(t, RAIL_START_HOUR, z))
      }
    }), { seed: 0x2ead, numRuns: RUNS })
  })

  it('sorts one instant equal to itself however its offset is written', () => {
    /** An instant written as RFC3339 in a declared offset. */
    const written = (ms: number, offset: { minutes: number; text: string }): string => {
      const wallIso = new Date(ms + offset.minutes * 60_000).toISOString().slice(0, 23)
      return `${wallIso}${offset.text}`
    }
    const instants = fc.integer({ min: Date.UTC(FIRST_YEAR, 0, 1), max: Date.UTC(LAST_YEAR, 0, 1) })
    fc.assert(fc.property(instants, offsets, offsets, (ms, a, b) => {
      const ka = instantMs(written(ms, a))
      const kb = instantMs(written(ms, b))
      expect(ka).toBe(ms)
      expect(kb).toBe(ms)
      expect(ascByKey(ka, kb)).toBe(0)
    }), { seed: 0x0ff5e7, numRuns: RUNS })
  })

  it('calls every serialization of one civil day the same due, both ways round', () => {
    const pairs = civilDays.chain((day) => fc.tuple(spellings(day), spellings(day), spellings(shiftCivilDay(day, 1))))
    fc.assert(fc.property(pairs, zones, ([a, b, nextDay], z) => {
      expect(sameCivilDue(a, a, z)).toBe(true)
      expect(sameCivilDue(a, b, z)).toBe(true)
      expect(sameCivilDue(b, a, z)).toBe(true)
      expect(sameCivilDue(a, nextDay, z)).toBe(false)
      expect(sameCivilDue(a, null, z)).toBe(false)
    }), { seed: 0x5a3e, numRuns: RUNS })
  })
})
