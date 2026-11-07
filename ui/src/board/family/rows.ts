import { ATTENTION_WORD, type Attention, type FamilyModel, type MapThread } from './model.js'
import { HOUR, TIME_MARKS, htmlEl, optionFor, reconcile, shortAgo, tagThread } from './drawing.js'

export interface Row { thread: MapThread; y: number; height: number; loud: boolean }
export interface Head { label: string; y: number }
export interface RowPlan { rows: Row[]; heads: Head[]; height: number }
/** Rows in attention order under their kind's head, then quiet history as thin lines. */
export function planRows(threads: readonly MapThread[], heading: (thread: MapThread) => string | null, top: number, row: number, thin: number): RowPlan {
  const rows: Row[] = [], heads: Head[] = []
  let y = top, last: string | null = null
  for (const thread of threads) {
    const head = heading(thread)
    if (head && head !== last) { if (last) y += 10; heads.push({ label: head, y }); y += 22 }
    if (!head && last) y += 14
    last = head
    const height = head ? row : thin
    rows.push({ thread, y, height, loud: !!head })
    y += height
  }
  return { rows, heads, height: y + 10 }
}

/** A thread's head in the attention order, or null for quiet history. */
export const heading = (model: FamilyModel, thread: MapThread): string | null =>
  model.attention.includes(thread) ? ATTENTION_WORD[thread.standing as Attention] : null

/** The time scale over a drawing's rows. */
export function axis(layer: HTMLElement, x: (at: number) => number, now: number): void {
  const ticks: ReadonlyArray<readonly [number, string]> = [[0, 'now'], ...TIME_MARKS.filter(([back]) => back > HOUR)]
  reconcile(layer, ticks, ([, label]) => label, ([, label]) => htmlEl('span', '', label), (el, [back]) => { el.style.left = `${Math.max(14, x(now - back)).toFixed(1)}px` })
}

/** The label of a row, shared by the cloth and the delta. */
export function makeRow(): HTMLElement {
  const row = htmlEl('div', 'fm-row'), label = htmlEl('div', 'fm-row-label')
  label.append(htmlEl('span', 'fm-row-name'), htmlEl('span', 'fm-row-note'))
  row.append(label, htmlEl('span', 'fm-row-age'))
  return row
}
export function fillRow(row: HTMLElement, { thread, y, height, loud }: Row, model: FamilyModel): void {
  tagThread(row, thread); optionFor(row, thread, model)
  row.toggleAttribute('data-loud', loud)
  row.style.height = `${height}px`
  row.style.transform = `translateY(${y}px)`
  row.querySelector('.fm-row-name')!.textContent = thread.name
  row.querySelector('.fm-row-note')!.textContent = thread.note
  row.querySelector('.fm-row-age')!.textContent = loud ? shortAgo(thread.lastMove, model.now) : ''
}
/** The heads of the attention kinds, as rows of their own. */
export function drawHeads(layer: HTMLElement, plan: RowPlan): void {
  reconcile(layer, plan.heads, head => head.label, head => htmlEl('div', 'fm-head', head.label), (el, head) => { el.style.transform = `translateY(${head.y}px)` })
}
