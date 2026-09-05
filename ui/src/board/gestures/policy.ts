/** The two decisions a pointerdown needs, both kept free of the DOM so the
 * rules can be read and tested as rules.
 *
 * Gestures is a mode: while it is on, a press on a slide element picks that
 * element up straight away. There is no long-press and no force-click — the
 * mode switch is the whole ceremony. */

/** One element under the pointer, innermost first. */
export interface HitCandidate {
  /** Area of its box, in whatever unit the slide area uses. */
  area: number
  /** The deck's own scaffolding — the section, `.slides`, `.reveal`, `<body>`. */
  structural: boolean
  /** Something with native drag or click semantics of its own: a range input,
   * a link, a button. The deck keeps these; gestures never grab them. */
  interactive: boolean
}

export type HitOutcome =
  /** Grab candidate `index`. */
  | { kind: 'element'; index: number }
  /** Let the deck have the press: the pointer is on its own control. */
  | { kind: 'pass-through' }
  /** Nothing worth grabbing — slide background. */
  | { kind: 'empty' }

/** A box this large is a container, not a thing you meant to point at. */
export const CONTAINER_COVERAGE = 0.8

/** Take the innermost candidate that is neither scaffolding nor a container
 * spanning most of the slide. The complaint: a press on a slide would grab
 * the section or a full-bleed wrapper instead of the paragraph he aimed at. */
export function pickTarget(candidates: readonly HitCandidate[], slideArea: number): HitOutcome {
  const limit = slideArea > 0 ? slideArea * CONTAINER_COVERAGE : Infinity
  for (const [index, candidate] of candidates.entries()) {
    if (candidate.interactive) return { kind: 'pass-through' }
    if (candidate.structural || candidate.area <= 0) continue
    if (candidate.area >= limit) continue
    return { kind: 'element', index }
  }
  return { kind: 'empty' }
}

export type PressPlan =
  /** Move the whole group selection. */
  | 'group'
  /** Move what is already selected. */
  | 'selection'
  /** Select the element under the pointer and move it. */
  | 'element'
  /** Sweep a new marquee. */
  | 'marquee'
  /** Leave the press alone. */
  | 'none'

export interface PressContext {
  hit: HitOutcome
  /** A group is selected and its outline covers the pointer. */
  insideGroupBox: boolean
  /** A single element is selected and its box covers the pointer. */
  insideSelectionBox: boolean
  /** The element under the pointer is the single selection. */
  onSelection: boolean
}

export function planPress(context: PressContext): PressPlan {
  // A control keeps its own behaviour wherever it sits, group or no group.
  if (context.hit.kind === 'pass-through') return 'none'
  // A group is sticky: every press inside its outline moves the whole thing,
  // members and background alike. Picking one element out means dropping the
  // group first — click outside it, or Escape.
  if (context.insideGroupBox) return 'group'
  if (context.hit.kind === 'element') return context.onSelection ? 'selection' : 'element'
  // Background inside a single selection's own box still moves that selection.
  if (context.insideSelectionBox) return 'selection'
  return 'marquee'
}
