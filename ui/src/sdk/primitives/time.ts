import { instantStamp, relativeAge } from '../civilDay.js'
import { part } from './dom.js'

export interface TimeOptions {
  /** Drop the "ago", where a column of ages reads as ages already: `12m`, `5h`, `3d`. */
  short?: boolean
}

/**
 * An age as a `<time data-slot="shuttle-time">`: relative (`now`, `12m ago`,
 * `5h ago`, `3d ago`), its instant in `datetime` and in full in its title.
 * `retimeAll` brings it up to date in place.
 */
export function createTime(atMs: number, nowMs: number, options: TimeOptions = {}): HTMLTimeElement {
  const time = part('time', 'shuttle-time', relativeAge(atMs, nowMs, options))
  if (options.short) time.dataset.short = ''
  if (Number.isFinite(atMs) && atMs > 0) {
    time.dataset.at = String(atMs)
    time.dateTime = new Date(atMs).toISOString()
    time.title = instantStamp(atMs)
  }
  return time
}

/** Bring every `shuttle-time` under `root` up to `nowMs`. */
export function retimeAll(root: ParentNode, nowMs: number): void {
  for (const time of root.querySelectorAll<HTMLElement>('[data-slot="shuttle-time"][data-at]')) {
    time.textContent = relativeAge(Number(time.dataset.at), nowMs, { short: 'short' in time.dataset })
  }
}
