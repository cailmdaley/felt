/**
 * Devices the board meets, and a `matchMedia` that answers for them.
 *
 * The stub evaluates the only features the board's queries use — `max-width`,
 * `max-height` and `pointer` — joined by `and` inside a clause and by commas
 * between clauses, so tests evaluate the real query strings from mobile.ts
 * rather than a canned answer per string. Test-only; nothing in the app
 * imports it.
 */
export interface Device {
  width: number
  height: number
  coarse: boolean
}

export const PHONE_PORTRAIT: Device = { width: 390, height: 844, coarse: true }
export const PHONE_LANDSCAPE: Device = { width: 844, height: 390, coarse: true }
export const IPAD_PORTRAIT: Device = { width: 1024, height: 1366, coarse: true }
export const IPAD_LANDSCAPE: Device = { width: 1366, height: 1024, coarse: true }
export const DESKTOP: Device = { width: 1440, height: 900, coarse: false }
export const DESKTOP_NARROW: Device = { width: 600, height: 900, coarse: false }
export const DESKTOP_SHORT: Device = { width: 1440, height: 420, coarse: false }

export function mediaMatches(d: Device, query: string): boolean {
  const feature = (f: string): boolean => {
    const m = /^\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)$/.exec(f.trim())
    if (!m) throw new Error(`unsupported media feature: ${f}`)
    const [, name, value] = m
    if (name === 'max-width') return d.width <= parseFloat(value)
    if (name === 'max-height') return d.height <= parseFloat(value)
    if (name === 'pointer') return (value === 'coarse') === d.coarse
    throw new Error(`unsupported media feature: ${name}`)
  }
  return query.split(',').some((clause) => clause.split(/\band\b/).every(feature))
}

/**
 * A `matchMedia` whose device can change under it: `become(next)` moves to a
 * new device and fires `change` on every list whose answer flipped, the way a
 * resized window or a switched pointer does.
 */
export function liveMedia(initial: Device): {
  matchMedia: (query: string) => MediaQueryList
  become: (next: Device) => void
} {
  let device = initial
  const lists: Array<{ query: string; matches: boolean; listeners: Set<() => void> }> = []
  return {
    matchMedia: (query: string) => {
      const rec = { query, matches: mediaMatches(device, query), listeners: new Set<() => void>() }
      lists.push(rec)
      return {
        get matches() {
          return mediaMatches(device, query)
        },
        media: query,
        addEventListener: (_type: string, fn: () => void) => rec.listeners.add(fn),
        removeEventListener: (_type: string, fn: () => void) => rec.listeners.delete(fn),
      } as unknown as MediaQueryList
    },
    become: (next: Device) => {
      device = next
      for (const rec of lists) {
        const now = mediaMatches(device, rec.query)
        if (now === rec.matches) continue
        rec.matches = now
        for (const fn of [...rec.listeners]) fn()
      }
    },
  }
}

/** A `matchMedia` for `d`, with inert change listeners. */
export function matchMediaFor(d: Device): (query: string) => MediaQueryList {
  return (query: string) =>
    ({
      matches: mediaMatches(d, query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
}
