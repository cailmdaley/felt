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
): { href?: string; title: string; guidance: string } {
  const href = desktop ? validDesktopThreadLink(card.desktopLink) : undefined
  const project = card.shuttleProjectDir?.split(/[\\/]/).filter(Boolean).at(-1)
  const location = [card.shuttleHost, project].filter(Boolean).join(' → ')
  const guidance = `Continue in ChatGPT → Remote${location ? ` → ${location}` : ''}, then choose this conversation.`
  const title = href
    ? `Open in the ChatGPT desktop app. If it does not select this host, use Remote${location ? ` → ${location}` : ''}.`
    : guidance
  return { href, title: card.launchError ? `${title}\n\n${card.launchError}` : title, guidance }
}

export function workerStatusLabel(phase?: string, launchError?: string): string {
  if (launchError || phase === 'blocked') return '⚠ blocked'
  return 'Aloft'
}

/** Mobile clients without a verified app route still get a usable destination. */
export function showAppConversationGuidance(
  card: Pick<KanbanCard, 'desktopLink' | 'shuttleHost' | 'shuttleProjectDir' | 'launchError' | 'sessionUuid'>,
): void {
  const dialog = document.createElement('dialog')
  dialog.className = 'kbn-conversation-guidance'
  const heading = document.createElement('h2')
  heading.textContent = 'Continue in ChatGPT'
  const instructions = document.createElement('p')
  instructions.textContent = appConversationTarget(card, false).guidance
  const destination = document.createElement('dl')
  for (const [name, value] of [
    ['Host', card.shuttleHost], ['Project', card.shuttleProjectDir], ['Conversation', card.sessionUuid],
  ] as const) {
    if (!value) continue
    const term = document.createElement('dt')
    term.textContent = name
    const detail = document.createElement('dd')
    detail.textContent = value
    destination.append(term, detail)
  }
  const limitation = document.createElement('p')
  limitation.textContent = 'A direct app link is not available on this device.'
  const actions = document.createElement('div')
  if (card.sessionUuid && navigator.clipboard?.writeText) {
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'kbn-detail-action-btn'
    copy.textContent = 'Copy conversation ID'
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(card.sessionUuid!)
        copy.textContent = 'Copied'
      } catch {
        copy.textContent = 'Select the conversation ID above to copy'
      }
    })
    actions.append(copy)
  }
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'kbn-detail-action-btn'
  close.textContent = 'Close'
  close.addEventListener('click', () => dialog.close())
  actions.append(close)
  dialog.append(heading, instructions, destination, limitation, actions)
  dialog.setAttribute('aria-label', 'Continue in ChatGPT')
  // Board shortcuts must not consume this modal's navigation or dismissal.
  const onKeyDown = (event: KeyboardEvent) => {
    event.stopImmediatePropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      dialog.close()
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  dialog.addEventListener('close', () => {
    window.removeEventListener('keydown', onKeyDown, true)
    dialog.remove()
  }, { once: true })
  document.body.append(dialog)
  dialog.showModal()
}
