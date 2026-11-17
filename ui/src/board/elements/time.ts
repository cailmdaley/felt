import { instantStamp, relativeAge } from '../civilDay.js'
import './time.css'

/** How long ago an instant was: `now`, `12m ago`, `5h ago` under a day, then `3d ago` (its arithmetic lives with every other clock, in civilDay.ts). */
export const relative = relativeAge

/** An age without its "ago", where a row of them reads as ages already: `now`, `24m`, `4h`, `4d`. */
export const brief = (at: number, now: number): string => relative(at, now).replace(/ ago$/, '')

/** A time as every element draws one: relative (`short`, without its "ago"), mono and muted, the instant in full on hover. */
export function timeEl(at: number, now: number, className = '', short = false): HTMLElement {
  const time = document.createElement('time')
  time.className = ['el-time', className].filter(Boolean).join(' ')
  time.textContent = (short ? brief : relative)(at, now)
  if (short) time.dataset.short = ''
  if (at > 0) {
    time.dataset.at = String(at)
    time.dateTime = new Date(at).toISOString()
    time.title = instantStamp(at)
  }
  return time
}

/** Brings every time under `root` up to `now`. */
export function retime(root: ParentNode, now: number): void {
  for (const time of root.querySelectorAll<HTMLElement>('.el-time[data-at]')) time.textContent = ('short' in time.dataset ? brief : relative)(Number(time.dataset.at), now)
}
