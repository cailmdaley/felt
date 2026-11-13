/**
 * The move menu: "Move to", then the places.
 *
 * Which places a card may go is decided in `MoveDestinations.ts`; this file
 * renders them and hands the chosen one back to the board through the
 * `MoveBroker`. Each row is a place name, in the words the board prints over
 * that region, with a rule between the Now columns and the rest. The card being
 * moved is in the menu's accessible name and the subline beside the heading.
 *
 * It is an SDK popover menu mounted on `document.body`: beside the card on
 * desktop, and on a phone pinned by `MoveMenu.css` to the bottom edge as a
 * sheet over a scrim. The SDK owns its keys, focus and dismissal; an outside
 * press closes it without reaching what lies beneath. The phone sheet is a
 * plain popover rather than the SDK's swipeable sheet, so a long press that
 * keeps dragging after it opens cannot move it.
 */
import '@ui-sdk/web/menu'
import type { KanbanCard } from './KanbanTypes.js'
import type { MoveBroker } from './MoveDestinations.js'
import { isMobileViewport, onMobileChange } from './mobile.js'
import { clearSelection, onPressRelease } from './dismissGesture.js'
import './MoveMenu.css'

let closeOpenMenu: (() => void) | undefined

/** Open the menu against `anchor`, replacing any move menu already open. */
export function openMoveMenu(card: KanbanCard, anchor: HTMLElement, broker: MoveBroker): void {
  closeOpenMenu?.()
  const sheet = isMobileViewport()
  const root = document.createElement('ui-menu')
  const menu = document.createElement('ui-menu-content')
  menu.className = sheet ? 'kbn-move-menu kbn-move-sheet' : 'kbn-move-menu'
  menu.setAttribute('aria-label', `Move ${card.name}`)
  menu.setAttribute('align', 'start')
  menu.setAttribute('side-offset', '6')
  menu.setAttribute('collision-padding', '8')
  menu.append(buildMoveHeading(card.name))
  const list = document.createElement('div')
  list.className = 'kbn-move-list'
  const destinations = broker.destinations(card)
  let lastGroup: string | null = null
  for (const [index, dest] of destinations.entries()) {
    if (lastGroup !== null && dest.group !== lastGroup) {
      const rule = document.createElement('ui-menu-separator')
      rule.className = 'kbn-move-rule'
      list.append(rule)
    }
    lastGroup = dest.group
    const item = document.createElement('ui-menu-item')
    item.setAttribute('as-child', '')
    item.setAttribute('value', String(index))
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'kbn-move-item'
    const label = document.createElement('span')
    label.className = 'kbn-move-item-label'
    label.textContent = dest.label
    button.append(label)
    item.append(button)
    list.append(item)
  }
  menu.append(list)
  root.append(menu)

  const close = (): void => { root.api.close() }
  let chosen: typeof destinations[number] | undefined
  root.addEventListener('action', event => { chosen = destinations[Number(event.detail.value)] })
  root.addEventListener('openchangecomplete', event => {
    if (event.detail.value) return
    stopPressWatch()
    window.removeEventListener('resize', close)
    stopMobileWatch()
    anchor.setAttribute('aria-expanded', 'false')
    if (closeOpenMenu === close) closeOpenMenu = undefined
    // Let focus return to the card before a move re-renders or removes it.
    queueMicrotask(() => queueMicrotask(() => {
      root.remove()
      if (chosen) broker.perform(card, chosen.action)
    }))
  })
  // Menu keys and presses belong to the popup, not the Desk below it.
  menu.addEventListener('keydown', event => event.stopPropagation())
  menu.addEventListener('pointerdown', event => event.stopPropagation())
  document.body.append(root)
  anchor.setAttribute('aria-expanded', 'true')
  closeOpenMenu = close

  // A long press opens the menu under a finger that is still down, and iPadOS
  // may already have selected text where the menu now is.
  clearSelection()
  // Until that press lets go, no row takes pointer input: its release must not
  // choose, or even light up, whichever place rose under the thumb.
  list.style.pointerEvents = 'none'
  const stopPressWatch = onPressRelease(window, () => {
    list.style.removeProperty('pointer-events')
    clearSelection()
  })
  // The menu is transient: a resize, or crossing into the phone layout, closes
  // it rather than chasing its anchor.
  window.addEventListener('resize', close)
  const stopMobileWatch = onMobileChange(close)
  // Controller-opened popups return focus to the element focused when they open.
  anchor.focus({ preventScroll: true })
  // A touch sheet opens on its surface: a highlighted first row under the thumb
  // would read as a choice already made.
  void root.api.open({ anchor, focus: sheet ? 'popup' : 'first' })
}

function buildMoveHeading(name: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'kbn-move-heading'
  const label = document.createElement('span')
  label.className = 'kbn-move-heading-text'
  label.textContent = 'Move to'
  const sub = document.createElement('span')
  sub.className = 'kbn-move-heading-sub'
  sub.textContent = name
  row.append(label, sub)
  return row
}
