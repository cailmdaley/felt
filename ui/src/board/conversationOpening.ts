import type { KanbanCard } from './KanbanTypes.js'
import { canOpenDesktopApp, claudeAppRoute, claudeWebLink } from './conversationLinks.js'
import { coarsePointer } from './mobile.js'

/** Opening belongs to this browser; execution belongs to the worker's host. */
export type ConversationOpening = 'terminal' | 'browser' | 'app' | 'rex'
export const CLAUDE_OPENING_KEY = 'shuttle.claude-opening'
export const CONVERSATION_OPENING_CHANGED = 'shuttle-conversation-opening-changed'

export function conversationOpening(): ConversationOpening {
  try {
    const value = globalThis.localStorage?.getItem(CLAUDE_OPENING_KEY)
    if (value === 'browser' || value === 'app' || value === 'rex') return value
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
export type ConversationWorker = Pick<KanbanCard, 'tmuxSession' | 'sessionLink' | 'terminalBackend' | 'rexSession' | 'shuttleHost' | 'launchError'>
export type WorkerOpener = (session: string, host?: string) => void
/** A thread's conversation, two ways: `open` is the explicit act, true if it had a destination; `reach` is a click's quiet move, true once Rex moved. */
export interface Conversations { open(card: KanbanCard): boolean; reach(card: KanbanCard): Promise<boolean> }

/** Every usable destination, best first. An unavailable preference never changes this order. */
export function conversationDestinations(card: ConversationWorker, device: ConversationDevice, openWorker?: WorkerOpener): ConversationDestination[] {
  const destinations: ConversationDestination[] = []
  if (device.desktop && card.tmuxSession && openWorker) {
    const session = card.tmuxSession
    destinations.push({ id: 'terminal', label: card.terminalBackend === 'rex' ? 'Rex' : 'Terminal', run: () => openWorker(session, card.shuttleHost) })
  }
  const web = claudeWebLink(card.sessionLink)
  if (web) {
    destinations.push({ id: 'browser', label: 'Claude browser', href: web })
    const app = device.desktop ? claudeAppRoute(web) : undefined
    if (app) destinations.push({ id: 'app', label: 'Claude app', href: app })
  }
  if (!device.desktop && (card.terminalBackend === 'rex' || card.rexSession)) destinations.push(rexPhone(card.rexSession))
  return destinations
}

/** Rex for iOS registers no URL scheme, so the phone opens it through a Shortcut named
 *  "Rex": it opens the app, then the Rex session whose name it is given, if any. */
export const REX_PHONE_SHORTCUT = 'shortcuts://run-shortcut?name=Rex'
function rexPhone(session?: string): ConversationDestination {
  const href = session ? `${REX_PHONE_SHORTCUT}&input=text&text=${encodeURIComponent(session)}` : REX_PHONE_SHORTCUT
  return { id: 'rex', label: 'Rex', title: session ? `Open ${session} in Rex (through the Shortcut named “Rex”)` : 'Open the Rex app (through the Shortcut named “Rex”)', href }
}

export function resolveDestination<T extends { id: ConversationOpening }>(destinations: readonly T[], remembered = conversationOpening()): T | undefined {
  return destinations.find(destination => destination.id === remembered) ?? destinations[0]
}

/** Point an anchor at a destination. Desktop opens web pages in a new tab; a phone keeps
 *  them in place, where iOS hands a universal link such as claude.ai to its app. */
export function linkDestination(link: HTMLAnchorElement, href: string, desktop = conversationDevice().desktop): void {
  link.href = href
  if (desktop && href.startsWith('https:')) { link.target = '_blank'; link.rel = 'noopener noreferrer' }
}

/** Use a native anchor so app schemes and browser links retain their normal gesture semantics. */
export function openDestination(destination: ConversationDestination): void {
  if (destination.run) { destination.run(); return }
  const link = document.createElement('a')
  linkDestination(link, destination.href)
  link.click()
}

export const REMOTE_CONTROL_REQUIRED = 'No Claude Remote Control link is available. Enable Remote Control in this Claude session to open it in the browser or app.'
