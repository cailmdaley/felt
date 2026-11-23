/**
 * Headless readings of the feed's rows: what a fiber's state is, what it is
 * doing, which verbs it offers, how fibers stand in families, and how a
 * stream of lines groups. No DOM and no zone: every time is an epoch ms.
 */
import { instantMs, relativeAge } from './civilDay.js'
import type { ShuttleAttention, ShuttleFamilyNode, ShuttleFiber, ShuttleOffer, ShuttlePostItem, ShuttleTurn } from './types.js'

export { relativeAge }

/** The first of `values` that names a real instant, else 0. */
const instant = (...values: Array<string | number | null | undefined>): number =>
  values.map(value => typeof value === 'number' ? value : instantMs(value) ?? NaN).find(value => Number.isFinite(value) && value > 0) ?? 0

const archived = (row: ShuttleFiber): boolean => row.column === 'tempered' || row.column === 'discarded'
const active = (row: ShuttleFiber): boolean => row.fiber.status === 'active'
const standing = (row: ShuttleFiber): boolean => row.fiber.shuttle?.kind === 'standing'

/** Whether the owner holds a live worker for the fiber. */
export const hasLiveWorker = (row: ShuttleFiber): boolean => !!row.runtime

/** The worker's open question, when the fiber is armed and asked one. */
export const askOf = (row: ShuttleFiber): { text: string; at: number } | undefined => {
  const ask = row.fiber.shuttle?.ask
  return active(row) && ask?.text?.trim() ? { text: ask.text.trim(), at: instant(ask.at) } : undefined
}

/** Why a fiber's turn could not start, when it could not. */
const blockedWhy = (row: ShuttleFiber): string | undefined =>
  row.turn === 'blocked' ? row.dispatch_error || row.runtime?.launch_error || 'could not start its turn' : undefined

/**
 * Whether something of the fiber waits on the human: an open question, a
 * worker stopped on a prompt, a turn that could not start, or a close for
 * the human's review. A verdict settles everything.
 */
export function isWaiting(row: ShuttleFiber): boolean {
  if (archived(row)) return false
  return !!askOf(row) || row.turn === 'question' || row.turn === 'blocked' || row.column === 'awaiting_review'
}

/** Whether a worker is live and nothing waits on the human. */
export const isWorking = (row: ShuttleFiber): boolean => !isWaiting(row) && hasLiveWorker(row)

/** The fiber's one state: waiting, working, or quiet. */
export function attentionOf(row: ShuttleFiber): ShuttleAttention {
  return isWaiting(row) ? 'waiting' : hasLiveWorker(row) ? 'working' : 'quiet'
}

/** Waiting, then working, then quiet. */
export const ATTENTION_ORDER: readonly ShuttleAttention[] = ['waiting', 'working', 'quiet']

/** When a fiber last moved: its worker's phase change, its launch, or its file's last write. */
export const lastActive = (row: ShuttleFiber): number =>
  Math.max(instant(row.runtime?.phase_since), instant(row.fiber.modified_at)) || instant(row.fiber.closed_at, row.fiber.created_at)

/** Each turn's word. */
export const TURN_WORD: Readonly<Record<ShuttleTurn, string>> = {
  question: 'question', blocked: 'blocked', idle: 'idle', working: 'working', starting: 'starting', 'no-signal': 'no signal', none: 'no worker',
}

/** A quiet fiber's faint word: a draft, a rest, a seat, a standing one between runs. */
function quietWord(row: ShuttleFiber): string {
  if (row.column === 'drafts') return row.held ? 'held' : 'draft'
  if (row.held) return 'held'
  if (standing(row) && (row.column === 'resting' || row.column === 'roles')) return row.fiber.status === 'open' ? 'paused' : '↻'
  if (row.column === 'roles') return 'seat'
  if (row.column === 'resting') return 'resting'
  if (row.column === 'tempered') return 'tempered'
  if (row.column === 'discarded') return 'discarded'
  return ''
}

/**
 * What a fiber is doing, in a line, and when that was said: what it asks of
 * the human; else why its turn could not start; else its outcome, timed by its
 * file's last write; else its faint word or its turn's word.
 */
export function doingOf(row: ShuttleFiber): { text: string; at: number } {
  const ask = askOf(row)
  if (ask) return { text: ask.text, at: ask.at || lastActive(row) }
  const blocked = blockedWhy(row)
  if (blocked) return { text: blocked, at: lastActive(row) }
  if (row.column === 'awaiting_review') {
    const note = row.fiber.shuttle?.review?.note?.trim()
    if (note) return { text: note, at: instant(row.fiber.shuttle?.review?.at, row.fiber.closed_at) || lastActive(row) }
  }
  const outcome = row.fiber.outcome?.replace(/\s+/g, ' ').trim()
  if (outcome) return { text: outcome, at: instant(row.fiber.modified_at) || lastActive(row) }
  const word = (attentionOf(row) === 'quiet' && quietWord(row)) || TURN_WORD[row.turn ?? 'none']
  return { text: word, at: instant(row.runtime?.started_at) || lastActive(row) }
}

const offer = (verb: ShuttleOffer['verb'], label: string, request?: ShuttleOffer['request'], destructive = false): ShuttleOffer =>
  ({ verb, label, ...(request ? { request } : {}), ...(destructive ? { destructive } : {}) })

/**
 * The verbs a fiber offers in its current state, most likely first: what a
 * close for review wants (temper, discard), what moves armed work on (close
 * for review, rest, or a standing one's pause), what brings rested or closed
 * work back, withdrawing an open question, and stopping a live worker.
 */
