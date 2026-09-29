/**
 * The rail arithmetic behind the chronicle's day columns.
 *
 * A RAIL is a day as the board means it: 6am to 6am, because work that runs
 * past midnight belongs to the day it started. Chronicle positions, folds and
 * chunks its fetches on this boundary.
 *
 * Sits on top of `../civilDay.js`, which owns the civil-day/instant primitives
 * the whole board uses; what is here is the part only the temporal views need.
 */

import { civilDayToLocalDate, isoDayLocal, RAIL_START_HOUR } from '../civilDay.js'

/**
 * A civil day materialized as a local `Date` parked at NOON — the safe anchor
 * for calendar-day arithmetic. Noon because midnight is the one wall-clock
 * time a spring-forward day can lack, and `setDate` from noon lands on noon of
 * the target calendar day in every zone and across every transition.
 * Undefined when the string is not a civil day.
 */
export function civilDayNoon(day: string | undefined): Date | undefined {
  const d = civilDayToLocalDate(day)
  if (!d) return undefined
  d.setHours(12, 0, 0, 0)
  return d
}

/**
 * The civil day `delta` CALENDAR days from `day`, negative for earlier; `day`
 * itself when it is not a civil day. Strides through the noon anchor, never by
 * adding 86_400_000 — that skips a day forward in spring and repeats one in
 * autumn.
 */
export function shiftCivilDay(day: string, delta: number): string {
  const d = civilDayNoon(day)
  if (!d) return day
  d.setDate(d.getDate() + delta)
  return isoDayLocal(d.getTime())
}

interface RailBounds {
  /** Local 6am on the day — the rail's left edge. */
  startMs: number
  /** Local 6am on the NEXT calendar day — the right edge. 23h, 24h or 25h. */
  endMs: number
}

/**
 * The instant span one civil day's rail covers. Both edges are real 6am
 * wall-clock times, so a DST rail is genuinely 23h or 25h long and everything
 * positioned on it by time fraction stays in the right place.
 *
 * Unparseable input yields `{0, 0}`; a caller that needs a different fallback
 * must validate before calling.
 */
export function railBounds(day: string): RailBounds {
  const start = civilDayNoon(day)
  const end = civilDayNoon(day)
  if (!start || !end) return { startMs: 0, endMs: 0 }
  end.setDate(end.getDate() + 1)
  start.setHours(RAIL_START_HOUR, 0, 0, 0)
  end.setHours(RAIL_START_HOUR, 0, 0, 0)
  return { startMs: start.getTime(), endMs: end.getTime() }
}
