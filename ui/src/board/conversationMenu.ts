import { claudeAppRoute, claudeWebLink } from './sessionHistory'

export interface ConversationAction {
  label: string; href?: string; run?: () => void; disabled?: boolean
  /** Draws the item as a control drawn elsewhere (a header verb); the menu then styles it by that control's classes. */
  dress?: (item: HTMLButtonElement) => void
}

/** Offer only destinations that can open this recorded conversation. */
export function conversationActions(webLink: string | null | undefined, desktop: boolean, terminal?: () => void): ConversationAction[] {
  const actions: ConversationAction[] = []
  if (desktop && terminal) actions.push({ label: 'Open in Terminal (Kitty)', run: terminal })
  const web = claudeWebLink(webLink)
  if (web) {
    actions.push({ label: 'Open in Claude browser', href: web })
    const app = desktop ? claudeAppRoute(web) : undefined
    if (app) actions.push({ label: 'Open in Claude app', href: app })
  }
  return actions
}

let dismissOpenMenu: (() => void) | undefined

/** A temporary, anchored action menu owns its listeners only while visible. */
export function openActionMenu(anchor: HTMLElement, actions: readonly ConversationAction[], label: string, point?: { x: number; y: number }): () => void {
  dismissOpenMenu?.()
  const menu = document.createElement('div')
  menu.className = 'kbn-conversation-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label)
  Object.assign(menu.style, {
    position: 'fixed', zIndex: '10000', background: 'var(--kbn-form-paper)', color: 'var(--kbn-graphite)',
    border: '1px solid color-mix(in srgb, var(--kbn-ink) 23%, var(--kbn-parchment))', borderRadius: '4px', padding: '5px',
    boxShadow: '0 6px 20px color-mix(in srgb, var(--kbn-shade) 13.33%, transparent)', minWidth: '220px', fontFamily: 'var(--font-serif)',
  })
  const items: HTMLElement[] = []
  const anchorBounds = anchor.getBoundingClientRect()
  let closed = false
  const dismiss = (restore = false): void => {
    if (closed) return
    closed = true
    menu.remove()
    window.removeEventListener('pointerdown', outside, true)
    window.removeEventListener('keydown', keyboard, true)
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', scrolled, true)
    if (dismissOpenMenu === close) dismissOpenMenu = undefined
    anchor.setAttribute('aria-expanded', 'false')
    if (restore && anchor.isConnected) anchor.focus({ preventScroll: true })
  }
  const close = (): void => dismiss()
  const scrolled = (): void => {
    // A click can queue a scroll event before opening the menu. Only actual
    // anchor movement invalidates its position, not delivery of that event.
    const next = anchor.getBoundingClientRect()
    if (next.left !== anchorBounds.left || next.top !== anchorBounds.top) dismiss()
  }
  const outside = (e: Event): void => {
    // The portal must not trigger the card's click-away handling.
    if (menu.contains(e.target as Node)) e.stopPropagation()
    else dismiss()
  }
  const keyboard = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() }
      dismiss(true)
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && items.length) {
      e.preventDefault(); e.stopPropagation()
      const current = items.indexOf(document.activeElement as HTMLElement)
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
        : (current + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
      items[index].focus({ preventScroll: true })
    }
    // Native Enter/Space activate the focused button; Desk verb keys stay beneath the menu.
    if (menu.contains(e.target as Node)) e.stopPropagation()
  }
  for (const action of actions.length ? actions : [{ label: 'No actions available', disabled: true }]) {
    const item = document.createElement(action.href ? 'a' : 'button')
    if (item instanceof HTMLAnchorElement) {
      item.href = action.href!
      if (action.href!.startsWith('https:')) { item.target = '_blank'; item.rel = 'noopener noreferrer' }
    } else {
      (item as HTMLButtonElement).type = 'button'
      ;(item as HTMLButtonElement).disabled = !!action.disabled
    }
    item.textContent = action.label
    item.setAttribute('role', 'menuitem')
    item.tabIndex = -1
    if (action.dress && item instanceof HTMLButtonElement) {
      action.dress(item)
      menu.classList.add('kbn-verb-menu')
      item.addEventListener('click', e => { e.stopPropagation(); dismiss(true); action.run?.() })
      menu.append(item)
      if (!action.disabled) items.push(item)
      continue
    }
    if (menu.classList.contains('kbn-verb-menu')) {
      // Beneath the verbs, a plain item is drawn in the verbs' type, its word aligned with theirs.
      if (!menu.querySelector('.kbn-verb-menu-rule')) {
        const rule = document.createElement('hr'); rule.className = 'kbn-verb-menu-rule'; menu.append(rule)
      }
      item.classList.add('kbn-verb-menu-plain')
      item.addEventListener('click', e => { e.stopPropagation(); dismiss(true); action.run?.() })
      menu.append(item)
      if (!action.disabled) items.push(item)
      continue
    }
    Object.assign(item.style, { display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left', padding: '10px 12px', font: 'inherit', fontSize: 'var(--type-row)', color: 'inherit', background: 'transparent', border: '0', textDecoration: 'none', cursor: 'pointer', borderRadius: '2px' })
    item.addEventListener('focus', () => { item.style.background = 'var(--kbn-form-band)' })
    item.addEventListener('blur', () => { item.style.background = 'transparent' })
    item.addEventListener('click', e => { e.stopPropagation(); dismiss(true); action.run?.() })
    menu.append(item)
    if (!action.disabled) items.push(item)
  }
  menu.tabIndex = -1
  document.body.append(menu)
  const bounds = menu.getBoundingClientRect()
  const origin = point ?? { x: anchor.getBoundingClientRect().left, y: anchor.getBoundingClientRect().bottom }
  menu.style.left = `${Math.max(8, Math.min(origin.x, window.innerWidth - bounds.width - 8))}px`
  menu.style.top = `${Math.max(8, Math.min(origin.y, window.innerHeight - bounds.height - 8))}px`
  anchor.setAttribute('aria-expanded', 'true')
  dismissOpenMenu = close
  window.addEventListener('pointerdown', outside, true)
  window.addEventListener('keydown', keyboard, true)
  window.addEventListener('resize', close)
  window.addEventListener('scroll', scrolled, true)
  ;(items[0] ?? menu).focus({ preventScroll: true })
  return close
}

/** Right-click offers the other destinations for this conversation. */
export function addConversationMenu(pill: HTMLElement, actions: ConversationAction[]): HTMLElement {
  if (actions.length < 2) return pill
  pill.setAttribute('aria-haspopup', 'menu')
  pill.setAttribute('aria-expanded', 'false')
  pill.title += '\nRight-click for other opening options.'
  pill.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation()
    const point = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined
    openActionMenu(pill, actions, 'Open conversation in', point)
  })
  return pill
}
