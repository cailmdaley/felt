/**
 * The Chronicle's words and marks — its glyphs, state names and figures.
 *
 * Kept apart from the view so the vocabulary is pure and testable: a glyph
 * spent on one meaning cannot come to mean something else, and the same
 * pigment is never explained two ways. The shapes behind the marks are the
 * view's CSS.
 */

import type { DeskColumn } from '../KanbanTypes.js'

// ── Obligations ──────────────────────────────────────────────────────────────

/**
 * What a row draws for work that is owed but not yet done.
 *
 *   ◴ due      a card whose `due:` names this civil day
 *   ◐ launch   a standing constitution's next firing, an instant
 *
 * NOT closure (✓ tempered · ✗ discarded · ◦ awaiting a verdict) and not the
 * Kanban card-kind glyphs. Those are different claims that happen to share ink.
 */
type MarkKind = 'due' | 'launch'

export const MARK_GLYPH: Record<MarkKind, string> = { due: '◴', launch: '◐' }

// ── Lifecycle state ──────────────────────────────────────────────────────────

/**
 * Where a fiber stands in its life, as the temporal views need to say it.
 *
 * This is the card's served Desk column seen from the side. `resting` folds
 * the columns that owe the human nothing — Resting (put down, or a standing
 * constitution between firings or with its schedule paused), the Roles, and
 * a closed thread with its orchestrator for review — because from a row on
 * the chronicle they are one claim: nothing is owed here now.
 *
 *   ◇ draft            written, not armed
 *   ▶ in flight        a worker is running, or the fiber is armed to run
 *   ◦ awaiting review  closed, no verdict yet
 *   ⏾ resting          put down, waiting on its cron, or its schedule paused
 *   ✓ tempered         closed and kept
 *   ✗ discarded        closed and let go
 *
 * ✓ · ✗ · ◦ are deliberately the marks Chronicle already ends a lifeline with,
 * and the glyphs here are disjoint from `MARK_GLYPH` — a state is a standing
 * condition, an obligation is a thing owed on a day, and one page draws both.
 */
export type LifecycleState =
  | 'draft'
  | 'inFlight'
  | 'awaitingReview'
  | 'resting'
  | 'tempered'
  | 'discarded'

export const STATE_GLYPH: Record<LifecycleState, string> = {
  draft: '◇',
  inFlight: '▶',
  awaitingReview: '◦',
  resting: '⏾',
  tempered: '✓',
  discarded: '✗',
}

/** What each state is called out loud — the title, the aria text, the key. */
export const STATE_WORD: Record<LifecycleState, string> = {
  draft: 'draft',
  inFlight: 'in flight',
  awaitingReview: 'awaiting review',
  resting: 'resting',
  tempered: 'tempered',
  discarded: 'discarded',
}

/** The key's order: the life of a fiber, start to end. */
export const STATE_KEY_ITEMS: LifecycleState[] = [
  'draft',
  'inFlight',
  'resting',
  'awaitingReview',
  'tempered',
  'discarded',
]

const COLUMN_STATE: Record<DeskColumn, LifecycleState> = {
  drafts: 'draft',
  inFlight: 'inFlight',
  awaitingReview: 'awaitingReview',
  orchestratorReview: 'resting',
  resting: 'resting',
  roles: 'resting',
  tempered: 'tempered',
  composted: 'discarded',
}

/** A card's lifecycle state, from its served column. */
export function cardState(card: { column: DeskColumn }): LifecycleState {
  return COLUMN_STATE[card.column]
}

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


// ── Line-count accounting ────────────────────────────────────────────────────

/**
 * `+512 −208` — the diffstat convention, insertions first, and a true minus
 * sign (U+2212) rather than a hyphen: the figure is an arithmetic quantity and
 * the page sets it as one.
 *
 * Either side may be zero on its own (a pure deletion adds nothing) and each
 * is dropped independently; both zero prints NOTHING, which is the difference
 * between "the ledger recorded no change here" and the false precision of
 * `+0 −0`. Every caller must treat the empty string as "print no clause".
 *
 * Figures stay exact at every size. A line count is a fact a reader may want
 * to compare against `git show`, and `+1.2k` is not that fact.
 */
export function diffClause(insertions: number, deletions: number): string {
  const terms: string[] = []
  if (insertions > 0) terms.push(`+${insertions}`)
  if (deletions > 0) terms.push(`−${deletions}`)
  return terms.join(' ')
}

/**
 * Same figure as {@link diffClause}, as an element rather than a string: an
 * insertion in `--kbn-diff-add` (a muted diffstat green — new to the board's
 * pigments, because LOC accounting is its own axis, not a repaint of WHO
 * ACTED or the VERDICT), a deletion in `--kbn-diff-del`. Null on the same
 * both-zero case `diffClause` renders as `''` — callers that already guard on
 * the string form should guard on this the same way.
 */
export function diffClauseEl(insertions: number, deletions: number): HTMLElement | null {
  const ins = insertions > 0 ? `+${insertions}` : ''
  const del = deletions > 0 ? `−${deletions}` : ''
  if (!ins && !del) return null
  const el = document.createElement('span')
  el.className = 'kbn-diffclause'
  if (ins) {
    const insEl = document.createElement('span')
    insEl.className = 'kbn-diffclause-ins'
    insEl.textContent = ins
    el.append(insEl)
  }
  if (ins && del) el.append(document.createTextNode(' '))
  if (del) {
    const delEl = document.createElement('span')
    delEl.className = 'kbn-diffclause-del'
    delEl.textContent = del
    el.append(delEl)
  }
  return el
}

/** What one page's worth of ledger came to. */
export interface DiffTotal {
  insertions: number
  deletions: number
}

/**
 * Add up what the ledger RECORDED — nothing inferred, nothing assumed.
 *
 * The caller hands in only the entries the join actually resolved onto a fiber
 * in its window; a commit the ledger cannot attribute is not this total's to
 * count. Summing an empty run gives zeros, which {@link diffClause} then prints
 * as nothing at all.
 */
export function sumDiff(entries: Iterable<DiffTotal>): DiffTotal {
  let insertions = 0
  let deletions = 0
  for (const entry of entries) {
    insertions += entry.insertions
    deletions += entry.deletions
  }
  return { insertions, deletions }
}
