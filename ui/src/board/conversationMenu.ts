import '@ui-sdk/web/menu'
import './conversationMenu.css'
import { attachLongPress } from './longPress.js'
import { conversationOpening, linkDestination, saveConversationOpening, resolveDestination, type ConversationDestination } from './conversationOpening.js'

export interface ConversationAction {
  label: string; href?: string; run?: () => void; disabled?: boolean; checked?: boolean
  /** Draws the item as a control drawn elsewhere (a header verb). */
  dress?: (item: HTMLButtonElement) => void
}

let dismissOpenMenu: (() => void) | undefined

/** Mount a temporary SDK menu outside the board's clickable rows. */
export function openActionMenu(anchor: HTMLElement, actions: readonly ConversationAction[], label: string, point?: { x: number; y: number }): () => void {
  dismissOpenMenu?.()
  const root = document.createElement('ui-menu')
  root.setAttribute('modal', 'false')
  const menu = document.createElement('ui-menu-content')
  menu.className = 'kbn-conversation-menu'
  menu.setAttribute('aria-label', label)
  menu.setAttribute('align', 'start')
  menu.setAttribute('collision-padding', '8')
  root.append(menu)
  const anchorBounds = anchor.getBoundingClientRect()
  const close = (): void => { root.api.close() }
  const scrolled = (): void => {
    // Queued scroll events need not mean the anchor moved.
    const next = anchor.getBoundingClientRect()
    if (next.left !== anchorBounds.left || next.top !== anchorBounds.top) close()
  }
  let selectedAction: ConversationAction | undefined
  root.addEventListener('openchange', event => {
    if (!event.detail.value && event.detail.reason === 'item-press') {
      const target = event.detail.event?.target as HTMLElement | undefined
      const index = target?.closest<HTMLElement>('[data-action-index]')?.dataset.actionIndex
      if (index !== undefined) selectedAction = actions[Number(index)]
    }
  })
  // A destination picker starts at the remembered choice once the SDK moves focus in.
  menu.addEventListener('focusin', () => {
    menu.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')?.focus({ preventScroll: true })
  }, { once: true })
  root.addEventListener('openchangecomplete', event => {
    if (event.detail.value) return
    anchor.setAttribute('aria-expanded', 'false')
    window.removeEventListener('resize', close)
    window.removeEventListener('scroll', scrolled, true)
    if (dismissOpenMenu === close) dismissOpenMenu = undefined
    // Let the popup finish its focus-return microtask before removing its tree or running a verb.
    queueMicrotask(() => queueMicrotask(() => {
      root.remove()
      selectedAction?.run?.()
    }))
  })
  // Menu keys and pointer presses belong to the popup, not the board below it.
  menu.addEventListener('keydown', event => event.stopPropagation())
  menu.addEventListener('pointerdown', event => event.stopPropagation())
  let group: HTMLElement | undefined
  if (actions.some(action => action.checked !== undefined)) {
    const radio = document.createElement('ui-menu-radio-group')
    const selected = actions.findIndex(action => action.checked)
    if (selected >= 0) radio.setAttribute('default-value', String(selected))
    group = radio
    menu.append(group)
  }
  let verbs = false
  for (const [index, action] of (actions.length ? actions : [{ label: 'No actions available', disabled: true }]).entries()) {
    const part = document.createElement(action.checked === undefined ? 'ui-menu-item' : 'ui-menu-radio-item')
    part.setAttribute('as-child', '')
    part.setAttribute('value', String(index))
    part.setAttribute('label', action.label)
    if (action.disabled) part.setAttribute('disabled', '')
    if (action.checked !== undefined) part.setAttribute('close-on-select', '')
    const item = document.createElement(action.href ? 'a' : 'button')
    item.dataset.actionIndex = String(index)
    if (item instanceof HTMLAnchorElement) linkDestination(item, action.href!)
    else (item as HTMLButtonElement).type = 'button'
    if (action.checked === undefined) item.textContent = action.label
    else {
      const mark = document.createElement('ui-menu-item-indicator')
      mark.setAttribute('keep-mounted', '')
      mark.setAttribute('aria-hidden', 'true')
      mark.textContent = '✓'
      const text = document.createElement('span')
      text.className = 'kbn-conversation-label'
      text.textContent = action.label
      item.append(mark, text)
    }
    if (action.dress && item instanceof HTMLButtonElement) {
      action.dress(item)
      verbs = true
      menu.classList.add('kbn-verb-menu')
    } else if (verbs) {
      if (!menu.querySelector('ui-menu-separator')) {
        const rule = document.createElement('ui-menu-separator')
        rule.className = 'kbn-verb-menu-rule'
        menu.append(rule)
      }
      item.classList.add('kbn-verb-menu-plain')
    }
    part.append(item)
    ;(action.checked === undefined ? menu : group!).append(part)
    item.addEventListener('click', event => event.stopPropagation())
  }
  document.body.append(root)
  anchor.setAttribute('aria-expanded', 'true')
  dismissOpenMenu = close
  window.addEventListener('resize', close)
  window.addEventListener('scroll', scrolled, true)
  // Controller-opened popups return to the element focused when they open.
  anchor.focus({ preventScroll: true })
  void root.api.open({ anchor: point ?? anchor, focus: 'first' })
  return close
}

/** Touch and mouse share the same picker. Activating the anchor opens its destination. */
export function attachConversationPicker(anchor: HTMLElement, destinations: () => readonly ConversationDestination[]): () => void {
  anchor.classList.add('kbn-picker-anchor')
  const show = (point?: { x: number; y: number }): void => {
    const available = destinations()
    if (!available.length) return
    const selected = resolveDestination(available, conversationOpening())
    openActionMenu(anchor, available.map(destination => ({
      label: `Open in ${destination.label}`,
      href: destination.href,
      checked: destination.id === selected?.id,
      run: () => {
        if (available.length >= 2) saveConversationOpening(destination.id)
        destination.run?.()
      },
    })), 'Open conversation in', point)
  }
  const context = (event: MouseEvent): void => {
    event.preventDefault(); event.stopPropagation()
    // Android follows a long-press with its own contextmenu while the picker is up.
    if (anchor.getAttribute('aria-expanded') === 'true') return
    show(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : undefined)
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault(); event.stopPropagation()
    show()
  }
  anchor.addEventListener('contextmenu', context)
  anchor.addEventListener('keydown', keyboard)
  // A pill nested in a Desk row owns the gesture, not the row's action menu.
  const down = (event: PointerEvent): void => event.stopPropagation()
  anchor.addEventListener('pointerdown', down)
  const detach = attachLongPress(anchor, { onFire: () => show() })
  return () => {
    detach()
    anchor.removeEventListener('contextmenu', context)
    anchor.removeEventListener('keydown', keyboard)
    anchor.removeEventListener('pointerdown', down)
  }
}
