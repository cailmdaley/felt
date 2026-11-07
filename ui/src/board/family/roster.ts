import { cloth } from './cloth.js'
import type { Drawing } from './drawing.js'
import { radial } from './radial.js'

/** The two drawings, first the default. */
export const ROSTER: readonly Drawing[] = [radial, cloth]

const KEY = 'shuttle.family.drawing'
/** The drawing last chosen in this browser, if storage holds a current one. */
export function chosenDrawing(): Drawing | undefined {
  try {
    const name = localStorage.getItem(KEY)
    return ROSTER.find(drawing => drawing.name === name)
  } catch { return undefined }
}
export function chooseDrawing(drawing: Drawing): void {
  try { localStorage.setItem(KEY, drawing.name) } catch { /* Storage is optional. */ }
}
