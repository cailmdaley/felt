import { cloth } from './cloth.js'
import { delta } from './delta.js'
import type { Drawing } from './drawing.js'
import { rings } from './rings.js'
import { sky } from './sky.js'
import { spiral } from './spiral.js'

/** The drawings on trial, first the default. */
export const ROSTER: readonly Drawing[] = [sky, rings, spiral, cloth, delta]

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
