import { claudeAppRoute, claudeWebLink } from './sessionHistory'

export interface ConversationAction { label: string; href?: string; run?: () => void }

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

/** A temporary menu owns its document listeners only while it is visible. */
export function addConversationMenu(pill: HTMLElement, actions: ConversationAction[]): HTMLElement {
  if (actions.length < 2) return pill
  pill.setAttribute('aria-haspopup', 'menu')
  pill.setAttribute('aria-expanded', 'false')
  pill.title += '\nRight-click for other opening options.'
  pill.addEventListener('contextmenu', event => {
    event.preventDefault()
    event.stopPropagation()
    dismissOpenMenu?.()
    const menu = document.createElement('div')
    menu.className = 'kbn-conversation-menu'
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-label', 'Open conversation in')
    Object.assign(menu.style, {
      position: 'fixed', zIndex: '10000', background: '#F4F0E8', color: '#2E2A26',
      border: '1px solid #BDB3A5', borderRadius: '4px', padding: '5px',
      boxShadow: '0 6px 20px #0002', minWidth: '220px', fontFamily: 'var(--font-main, serif)',
    })
    const items: HTMLElement[] = []
    const dismiss = (restore = false): void => {
      menu.remove()
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
      if (dismissOpenMenu === close) dismissOpenMenu = undefined
      pill.setAttribute('aria-expanded', 'false')
      if (restore && pill.isConnected) pill.focus()
    }
    const close = (): void => dismiss()
    const outside = (e: Event): void => {
      // This portal is outside the card; selecting it must not trigger card click-away.
      if (menu.contains(e.target as Node)) e.stopPropagation()
      else dismiss()
    }
    const keyboard = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation() }; dismiss(true); return }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault()
        e.stopPropagation()
        const current = items.indexOf(document.activeElement as HTMLElement)
        const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
          : (current + (e.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
        items[index].focus()
      }
    }
    for (const action of actions) {
      const item = document.createElement(action.href ? 'a' : 'button')
      if (item instanceof HTMLAnchorElement) {
        item.href = action.href!
        if (action.href!.startsWith('https:')) { item.target = '_blank'; item.rel = 'noopener noreferrer' }
      } else (item as HTMLButtonElement).type = 'button'
      item.textContent = action.label
      item.setAttribute('role', 'menuitem')
      item.tabIndex = -1
      Object.assign(item.style, { display: 'block', width: '100%', boxSizing: 'border-box', textAlign: 'left', padding: '10px 12px', font: 'inherit', fontSize: '16px', color: 'inherit', background: 'transparent', border: '0', textDecoration: 'none', cursor: 'pointer', borderRadius: '2px' })
      item.addEventListener('focus', () => { item.style.background = '#E5DED2' })
      item.addEventListener('blur', () => { item.style.background = 'transparent' })
      item.addEventListener('click', e => { e.stopPropagation(); action.run?.(); dismiss() })
      menu.append(item)
      items.push(item)
    }
    document.body.append(menu)
    const bounds = menu.getBoundingClientRect()
    const origin = event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: pill.getBoundingClientRect().left, y: pill.getBoundingClientRect().bottom }
    menu.style.left = `${Math.max(8, Math.min(origin.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(origin.y, window.innerHeight - bounds.height - 8))}px`
    pill.setAttribute('aria-expanded', 'true')
    dismissOpenMenu = close
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('resize', close)
    window.addEventListener('scroll', close, true)
    items[0].focus()
  })
  return pill
}
