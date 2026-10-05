import { workerVariant } from '../appConversation.js'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'

/** Runtime's launch instant wins over a fiber's durable dispatch stamp. */
export function workerPlateFacts(card: KanbanCard, now = Date.now()): { state: string; elapsed?: string; working: boolean } {
  if (!hasLiveWorker(card)) return { state: 'no worker', working: false }
  const variant = workerVariant(card, now)
  const state = variant === 'attention' ? card.workerState === 'blocked' ? 'blocked' : 'attention' : variant
  const start = card.workerStartedAt ?? Date.parse(card.dispatchedAt ?? '')
  const minutes = Math.max(0, Math.floor((now - start) / 60000))
  const elapsed = Number.isFinite(start) ? minutes < 60 ? `${minutes} m` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} m` : ''}` : undefined
  // The owner reports working for foreground and detached work alike. Unknown,
  // waiting (even within the pill's debounce) and attention never breathe.
  return { state, elapsed, working: card.workerState === 'running' && card.runtimePhase === 'working' }
}

/** Decorate the real conversation target, never a second opening mechanism. */
export function workerPlate(card: KanbanCard, target: HTMLElement | null): HTMLElement {
  const facts = workerPlateFacts(card)
  const plate = target ?? document.createElement('span')
  plate.classList.add('ws-worker-control')
  plate.classList.toggle('ws-turn-active', facts.working)
  plate.dataset.workerState = facts.state
  const dot = document.createElement('span')
  dot.className = 'ws-worker-dot'
  dot.setAttribute('aria-hidden', 'true')
  const state = document.createElement('span')
  state.className = 'ws-worker-state'
  state.textContent = facts.state
  const elapsed = document.createElement('span')
  elapsed.className = 'ws-worker-elapsed'
  elapsed.textContent = facts.elapsed ?? ''
  plate.replaceChildren(dot, state, elapsed)
  return plate
}
