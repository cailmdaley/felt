/**
 * The Chronicle's words and marks — its glyphs, state names and figures.
 *
 * Kept apart from the view so the vocabulary is pure and testable: a glyph
 * spent on one meaning cannot come to mean something else, and the same
 * pigment is never explained two ways. The shapes behind the marks are the
 * view's CSS.
 */

// ── Obligations ──────────────────────────────────────────────────────────────

/**
 * What a row draws for work that is owed but not yet done.
 *
 *   ◴ due      a card whose `due:` names this civil day
 *   ◐ launch   a standing role's next firing, an instant
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
 * This is the Desk's column vocabulary seen from the side: the same six
 * answers `classifyFiber` gives, minus the surface question of which strip a
 * card lands on. `resting` folds three ways of being off the desk — snoozed
 * (`horizon:stashed`), a pinned role at rest, an armed standing role between
 * firings — because from a row on the chronicle they are one claim: nothing is
 * owed here now, and it comes back on its own.
 *
 *   ◇ draft            written, not armed
 *   ▶ in flight        a worker is running, or the fiber is armed to run
 *   ◦ awaiting review  closed, no verdict yet
 *   ⏾ resting          snoozed, pinned at rest, or waiting on its cron
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

/** The fields a card must carry for its state to be readable. `KanbanCard`
 *  satisfies this; the shape is structural so the shared vocabulary keeps
 *  owning no view or wire types. */
export interface StateBearing {
  status: string
  tempered?: boolean
  runningWorker?: string
  shuttleKind?: 'oneshot' | 'standing' | 'pinned'
  effectiveHorizon?: 'now' | 'stashed'
}

/**
 * A card's lifecycle state, in `classifyFiber`'s branch order.
 *
 * Closed is asked FIRST and unconditionally: a fiber that ended still carries
 * whatever `shuttle:` block ran it, and reading the block first would show a
 * finished fiber as in flight forever. After that a live worker outranks
 * everything — a running pinned or snoozed fiber is running, whatever it does
 * between workers.
 */
export function cardState(card: StateBearing): LifecycleState {
  if (card.status === 'closed') {
    if (card.tempered === true) return 'tempered'
    if (card.tempered === false) return 'discarded'
    return 'awaitingReview'
  }
  if (card.runningWorker) return 'inFlight'
  if (card.effectiveHorizon === 'stashed') return 'resting'
  if (card.shuttleKind === 'pinned') return 'resting'
  if (card.status === 'active') {
    // An armed standing role fires on its own cron; nothing is owed until it
    // does. Only a one-shot that is `active` is genuinely underway.
    return card.shuttleKind === 'standing' ? 'resting' : 'inFlight'
  }
  return 'draft'
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
