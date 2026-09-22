import { coarsePointer } from './mobile.js'
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
  link.className = `kbn-card-worker kbn-card-worker-link ${classes}`.trim()
  link.textContent = workerStatusLabel(variant === 'aloft' ? undefined : card.runtimePhase, card.launchError)
  link.href = target.href
  link.title = `${card.runtimePhase ?? 'Aloft'} — ${target.title}`
  link.setAttribute('aria-label', target.ariaLabel)
  link.addEventListener('click', event => event.stopPropagation())
  return link
}
