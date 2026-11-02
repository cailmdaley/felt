import type { KanbanCard } from './KanbanTypes.js'
import { appConversationTarget, canOpenDesktopApp, claudeAppRoute, claudeWebLink } from './conversationLinks.js'
import { coarsePointer } from './mobile.js'

/** Opening belongs to this browser; execution belongs to the worker's host. */
export type ConversationOpening = 'terminal' | 'browser' | 'app' | 'chatgpt' | 'rex'
/** Rex opens its session list; the client has no known conversation-specific route. */
export const REX_APP_HREF = 'rex://'
export const CLAUDE_OPENING_KEY = 'shuttle.claude-opening'
export const CONVERSATION_OPENING_CHANGED = 'shuttle-conversation-opening-changed'

export function conversationOpening(): ConversationOpening {
  try {
    const value = globalThis.localStorage?.getItem(CLAUDE_OPENING_KEY)
    if (value === 'browser' || value === 'app' || value === 'chatgpt' || value === 'rex') return value
  } catch { /* Site storage may be disabled. */ }
  return 'terminal'
}

/** Return false when this browser cannot retain the preference. */
export function saveConversationOpening(value: ConversationOpening): boolean {
  try {
    globalThis.localStorage.setItem(CLAUDE_OPENING_KEY, value)
    window.dispatchEvent(new Event(CONVERSATION_OPENING_CHANGED))
    return true
  } catch {
    return false
  }
}

export interface ConversationDevice { desktop: boolean; userAgent: string; coarse: boolean }
export function conversationDevice(): ConversationDevice {
  const coarse = coarsePointer()
  const userAgent = navigator.userAgent
  return { desktop: canOpenDesktopApp(userAgent, coarse), userAgent, coarse }
}

export type ConversationDestination = { id: ConversationOpening; label: string; title?: string } & (
  | { href: string; run?: never }
  | { run: () => void; href?: never }
)
export type ConversationWorker = Pick<KanbanCard, 'tmuxSession' | 'sessionLink' | 'terminalBackend' | 'workerSurface' | 'shuttleSurface' | 'sessionUuid' | 'desktopLink' | 'shuttleHost' | 'shuttleProjectDir' | 'launchError'>
export type WorkerOpener = (session: string, host?: string) => void

/** Every usable destination, best first. An unavailable preference never changes this order. */
export function conversationDestinations(card: ConversationWorker, device: ConversationDevice, openWorker?: WorkerOpener): ConversationDestination[] {
  if ((card.workerSurface ?? card.shuttleSurface) === 'app') {
    if (!card.sessionUuid) return []
    const target = appConversationTarget(card, device.desktop, device.userAgent, device.coarse)
    return [{ id: 'chatgpt', label: 'ChatGPT', href: target.href, title: target.title }]
  }
  const destinations: ConversationDestination[] = []
  if (device.desktop && card.tmuxSession && openWorker) {
    const session = card.tmuxSession
    destinations.push({ id: 'terminal', label: card.terminalBackend === 'rex' ? 'Rex' : 'Terminal', run: () => openWorker(session, card.shuttleHost) })
  }
  if (!device.desktop && card.tmuxSession && card.terminalBackend === 'rex') {
    destinations.push({ id: 'rex', label: 'Rex', href: REX_APP_HREF, title: 'Open Rex, then choose this constitution family’s session.' })
  }
  const web = claudeWebLink(card.sessionLink)
  if (web) {
    destinations.push({ id: 'browser', label: 'Claude browser', href: web })
    const app = device.desktop ? claudeAppRoute(web) : undefined
    if (app) destinations.push({ id: 'app', label: 'Claude app', href: app })
  }
  return destinations
}

export function resolveDestination<T extends { id: ConversationOpening }>(destinations: readonly T[], remembered = conversationOpening()): T | undefined {
  return destinations.find(destination => destination.id === remembered) ?? destinations[0]
}

/** Use a native anchor so app schemes and browser links retain their normal gesture semantics. */
export function openDestination(destination: ConversationDestination): void {
  if (destination.run) { destination.run(); return }
  const link = document.createElement('a')
  link.href = destination.href
  if (destination.href.startsWith('https:')) { link.target = '_blank'; link.rel = 'noopener noreferrer' }
  link.click()
}

export const REMOTE_CONTROL_REQUIRED = 'No Claude Remote Control link is available. Enable Remote Control in this Claude session to open it in the browser or app.'
