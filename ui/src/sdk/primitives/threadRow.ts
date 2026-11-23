import { attentionOf, doingOf, roleOf, slugOf } from '../model.js'
import type { ShuttleFiber } from '../types.js'
import { flag, part, pressable } from './dom.js'
import { createTime } from './time.js'

/** How much of a thread a row shows: its state, slug, doing and age on one line, or its state, slug and office. */
export type ThreadRowDensity = 'line' | 'chip'

export interface ThreadRowOptions {
  /** Epoch ms the age is measured to. */
  now: number
  density?: ThreadRowDensity
  /** Opens the thread; given it, the row is a button for the pointer and the keyboard. */
  onOpen?(fiber: ShuttleFiber): void
}

/**
 * A fiber as one row, `<div data-slot="shuttle-thread-row">`, with its
 * `state`, `slug`, and either `doing` and `age` (a line) or `role` (a chip).
 * The root carries `data-density`, `data-attention`, `data-turn`,
 * `data-fiber`, `data-origin` and, for a file that would not parse,
 * `data-unreadable`.
 */
export function createThreadRow(fiber: ShuttleFiber, { now, density = 'line', onOpen }: ThreadRowOptions): HTMLDivElement {
  const attention = attentionOf(fiber), slug = slugOf(fiber), office = roleOf(fiber)
  const row = part('div', 'shuttle-thread-row')
  row.dataset.density = density
  row.dataset.attention = attention
  row.dataset.turn = fiber.turn ?? 'none'
  row.dataset.fiber = fiber.fiber.uid ?? fiber.fiber.id
  row.dataset.origin = fiber.origin
  flag(row, 'unreadable', !!fiber.fiber.unreadable)
  const state = part('span', 'state')
  state.dataset.attention = attention
  state.setAttribute('aria-hidden', 'true')
  row.append(state, part('span', 'slug', slug))
  const role = office && office !== slug ? office : ''
  let label = `${slug}, ${attention}`
  if (density === 'line') {
    const { text, at } = doingOf(fiber)
    const age = part('span', 'age')
    age.append(createTime(at, now, { short: true }))
    row.append(part('span', 'doing', text), age)
    row.title = `${fiber.fiber.name} — ${role ? `${role} · ` : ''}${text}`
    label = `${slug}, ${attention}: ${text}`
  } else {
    if (role) row.append(part('span', 'role', role))
    row.title = role ? `${fiber.fiber.name} — ${role}` : fiber.fiber.name
  }
  if (onOpen) pressable(row, label, () => onOpen(fiber))
  return row
}
