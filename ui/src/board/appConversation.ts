import { addConversationMenu, conversationActions } from './conversationMenu'
import { coarsePointer } from './mobile.js'
import { humanizeIdleAge } from './utils.js'
import { claudeAppRoute, claudeWebLink } from './sessionHistory.js'
import { effectiveClaudeOpening, REMOTE_CONTROL_REQUIRED, CLAUDE_APP_ROUTE_UNAVAILABLE } from './conversationOpening.js'
import type { KanbanCard } from './KanbanTypes.js'
import { turnOf } from './turn.js'

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

/** The pill's hover title: the turn in full, and how long it has held. */
export function turnTitle(card: TurnInput, nowMs = Date.now()): string {
  const { detail, since } = turnOf(card, nowMs)
  return since !== undefined && Number.isFinite(since) ? `${detail} (${humanizeIdleAge(nowMs - since)})` : detail
}

type TurnInput = Pick<KanbanCard, 'status' | 'ask' | 'workerState' | 'runtimePhase' | 'launchError' | 'lastActivityAt' | 'workerStartedAt' | 'dispatchedAt'>

/** An app worker's pill: the turn's word, linking into the conversation backend. */
export function appWorkerLink(card: KanbanCard): HTMLAnchorElement {
  const coarse = coarsePointer()
  const target = appConversationTarget(card, canOpenDesktopApp(navigator.userAgent, coarse), navigator.userAgent, coarse)
  const link = document.createElement('a')
  link.className = 'kbn-card-worker'
  link.textContent = turnOf(card).word
  link.href = target.href
  link.title = `${turnTitle(card)} — ${target.title}`
  link.setAttribute('aria-label', target.ariaLabel)
  link.addEventListener('click', event => event.stopPropagation())
  return link
}

/**
 * A terminal worker's pill, shared by the Desk and the reader.
 *
 * Its word is the card's turn (`turnOf`) on every surface; the pill itself is
 * the action that opens the conversation. Desktop Claude opening follows this
 * browser's preference: Kitty, the Remote Control web link, or the installed
 * Claude app's session route. An unavailable Remote Control link is an
 * explicitly labelled terminal fallback. Other CLI harnesses open in Kitty.
 * Phones use a recorded Claude HTTPS link or a mark of the worker's state.
 * The touch stylesheet keys on the element, not on a class: a
 * `.kbn-card-worker` that is not a link takes no taps.
 */
export function terminalWorkerPill(
  card: TurnInput & Pick<KanbanCard, 'tmuxSession' | 'sessionLink' | 'shuttleHost' | 'workerAgent' | 'shuttleAgent'>,
  options: {
    openWorker?: (tmuxSessionName: string, shuttleHost?: string) => void
  } = {},
): HTMLElement {
  const tmuxName = card.tmuxSession ?? ''
  const classes = 'kbn-card-worker'
  const label = turnOf(card).word
  const state = turnTitle(card)

  const coarse = coarsePointer()
  const web = claudeWebLink(card.sessionLink)
  const desktop = canOpenDesktopApp(navigator.userAgent, coarse)
  const choice = effectiveClaudeOpening(desktop)
  const withMenu = (pill: HTMLElement): HTMLElement => addConversationMenu(pill, conversationActions(card.sessionLink, desktop, tmuxName && options.openWorker ? () => options.openWorker!(tmuxName, card.shuttleHost) : undefined))
  const claude = Boolean(web) || (card.workerAgent ?? card.shuttleAgent ?? '').startsWith('claude-')
  if (web && choice !== 'terminal') {
    const app = choice === 'app' ? claudeAppRoute(web) : undefined
    const browserFallback = choice === 'app' && !app
    const a = document.createElement('a')
    a.className = classes
    a.textContent = browserFallback ? `${label} · browser` : label
    a.href = app ?? web
    if (desktop && !app) {
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
    }
    a.title = `${browserFallback ? `${CLAUDE_APP_ROUTE_UNAVAILABLE}\n` : ''}${state} — open this session in ${app ? 'the Claude app' : 'Claude in the browser'}`
    a.setAttribute('aria-label', `Open worker session in ${app ? 'the Claude app' : 'Claude in the browser'}: ${tmuxName}`)
    a.addEventListener('click', (e) => e.stopPropagation())
    return withMenu(a)
  }
  if (!desktop || !options.openWorker) {
    const mark = document.createElement('span')
    mark.className = classes
    mark.textContent = label
    mark.title = `${state} — ${tmuxName}${claude && choice !== 'terminal' ? `\n${REMOTE_CONTROL_REQUIRED}` : ''}`
    return withMenu(mark)
  }
  const openWorker = options.openWorker
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = classes
  const fallback = claude && choice !== 'terminal' && !web
  btn.textContent = fallback ? `${label} · terminal` : label
  btn.setAttribute('aria-label', `Worker ${label} — open terminal: ${tmuxName}`)
  btn.title = `${fallback ? `${REMOTE_CONTROL_REQUIRED}\n` : ''}${state} — click to open ${tmuxName} in Kitty`
  btn.addEventListener('click', (e) => {
    e.stopPropagation()
    openWorker(tmuxName, card.shuttleHost)
  })
  return withMenu(btn)
}