export function offersFor(row: ShuttleFiber): ShuttleOffer[] {
  const offers: ShuttleOffer[] = []
  const status = row.fiber.status
  switch (row.column) {
    case 'awaiting_review':
    case 'orchestrator_review':
      offers.push(offer('temper', 'Temper', { action: 'close', tempered: true }), offer('discard', 'Discard', { action: 'close', tempered: false }, true))
      offers.push(offer('reopen', 'Reopen', { action: 'reopen' }))
      break
    case 'in_flight':
      if (standing(row)) offers.push(offer('pause', 'Pause schedule', { action: 'pause' }))
      else offers.push(offer('review', 'Close for review', { action: 'close' }), offer('rest', 'Rest', { action: 'rest' }))
      offers.push(offer('temper', standing(row) ? 'Temper run' : 'Temper', { action: 'close', tempered: true }))
      offers.push(offer('discard', standing(row) ? 'Retire' : 'Discard', { action: 'close', tempered: false }, true))
      break
    case 'drafts':
      offers.push(offer('resume', 'Resume', { action: 'resume' }), offer('discard', 'Discard', { action: 'close', tempered: false }, true))
      break
    case 'resting':
      offers.push(offer('resume', standing(row) ? 'Resume schedule' : 'Resume', { action: 'resume' }), offer('discard', standing(row) ? 'Retire' : 'Discard', { action: 'close', tempered: false }, true))
      break
    case 'roles':
      offers.push(status === 'active' ? offer('rest', 'Rest', { action: 'rest' }) : offer('resume', 'Resume', { action: 'resume' }))
      break
    case 'tempered':
    case 'discarded':
      offers.push(offer('reopen', 'Reopen', { action: 'reopen' }))
      break
  }
  if (askOf(row)) offers.push(offer('ask-clear', 'Clear question', { action: 'ask-clear' }))
  if (hasLiveWorker(row)) offers.push(offer('kill', 'Stop worker', undefined, true))
  return offers
}

/** A row's identity among the feed's: its owner and its id. */
const keyOf = (origin: string, id: string): string => `${origin}\u0000${id}`

/**
 * Fibers as families: every root (a fiber with no orchestrator in the feed)
 * with the threads beneath it, nested by `orchestrator`, which names the
 * nearest ancestor constitution by id or uid. An orchestrator on the same
 * host is preferred; feed order is kept at every level.
 */
export function buildFamilyTree(rows: readonly ShuttleFiber[]): ShuttleFamilyNode[] {
  const nodes = rows.map(fiber => ({ fiber, children: [] as ShuttleFamilyNode[] }))
  const byKey = new Map<string, ShuttleFamilyNode>(), byId = new Map<string, ShuttleFamilyNode>()
  for (const node of nodes) {
    for (const id of [node.fiber.fiber.id, node.fiber.fiber.uid].filter((each): each is string => !!each)) {
      byKey.set(keyOf(node.fiber.origin, id), node)
      if (!byId.has(id)) byId.set(id, node)
    }
  }
  const roots: ShuttleFamilyNode[] = []
  for (const node of nodes) {
    const parentId = node.fiber.orchestrator
    const parent = parentId ? byKey.get(keyOf(node.fiber.origin, parentId)) ?? byId.get(parentId) : undefined
    if (parent && parent !== node && !descends(parent, node)) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** Whether `node` already stands somewhere beneath `ancestor`. */
function descends(node: ShuttleFamilyNode, ancestor: ShuttleFamilyNode): boolean {
  return ancestor.children.some(child => child === node || descends(node, child))
}

/** What a line asks of the human, when it asks anything: a question, a close, a block. A post or a send says nothing the stream does not. */
export function kindWord(item: Pick<ShuttlePostItem, 'kind' | 'fiber'>): string {
  if (item.kind === 'close') return item.fiber.column === 'awaiting_review' ? 'for review' : 'closed'
  return item.kind === 'ask' ? 'asks' : item.kind === 'blocked' ? 'blocked' : ''
}

/** Lines of one thread closer together than this group under one head. */
export const GROUP_MS = 5 * 60_000

/**
 * A stream of lines, oldest first, each marked `grouped` when it follows a
 * line of the same thread less than `windowMs` before it and asks nothing a
 * head would have to say.
 */
export function groupPosts(items: readonly ShuttlePostItem[], windowMs = GROUP_MS): Array<{ item: ShuttlePostItem; grouped: boolean }> {
  return items.map((item, index) => {
    const before = items[index - 1]
    const grouped = !!before && keyOf(before.fiber.origin, before.fiber.fiber.uid ?? before.fiber.fiber.id) === keyOf(item.fiber.origin, item.fiber.fiber.uid ?? item.fiber.fiber.id)
      && item.at - before.at >= 0 && item.at - before.at < windowMs && !kindWord(item)
    return { item, grouped }
  })
}

/** A fiber's slug: the last segment of its id. */
export const slugOf = (row: ShuttleFiber): string => row.fiber.slug || row.fiber.id.split('/').pop() || row.fiber.id

/** A fiber's office, when it holds one: `office` of `office/person`. */
export const roleOf = (row: ShuttleFiber): string => (row.fiber.shuttle?.role || row.fiber.role || '').split('/')[0]

/** The fiber's tapestry (or other companion page) on its owner, when the owner found one. */
export const tapestryPathOf = (row: ShuttleFiber): string | undefined => row.report_path || undefined

/** How a file previews, by its kind alone: a figure, a page, or a card. */
export type ShuttleFileKind = 'figure' | 'page' | 'card'

const FIGURE = /\.(png|jpe?g|gif|webp|svg|avif)$/i
const PAGE = /\.html?$/i

/** A file's preview kind by its name. */
export const fileKindOf = (path: string): ShuttleFileKind => FIGURE.test(path) ? 'figure' : PAGE.test(path) ? 'page' : 'card'
