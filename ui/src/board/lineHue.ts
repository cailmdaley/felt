import type { KanbanCard } from './KanbanTypes.js'
import { fiberOf } from './channels.js'

/**
 * A thread's identity colour, one of six (`--kbn-line-0` to `-5`), the same
 * wherever it is drawn: its fibre in Channels' margin, its slug, and its line
 * in the constitution view. An element with `data-hue` takes it as `--line`.
 */
export const lineHue = (card: KanbanCard): string => {
  let hash = 0
  for (const char of fiberOf(card)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return String(hash % 6)
}
