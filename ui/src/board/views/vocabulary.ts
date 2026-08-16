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
 *   ✗ composted        closed and let go
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
  | 'composted'

export const STATE_GLYPH: Record<LifecycleState, string> = {
  draft: '◇',
  inFlight: '▶',
  awaitingReview: '◦',
  resting: '⏾',
  tempered: '✓',
  composted: '✗',
}

/** What each state is called out loud — the title, the aria text, the key. */
export const STATE_WORD: Record<LifecycleState, string> = {
  draft: 'draft',
  inFlight: 'in flight',
  awaitingReview: 'awaiting review',
  resting: 'resting',
  tempered: 'tempered',
  composted: 'composted',
}

/** The key's order: the life of a fiber, start to end. */
export const STATE_KEY_ITEMS: LifecycleState[] = [
  'draft',
  'inFlight',
  'resting',
  'awaitingReview',
  'tempered',
  'composted',
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
    if (card.tempered === false) return 'composted'
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

// ── The activity key ─────────────────────────────────────────────────────────

/**
 * What the activity curve's ink means, in words. One phrasing across the board:
 * Day and Week both draw the same curve and read from this list, so the same
 * mark is never glossed two ways.
 *
 * ONE ENTRY, because the curve is one claim: this is the machines' volume. It
 * used to be two — a colour scale walking from the agents' cobalt to a teal
 * that read your engagement — and the second pole is gone with the channel.
 * Your half of the day is the spine ({@link SPINE_KEY_LABEL}), which says the
 * same thing without asking a hue to carry it.
 *
 * The wire's kind `notify` is not here and draws nothing anywhere. A notify is
 * an idle nudge, not a state of the work; an agent truly blocked on you shows
 * as the DIP on a live lane, which no pigment improves on.
 */
export const ACTIVITY_KEY_ITEMS: Array<{ kind: DrawnKind; label: string }> = [
  { kind: 'agent', label: 'agents working' },
]

/**
 * A KEY THAT NEEDS NO EXPLAINING is the test this line finally passes.
 *
 * It used to end "— fainter in a burst", a parenthesis apologising for a
 * falloff the reader had already noticed and correctly objected to: a message
 * in a burst is not a fainter fact than a message on its own. The falloff is
 * typographic now (`spineWidths` narrows the nib and never the strength), so
 * there is nothing left to apologise for and the label says the one thing it
 * has always meant.
 */
export const SPINE_KEY_LABEL = 'you'

/**
 * The curve's height: the machines' volume, minute by minute.
 *
 * IT WAS "agent tool calls", AND THAT WAS NOT WHAT THE MOUND MEASURES. The
 * curve is weighted by the activity plane's per-minute `n`, which counts
 * harness HOOK EVENTS — a tool call's two ends are two of them, a session start
 * is one, and a minute filled in between a long call's ends is one regardless.
 * Naming the wash after tool calls made the legend a claim the ink could not
 * support, and the same wrong noun was on the hover slip beside a list of the
 * actual calls, where the two could be read against each other and seen to
 * disagree. The wash says the agent was busy and how heavily; what it RAN is
 * the slip's tool section, which counts what it lists. Week's key has said
 * `agents working` all along; this is Day's, agreeing.
 */
export const MOUND_KEY_LABEL = 'agents working'

/** The third mark, and the only one about a SPAN rather than a moment: the
 *  session's line on the ground and one rung per agent it sent out, each
 *  spanning the interval it was actually up. */
export const ALOFT_KEY_LABEL = 'sessions and agents aloft'


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
