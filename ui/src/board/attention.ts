import type { Wait } from './boardFeed.js'
import { dueCivilDay, formatCivilDay, formatInstant, instantMs } from './civilDay.js'
import { hasLiveWorker, type KanbanCard } from './KanbanTypes.js'
import { threadState } from './threads.js'
import { turnOf } from './turn.js'

/**
 * A constitution's state, the one every surface draws.
 *
 *   waiting — something addressed to the human waits on them: a line the
 *             board says nothing has handled (a post, a question or a close
 *             to them), an open ask, a worker stopped on a harness prompt, a
 *             turn that could not start, or a close for their review.
 *   working — a live worker, whatever its turn: an idle worker that asked
 *             nothing is still working, not waiting.
 *   quiet   — everything else: drafts, rest, seats, held launches, closes
 *             its orchestrator reviews, verdicts.
 */
export type Attention = 'waiting' | 'working' | 'quiet'

/** What waits on the human, by fiber uid: the board's answer ({@link BoardFeed.waiting}). */
export type Waits = ReadonlyMap<string, Wait>

/** What a waiting constitution wants of the human, in one short line, and since when. */
export interface Want {
  kind: 'ask' | 'review' | 'post' | 'blocked'
  text: string
  /** When it began waiting, epoch ms; 1 when the time is unknown. */
  at: number
  /** The board line it waits with, when it waits with one. */
  line?: Wait
}

/** The first of `values` that names a real instant, else 0. */
const instant = (...values: Array<string | number | undefined>): number =>
  values.map(value => typeof value === 'number' ? value : Date.parse(value ?? '')).find(value => Number.isFinite(value) && value > 0) ?? 0

const fiber = (card: KanbanCard): string => card.uid ?? card.id
const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

/**
 * What a constitution wants of the human, or null when nothing of it waits
 * on them. A verdict settles everything. Its open ask comes first, then a
 * turn that could not start, then the board's line, then a harness prompt,
 * then a close for review.
 */
export function wantOf(card: KanbanCard, waits: Waits): Want | null {
  if (archived(card)) return null
  const line = waits.get(fiber(card))
  const turn = turnOf(card)
  const review = (): Want => ({ kind: 'review', text: card.reviewMark?.note?.trim() || 'for review', at: line?.at ?? (instant(card.closedAt, card.reviewMark?.at, card.modifiedAt, card.createdAt) || 1), line })
  if (card.status === 'active' && card.ask) {
    return { kind: 'ask', text: card.ask.text, at: instant(card.ask.at) || line?.at || instant(card.lastActivityAt, card.dispatchedAt, card.modifiedAt) || 1, line }
  }
  if (turn.turn === 'blocked') {
    return { kind: 'blocked', text: card.launchError ?? (card.runtimePhase === 'identity_failed' ? 'its session could not be identified' : 'could not start its turn'), at: instant(card.lastActivityAt, card.modifiedAt) || 1 }
  }
  if (line?.kind === 'closed' || (line && !line.kind && threadState(card) === 'to-review')) return review()
  if (line) return { kind: line.kind === 'asked' ? 'ask' : 'post', text: line.text?.trim() || (line.kind === 'asked' ? 'asks' : 'posted'), at: line.at, line }
  if (turn.turn === 'question') return { kind: 'ask', text: 'stopped on a prompt', at: turn.since ?? (instant(card.lastActivityAt) || 1) }
  if (threadState(card) === 'to-review') return review()
  return null
}

/** The one state of a constitution (see {@link Attention}). */
export function attentionOf(card: KanbanCard, waits: Waits): Attention {
  if (wantOf(card, waits)) return 'waiting'
  return hasLiveWorker(card) ? 'working' : 'quiet'
}

/** Waiting, then working, then quiet. */
export const ATTENTION_ORDER: readonly Attention[] = ['waiting', 'working', 'quiet']

/** When a card last moved: its worker's latest event or its file's last write. */
export const lastActive = (card: KanbanCard): number =>
  Math.max(instant(card.lastActivityAt), instant(card.modifiedAt)) || instant(card.closedAt, card.createdAt)

/**
 * A quiet constitution's faint word, or '' when it has none: a draft, a held
 * launch, a seat, a standing one's next run or its paused schedule, or a
 * rest with its return day.
 */
export function quietWord(card: KanbanCard): string {
  if (card.column === 'drafts') return card.held ? 'held' : 'draft'
  if (card.held) return 'held'
  if (card.column === 'roles') return 'seat'
  if (card.shuttleKind === 'standing' && card.column === 'resting') {
    if (card.status === 'open') return 'paused'
    const next = instantMs(card.nextLaunchAt)
    return next === undefined ? '↻' : `↻ ${formatInstant(next, { month: 'short', day: 'numeric' })}`
  }
  if (card.column === 'resting') {
    const until = formatCivilDay(dueCivilDay(card.due), { month: 'short', day: 'numeric' })
    return until ? `resting until ${until}` : 'resting'
  }
  return ''
}
