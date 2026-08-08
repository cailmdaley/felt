/**
 * The words and marks the temporal views hold in common.
 *
 * Nothing here draws anything — it is the vocabulary the pages agree on, so a
 * glyph that means one thing on one page cannot come to mean something else on
 * another, and the same pigment is never explained two ways. Each view still
 * owns its own shapes: the CSS behind these marks differs per view on purpose.
 */

import type { ActivityBucket } from './TemporalData.js'

// ── Obligations ──────────────────────────────────────────────────────────────

/**
 * What a board surface draws for work that is owed but not yet done.
 *
 *   ◴ due      a card whose `due:` names this civil day
 *   ◐ launch   a standing role's next firing, an instant
 *   ◌ snooze   a stashed card whose due lands here — deferred work returning
 *
 * NOT closure (✓ tempered · ✗ composted · ◦ awaiting a verdict) and not the
 * Kanban card-kind glyphs. Those are different claims that happen to share ink.
 */
export type MarkKind = 'due' | 'launch' | 'snooze'

export const MARK_GLYPH: Record<MarkKind, string> = { due: '◴', launch: '◐', snooze: '◌' }

// ── The activity key ─────────────────────────────────────────────────────────

/**
 * What the three raster pigments mean, in words. One phrasing across the
 * board: Day and Week both spend these pigments and read from this list, so
 * the same hue is never glossed two ways.
 *
 * MIND THE NAMES. The wire's kind `attention` is the human at the keyboard
 * ("you steering"); the kind `notify` is a worker raising its hand, which is
 * what "attention called" names. The word `attention` therefore appears in the
 * vocabulary AND in the gloss of the OTHER kind, which makes this exactly the
 * pairing someone tidies backwards. It is correct as written; TemporalData's
 * bucket docs are the authority. (Flagged twice independently — by
 * builder-week wiring Week's key, and again in Day.)
 */
export const ACTIVITY_KEY_ITEMS: Array<{ kind: ActivityBucket['k']; label: string }> = [
  { kind: 'agent', label: 'agents working' },
  { kind: 'attention', label: 'you steering' },
  { kind: 'notify', label: 'attention called' },
]
