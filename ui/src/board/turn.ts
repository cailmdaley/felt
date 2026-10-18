import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'

/**
 * Whose move a card is, and why: the one derivation every surface reads.
 *
 * The In flight band, the order within it, the worker pill's word, pigment and
 * age, the reader's sidebar groups and the dock's control all come from
 * `turnOf`, so no two of them can tell a different story about one card.
 *
 * Two questions are kept apart. The TURN says whose move it is; `busy` says
 * whether the worker is doing something right now. They are independent: a
 * worker that raised a non-blocking `shuttle ask` keeps working, and it is
 * still the human's move to answer. The pill's word names the turn, and its
 * dot breathes while the worker is busy.
 *
 * Each turn has one word, the same on every surface (`TURN_WORD`).
 *
 * The human's move:
 *   question  — the worker needs an answer: an outstanding `shuttle ask` (the
 *               worker may still be busy) or a harness stopped on a prompt
 *               (`attention`), which cannot continue until someone answers.
 *   blocked   — the turn could not start (`blocked`, a launch error) or the
 *               session could not be attributed (`identity_failed`); a human
 *               has to repair it. Rare, and drawn quietly.
 *   idle      — the worker ended its turn with nothing running under it
 *               (`waiting`).
 * The worker's move:
 *   working   — mid-turn, or idle over background work it started.
 *   starting  — a live worker that has not reported yet: launched within the
 *               last five minutes, or its session still being identified.
 *   no-signal — a live worker past its start with no hook event, or whose
 *               owning daemon is unreachable (its frozen runtime is no
 *               evidence), so its turn is unknown.
 *   none      — no live worker and nothing asked of the human.
 */
export type Turn = 'question' | 'blocked' | 'idle' | 'working' | 'starting' | 'no-signal' | 'none'

/** Each turn's word on the worker pill. */
export const TURN_WORD: Readonly<Record<Turn, string>> = {
  question: 'question',
  blocked: 'blocked',
  idle: 'idle',
  working: 'working',
  starting: 'starting',
  'no-signal': 'no signal',
  none: 'no worker',
}

/** The turns that are the human's move. */
const YOURS: readonly Turn[] = ['question', 'blocked', 'idle']

export interface TurnState {
  turn: Turn
  /** True when the turn is the human's move. */
  yours: boolean
  /** The worker is doing something now (its dot breathes), whatever the turn. */
  busy: boolean
  /** The pill's word for this turn: `TURN_WORD[turn]`. */
  word: string
  /** One sentence for the pill's title: the state, in full. */
  detail: string
  /** When this turn began, epoch ms; the pill shows its age. */
  since?: number
}

/** A worker that has been working this long without a hook event says so. */
export const SILENCE_FLOOR_MS = 10 * 60_000
/** A worker with no signal this soon after launch is still starting. */
const STARTING_MS = 5 * 60_000

function instant(value: string | undefined): number | undefined {
  const ms = value ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * The card's turn. An `ask` counts only on an active card, the one place the
 * card draws it; a closed card's leftover ask is nobody's move.
 */
export function turnOf(
  card: Pick<KanbanCard, 'status' | 'ask' | 'workerState' | 'runtimePhase' | 'launchError' | 'lastActivityAt' | 'workerStartedAt' | 'dispatchedAt' | 'originStale'>,
  nowMs: number = Date.now(),
): TurnState {
  const phase = card.runtimePhase
  const live = hasLiveWorker(card)
  const busy = !card.originStale && card.workerState === 'running' && phase === 'working'
  const ask = card.status === 'active' ? card.ask : undefined
  const state = (turn: Turn, detail: string, since?: number): TurnState =>
    ({ turn, yours: YOURS.includes(turn), busy, word: TURN_WORD[turn], detail, since })

  // An unreachable owner's runtime is frozen at its last poll: no evidence of
  // a turn. The ask lives in the synced fiber, so it is still owed.
  if (card.originStale) {
    if (ask) return state('question', `The worker asked: ${ask.text}`, instant(ask.at))
    if (live) {
      return state('no-signal', 'The worker\'s host is unreachable; its last reported state is frozen, so the turn is unknown.', instant(card.originStale.since))
    }
  }
  if (card.launchError || phase === 'blocked' || card.workerState === 'blocked') {
    return state('blocked', card.launchError ?? 'The worker could not start its turn.', card.lastActivityAt)
  }
  // Without a live worker a phase is stale; only an ask is still owed.
  if (!live) {
    return ask ? state('question', `The worker asked: ${ask.text}`, instant(ask.at)) : state('none', 'No live worker.')
  }
  if (phase === 'identity_failed') {
    return state('blocked', 'Session attribution failed, so the turn is unknown. Shuttle keeps retrying; an explicit session claim repairs it.', card.lastActivityAt)
  }
  if (phase === 'attention') {
    return state('question', ask
      ? `The worker is stopped on a harness prompt and needs an answer to continue. It also asked: ${ask.text}`
      : 'The worker is stopped on a harness prompt and needs an answer to continue.', card.lastActivityAt)
  }
  if (ask) {
    return state('question', busy
      ? `The worker asked: ${ask.text} — and is still working.`
      : `The worker asked: ${ask.text}`, instant(ask.at))
  }
  if (phase === 'waiting') {
    return state('idle', 'The worker ended its turn with nothing running under it.', card.lastActivityAt)
  }
  if (phase === 'working') {
    const silent = card.lastActivityAt !== undefined && nowMs - card.lastActivityAt >= SILENCE_FLOOR_MS
    return state('working', silent
      ? 'The worker is mid-turn or over background work, with no hook event since.'
      : 'The worker is mid-turn or over background work it started.', silent ? card.lastActivityAt : undefined)
  }
  const started = card.workerStartedAt ?? instant(card.dispatchedAt)
  if (phase === 'identity_pending') {
    return state('starting', 'The worker is live; Shuttle is acquiring its session before it can report the turn.', started)
  }
  return started !== undefined && nowMs - started < STARTING_MS
    ? state('starting', 'The worker is starting; no hook event yet.', started)
    : state('no-signal', 'The worker is live, but the daemon holds no hook event for its session, so its turn is unknown.', started)
}
