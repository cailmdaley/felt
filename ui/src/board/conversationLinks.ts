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

const CLAUDE_SESSION = /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]+)$/

/** The Claude desktop route for a URL naming exactly one bridged session. */
export function claudeAppRoute(url: string): string | undefined {
  const match = CLAUDE_SESSION.exec(url)
  const id = match?.[0] === url ? match[1] : undefined
  return id ? `claude://claude.ai/code/${id}` : undefined
}

/** Only HTTPS links on Claude's exact origin can leave the board. */
export function claudeWebLink(url: string | null | undefined): string | undefined {
  if (!url || /\s/.test(url)) return undefined
  try {
    const parsed = new URL(url)
    return parsed.origin === 'https://claude.ai' && !parsed.username && !parsed.password ? url : undefined
  } catch { return undefined }
}
