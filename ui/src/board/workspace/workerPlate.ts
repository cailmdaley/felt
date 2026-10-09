import { workerVariant } from '../appConversation.js'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { humanizeIdleAge } from '../utils.js'

/**
 * What the worker pill says, on every surface: the state word and a compact
 * age. Aloft counts from the launch (runtime's instant wins over the fiber's
 * durable dispatch stamp); waiting and attention count from the last activity,
 * so the figure is how long the worker has waited on you.
 */
export function workerPlateFacts(card: KanbanCard, now = Date.now(), phase = true): { state: string; elapsed?: string; working: boolean } {
  if (!hasLiveWorker(card)) return { state: 'no worker', working: false }
  const variant = phase ? workerVariant(card, now) : 'aloft'
  const state = variant === 'attention' ? card.workerState === 'blocked' || card.runtimePhase === 'blocked' || card.launchError ? 'blocked' : 'attention' : variant
  const since = variant === 'aloft' ? card.workerStartedAt ?? Date.parse(card.dispatchedAt ?? '') : card.lastActivityAt
  const elapsed = since !== undefined && Number.isFinite(since) ? humanizeIdleAge(now - since) : undefined
  // The owner reports working for foreground and detached work alike. Unknown,
  // waiting (even within the pill's debounce) and attention never breathe.
  return { state, elapsed, working: card.workerState === 'running' && card.runtimePhase === 'working' }
}

/** The plate's word for a state whose data name is not what the reader is told. */
const PLATE_WORDS: Record<string, string> = { attention: 'at a prompt', waiting: 'your turn' }

/**
 * Decorate the real conversation target, never a second opening mechanism:
 * a dot in the state's pigment, the state word, and the age. A fallback route
 * the builder named after a middot ("· browser") stays as a quiet suffix.
 */
export function workerPlate(card: KanbanCard, target: HTMLElement | null, phase = true): HTMLElement {
  const facts = workerPlateFacts(card, Date.now(), phase)
  const plate = target ?? document.createElement('span')
  const via = plate.querySelector('.ws-worker-via')?.textContent ?? plate.textContent?.match(/ · (.+)$/)?.[1]
  plate.classList.add('ws-worker-control')
  plate.classList.toggle('ws-turn-active', facts.working)
  plate.dataset.workerState = facts.state
  const part = (cls: string, text = ''): HTMLElement => {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    return span
  }
  // The dot is the plate's first item, so it centres on the capitals beside it and stands alone where the words are hidden.
  const dot = part('ws-worker-dot')
  dot.setAttribute('aria-hidden', 'true')
  plate.replaceChildren(dot, part('ws-worker-state', PLATE_WORDS[facts.state] ?? facts.state), part('ws-worker-elapsed', facts.elapsed ?? ''), ...(via ? [part('ws-worker-via', via)] : []))
  return plate
}
