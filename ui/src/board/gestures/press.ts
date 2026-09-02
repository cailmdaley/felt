/** What a pointerdown on the deck means, decided before any DOM is touched so
 * the rule is testable on its own. The group box being solid to the pointer
 * must not cost an element inside it its long-press. */
export type PressPlan =
  /** Drag the whole group; a long-press picks the element under the pointer
   * out of it instead. */
  | 'group-or-member'
  /** Drag the whole group; there is no single element under the pointer. */
  | 'group'
  /** Long-press to pick this element up. */
  | 'element'
  /** Sweep a new marquee selection. */
  | 'marquee'
  /** Structural chrome (the deck, the slide container) — nothing to grab. */
  | 'none'

export interface PressContext {
  /** A group selection exists and its outline covers the pointer. */
  insideGroupBox: boolean
  /** The pointer is over slide background rather than content. */
  onEmptySpace: boolean
  /** The pointer is over the deck/slide scaffolding itself. */
  onStructural: boolean
}

export function planPress(context: PressContext): PressPlan {
  const onElement = !context.onEmptySpace && !context.onStructural
  if (context.insideGroupBox) return onElement ? 'group-or-member' : 'group'
  if (context.onEmptySpace) return 'marquee'
  return onElement ? 'element' : 'none'
}
