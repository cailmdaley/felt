import { instantStamp, relativeAge } from '../civilDay.js'
import './time.css'

/** How long ago an instant was: `now`, `12m ago`, `5h ago` under a day, then `3d ago` (its arithmetic lives with every other clock, in civilDay.ts). */
export const relative = relativeAge

/** A time as every element draws one: relative, mono and muted, the instant in full on hover. */
export function timeEl(at: number, now: number, className = ''): HTMLElement {
  const time = document.createElement('time')
  time.className = ['el-time', className].filter(Boolean).join(' ')
  time.textContent = relative(at, now)
  if (at > 0) {
    time.dataset.at = String(at)
    time.dateTime = new Date(at).toISOString()
    time.title = instantStamp(at)
  }
  return time
}

/** Brings every time under `root` up to `now`. */
export function retime(root: ParentNode, now: number): void {
  for (const time of root.querySelectorAll<HTMLElement>('.el-time[data-at]')) time.textContent = relative(Number(time.dataset.at), now)
}
