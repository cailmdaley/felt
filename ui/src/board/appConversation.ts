import { attachConversationPicker } from './conversationMenu.js'
import { age } from './civilDay.js'
import { conversationDestinations, conversationDevice, linkDestination, resolveDestination, REMOTE_CONTROL_REQUIRED, type ConversationWorker, type WorkerOpener } from './conversationOpening.js'
import type { KanbanCard } from './KanbanTypes.js'
import { turnOf, type TurnInput } from './turn.js'

/** The pill's hover title: the turn in full, and how long it has held. */
function turnTitle(card: TurnInput, nowMs = Date.now()): string {
  const { detail, since } = turnOf(card, nowMs)
  return since !== undefined && Number.isFinite(since) ? `${detail} (${age(nowMs - since)})` : detail
}

/** The worker's turn, opening the remembered destination or the best usable one. */
export function workerPill(
  card: TurnInput & ConversationWorker & Pick<KanbanCard, 'workerAgent' | 'shuttleAgent'>,
  options: { openWorker?: WorkerOpener } = {},
): HTMLElement {
  const destinations = (): ReturnType<typeof conversationDestinations> => conversationDestinations(card, conversationDevice(), options.openWorker)
  const destination = resolveDestination(destinations())
  const pill = document.createElement(destination?.href ? 'a' : destination ? 'button' : 'span')
  pill.className = 'kbn-card-worker'
  pill.textContent = turnOf(card).word
  const state = turnTitle(card)
  if (!destination) {
    const claude = (card.workerAgent ?? card.shuttleAgent ?? '').startsWith('claude-')
    pill.title = `${state}${claude ? `\n${REMOTE_CONTROL_REQUIRED}` : ''}`
    return pill
  }
  const label = `Open in ${destination.label}`
  pill.title = `${state} — ${destination.title ?? label}\nLong-press or right-click to choose where to open.`
  pill.setAttribute('aria-label', `${pill.textContent}. ${label}`)
  if (pill instanceof HTMLAnchorElement) linkDestination(pill, destination.href!)
  else if (pill instanceof HTMLButtonElement) pill.type = 'button'
  pill.addEventListener('click', event => { event.stopPropagation(); destination.run?.() })
  attachConversationPicker(pill, destinations)
  return pill
}
