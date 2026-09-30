import { coarsePointer } from './mobile.js'
import { humanizeIdleAge } from './utils.js'
import type { KanbanCard } from './KanbanTypes.js'

const DESKTOP_THREAD_LINK = /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Only the native desktop thread route is accepted; no arbitrary app schemes. */
export function validDesktopThreadLink(value: unknown): string | undefined {
  return typeof value === 'string' && DESKTOP_THREAD_LINK.exec(value)?.[0] === value ? value : undefined
}

/** A desktop URL handler is not a phone universal link, even with a mouse attached. */
export function canOpenDesktopApp(userAgent: string, coarse: boolean): boolean {
  return !coarse && !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
}

/** The same test, named for what the card History asks: is the viewer at a
 *  desktop, where a kitty tab or a desktop app can be opened for them? */
export const atDesktop = canOpenDesktopApp

export function appConversationTarget(
  card: Pick<KanbanCard, 'desktopLink' | 'shuttleHost' | 'shuttleProjectDir' | 'launchError'>,
  desktop: boolean,
  userAgent = '',
  coarse = false,
): { href: string; title: string; guidance: string; conversationSpecific: boolean; ariaLabel: string } {
  const threadLink = desktop ? validDesktopThreadLink(card.desktopLink) : undefined
  const appleMobile = /iPhone|iPad|iPod/i.test(userAgent) || (coarse && /Macintosh/i.test(userAgent))
  // The iOS opener preserves the app's last screen; Safari may ask to open it.
  const href = threadLink ?? (appleMobile ? 'chatgpt://' : 'https://chatgpt.com/open-app')
  const project = card.shuttleProjectDir?.split(/[\\/]/).filter(Boolean).at(-1)
  const location = [card.shuttleHost, project].filter(Boolean).join(' → ')
  const guidance = `Continue in ChatGPT → Remote${location ? ` → ${location}` : ''}, then choose this conversation.`
  const title = threadLink
    ? `Open in the ChatGPT desktop app. If it does not select this host, use Remote${location ? ` → ${location}` : ''}.`
    : `Open ChatGPT. ${guidance}`
  return {
    href, title: card.launchError ? `${title}\n\n${card.launchError}` : title, guidance,
    conversationSpecific: Boolean(threadLink),
    ariaLabel: threadLink ? 'Open conversation in the ChatGPT desktop app' : 'Open ChatGPT app',
  }
}

export function workerStatusLabel(phase?: string, launchError?: string): string {
  if (launchError || phase === 'blocked') return 'Blocked'
  if (phase === 'attention') return 'Needs you'
  if (phase === 'waiting') return 'Waiting'
  return 'Aloft'
}

/** Idle waiting is debounced; explicit attention and failures are immediate. */
export function workerVariant(card: Pick<KanbanCard, 'runtimePhase' | 'lastActivityAt' | 'launchError'>, now = Date.now()): 'aloft' | 'waiting' | 'attention' {
  if (card.launchError || card.runtimePhase === 'attention' || card.runtimePhase === 'blocked') return 'attention'
  if (card.runtimePhase === 'waiting' && now - (card.lastActivityAt ?? -Infinity) >= 60_000) return 'waiting'
  return 'aloft'
}

export function appWorkerLink(card: KanbanCard, classes = ''): HTMLAnchorElement {
  const coarse = coarsePointer()
  const target = appConversationTarget(card, canOpenDesktopApp(navigator.userAgent, coarse), navigator.userAgent, coarse)
  const variant = workerVariant(card)
  const link = document.createElement('a')
  link.className = `kbn-card-worker ${classes}`.trim()
  link.textContent = workerStatusLabel(variant === 'aloft' ? undefined : card.runtimePhase, card.launchError)
  link.href = target.href
  link.title = `${card.runtimePhase ?? 'Aloft'} — ${target.title}`
  link.setAttribute('aria-label', target.ariaLabel)
  link.addEventListener('click', event => event.stopPropagation())
  return link
}

/**
 * A terminal worker's pill, one control on the Desk card and in the open card.
 *
 * At a desktop it is a button that opens the worker's tmux session in kitty.
 * A phone or tablet has no terminal to open, so under a finger it is a link to
 * the session in the Claude app when the owning daemon has stamped the bridge
 * address (`sessionLink`), and otherwise a mark of the worker's state. The
 * touch stylesheet keys on the element, not on a class: a `.kbn-card-worker`
 * that is not a link takes no taps. In the open card's header a link also gets
 * a 44px target band; a Desk card has no room for one.
 *
 * `phase` lets the waiting and attention states take the pill over (label,
 * colour, title); a card outside In flight passes false and stays "Aloft".
 */
export function terminalWorkerPill(
  card: Pick<KanbanCard, 'tmuxSession' | 'sessionLink' | 'runtimePhase' | 'lastActivityAt' | 'launchError' | 'shuttleHost'>,
  options: {
    classes?: string
    phase?: boolean
    openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  } = {},
): HTMLElement {
  const tmuxName = card.tmuxSession ?? ''
  const variant = options.phase === false ? 'aloft' : workerVariant(card)
  const takesOver = variant !== 'aloft' && !!card.runtimePhase
  const classes = `kbn-card-worker kbn-card-worker-${variant} ${options.classes ?? ''}`.trim()
  const label = workerStatusLabel(takesOver ? card.runtimePhase : undefined)
  const idleMs = card.lastActivityAt !== undefined ? Date.now() - card.lastActivityAt : Infinity
  const age = Number.isFinite(idleMs) ? ` ${humanizeIdleAge(idleMs)} ago` : ''
  const state = !takesOver
    ? 'Worker aloft'
    : card.runtimePhase === 'attention'
      ? `Worker raised its hand${age}`
      : `Worker paused on input${age}`

  const coarse = coarsePointer()
  if (coarse && card.sessionLink) {
    const a = document.createElement('a')
    a.className = classes
    a.textContent = label
    a.href = card.sessionLink
    a.title = `${state} — open this session in the Claude app`
    a.setAttribute('aria-label', `Open worker session in the Claude app: ${tmuxName}`)
    a.addEventListener('click', (e) => e.stopPropagation())
    return a
  }
  if (coarse || !options.openWorker) {
    const mark = document.createElement('span')
    mark.className = classes
    mark.textContent = label
    mark.title = `${state} — ${tmuxName}`
    return mark
  }
  const openWorker = options.openWorker
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = classes
  btn.textContent = label
  const aria = !takesOver
    ? 'Open worker terminal'
    : card.runtimePhase === 'attention' ? 'Worker needs you — open terminal' : 'Worker waiting for you — open terminal'
  btn.setAttribute('aria-label', `${aria}: ${tmuxName}`)
  btn.title = `${state} — click to open ${tmuxName} in kitty`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    openWorker(tmuxName, card.shuttleHost)
  })
  return btn
}
