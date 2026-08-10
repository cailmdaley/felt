/**
 * The words and marks the temporal views hold in common.
 *
 * Nothing here draws anything — it is the vocabulary the pages agree on, so a
 * glyph that means one thing on one page cannot come to mean something else on
 * another, and the same pigment is never explained two ways. Each view still
 * owns its own shapes: the CSS behind these marks differs per view on purpose.
 */

import type { DrawnKind } from './momentTip.js'

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
 * What the raster pigments mean, in words. One phrasing across the board: Day
 * and Week both spend these pigments and read from this list, so the same hue
 * is never glossed two ways.
 *
 * The wire's kind `notify` is not here and draws nothing anywhere. A notify is
 * an idle nudge, not a state of the work; an agent truly blocked on you shows
 * as the GAP on a live lane, which no pigment improves on.
 */
export const ACTIVITY_KEY_ITEMS: Array<{ kind: DrawnKind; label: string }> = [
  { kind: 'agent', label: 'agents working' },
  { kind: 'attention', label: 'you steering' },
]

// ── Message tallies ──────────────────────────────────────────────────────────

/**
 * `you 14 · 9 back` — the exchange, in the order it happened.
 *
 * Deliberately unlabelled on the second half: "9 back" is what a person says
 * out loud, and the first clause has already established that we are counting
 * messages. The reply count is dropped entirely when it is zero, which is what
 * a daemon that does not emit `k: "reply"` reports — an absent clause invites
 * no conclusion, where "0 back" would assert one that is false.
 */
export function messageClause(sent: number, received: number): string {
  return received > 0 ? `you ${sent} · ${received} back` : `you ${sent}`
}
