/**
 * The session-name join vocabulary, shared by ChronicleView and DayView.
 *
 * Both temporal views resolve an activity bucket to a fiber the same way, so
 * the grammar for reading a `<slug>-<ULID>-shuttle` tmux name lives here rather
 * than in either view. Neither view reaches into the other.
 */

import type { KanbanCard } from '../KanbanTypes.js'

/**
 * A Crockford-base32 ULID embedded in a longer name. Shuttle's tmux sessions
 * are `<slug>-<ULID>-shuttle`, and the ULID is the one token in a session name
 * that identifies a fiber exactly.
 *
 * Case-INSENSITIVE and not anchored to the `-shuttle` suffix, deliberately.
 * An uppercase-only, suffix-anchored pattern misses a lowercased session name
 * and every session the dispatcher builds in another shape. Since `cwd` joins
 * nothing, the session name is the ONLY route from a bucket to a fiber: a miss
 * here does not merely mislabel the work, it costs the fiber its lane.
 */
const ULID_RE = /(?:^|[^0-9a-hjkmnp-tv-z])([0-7][0-9a-hjkmnp-tv-z]{25})(?![0-9a-hjkmnp-tv-z])/i

/** A ULID standing alone, already upper-cased — a card's `uid` as written. */
const BARE_ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/

/** The fiber ULID a session name carries, upper-cased, or null. */
export function sessionUlid(name: string | null | undefined): string | null {
  if (typeof name !== 'string' || !name) return null
  const m = ULID_RE.exec(name)
  return m ? m[1].toUpperCase() : null
}

/**
 * The human-readable half of a session name: the `-shuttle` suffix and the
 * ULID stripped. `bmodes-2d-01K…-shuttle` → `bmodes-2d`, and the legacy
 * leaf-only `morning-post-shuttle` → `morning-post`. The weaker join key —
 * a slug is a fiber's leaf name, not its identity — so it is consulted only
 * after the ULID misses, and only when it resolves to exactly one card.
 */
export function sessionSlug(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null
  let s = name.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/-shuttle$/, '')
  s = s.replace(/-[0-7][0-9a-hjkmnp-tv-z]{25}$/, '')
  return s || null
}

/** Every ULID a card can be recognized by — its own `uid`, plus any embedded
 *  in the ids and session names it carries. */
export function cardUlids(card: KanbanCard): string[] {
  const out = new Set<string>()
  const push = (value: string | null | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (BARE_ULID_RE.test(trimmed)) out.add(trimmed)
    const embedded = sessionUlid(value)
    if (embedded) out.add(embedded)
  }
  push(card.uid)
  push(card.id)
  push(card.shuttleFiberId)
  push(card.runningWorker)
  return [...out]
}

/** Path segments a card can be recognized by when no ULID is available. Short
 *  segments are dropped — a two-letter directory name is not evidence. */
export function cardPathSegments(card: KanbanCard): string[] {
  const out = new Set<string>()
  for (const segment of card.id.split('/')) {
    const s = segment.trim().toLowerCase()
    if (s.length >= 3) out.add(s)
  }
  return [...out]
}
