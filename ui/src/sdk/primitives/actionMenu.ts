import '@ui-sdk/web/menu'
import type { ShuttleClient } from '../client.js'
import { offersFor } from '../model.js'
import type { ShuttleFiber, ShuttleOffer } from '../types.js'
import { part } from './dom.js'

export interface ActionMenuOptions {
  /** The verbs to list; `offersFor(fiber)` by default. */
  offers?: readonly ShuttleOffer[]
  /** The menu's accessible name. */
  label?: string
  /** Whether the page behind is inert while it is open; false by default, so an outside press reaches its target. */
  modal?: boolean
  /** A verb landed, with the daemon's answer. */
  onAction?(offer: ShuttleOffer, result: unknown): void
  /** A verb was refused; the menu stays open with the item's error until the next try. */
  onError?(error: unknown, offer: ShuttleOffer): void
}

export interface ActionMenu {
  /** `<div data-slot="shuttle-action-menu">`, holding the SDK menu. */
  readonly element: HTMLDivElement
  readonly offers: readonly ShuttleOffer[]
  /** Open beside `anchor` (an element or a point), focusing the first item; focus returns to the anchor element on close. */
  open(options: { anchor: HTMLElement | { x: number; y: number }; focus?: 'first' | 'last' }): void
  close(): void
  /** Close and take the menu out of the page. */
  destroy(): void
}

/**
 * A fiber's verbs as an SDK menu (`@ui-sdk/web/menu`): each offer an item
 * with `data-verb` (and `data-destructive` where it ends the work), taken
 * through `client.act` when chosen. The item stays pending while the daemon
 * answers; a landed verb closes the menu and calls `onAction`, a refusal keeps
 * it open, puts the reason in the item's error state and calls `onError`.
 */
export function createActionMenu(fiber: ShuttleFiber, client: ShuttleClient, options: ActionMenuOptions = {}): ActionMenu {
  const offers = options.offers ?? offersFor(fiber)
  const element = part('div', 'shuttle-action-menu')
  const root = document.createElement('ui-menu')
  root.setAttribute('modal', String(options.modal ?? false))
  const content = document.createElement('ui-menu-content')
  content.setAttribute('aria-label', options.label ?? `Actions for ${fiber.fiber.name}`)
  content.setAttribute('align', 'start')
  content.setAttribute('collision-padding', '16')
  for (const offer of offers) {
    const item = document.createElement('ui-menu-item')
    item.setAttribute('value', offer.verb)
    item.dataset.verb = offer.verb
    item.toggleAttribute('data-destructive', !!offer.destructive)
    item.textContent = offer.label
    content.append(item)
  }
  if (!offers.length) {
    const none = document.createElement('ui-menu-item')
    none.setAttribute('disabled', '')
    none.textContent = 'No actions available'
    content.append(none)
  }
  root.append(content)
  element.append(root)
  root.addEventListener('action', event => {
    const offer = offers.find(each => each.verb === event.detail.value)
    if (!offer) return
    event.detail.waitUntil(client.act(fiber, offer).then(
      result => { options.onAction?.(offer, result) },
      error => { options.onError?.(error, offer); throw error },
    ))
  })
  let removeWhenClosed = false
  root.addEventListener('openchangecomplete', event => {
    if (event.detail.value) return
    element.toggleAttribute('data-open', false)
    // Let the popup finish returning focus before its tree leaves the page.
    if (removeWhenClosed) queueMicrotask(() => queueMicrotask(() => element.remove()))
  })
  return {
    element,
    offers,
    open({ anchor, focus = 'first' }) {
      if (!element.isConnected) document.body.append(element)
      // A popup opened from code returns focus to what was focused before it.
      if (anchor instanceof HTMLElement) anchor.focus({ preventScroll: true })
      element.toggleAttribute('data-open', true)
      // It resolves when the menu closes; the menu reports what happened through its events.
      void root.api?.open({ anchor, focus })
    },
    close() {
      root.api?.close()
    },
    destroy() {
      removeWhenClosed = true
      if (element.hasAttribute('data-open')) root.api?.close()
      else element.remove()
    },
  }
}
