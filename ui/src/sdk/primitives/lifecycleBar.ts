import '@ui-sdk/web/toolbar'
import type { ShuttleClient } from '../client.js'
import { offersFor } from '../model.js'
import { notify } from '../notify.js'
import type { ShuttleFiber, ShuttleOffer } from '../types.js'
import { flag, isBusy, part, setBusy } from './dom.js'

export interface LifecycleBarOptions {
  /** The verbs to draw; every offer but stopping the worker (`kill`, a menu's) by default. */
  offers?: readonly ShuttleOffer[]
  /** The toolbar's accessible name. */
  label?: string
  onAction?(offer: ShuttleOffer, result: unknown): void
  onError?(error: unknown, offer: ShuttleOffer): void
}

/**
 * A fiber's primary verbs as `<div data-slot="shuttle-lifecycle-bar">`
 * around an SDK toolbar (`@ui-sdk/web/toolbar`: one Tab stop, arrows between
 * verbs), each a native `<button data-verb>` (the toolbar names it
 * `data-slot="toolbar-button"`) taken through `client.act`. While one runs
 * the bar is `aria-busy`, its verbs `aria-disabled` and `data-disabled`, the
 * running one `data-pending`.
 */
export function createLifecycleBar(fiber: ShuttleFiber, client: ShuttleClient, options: LifecycleBarOptions = {}): HTMLDivElement {
  const offers = options.offers ?? offersFor(fiber).filter(offer => offer.verb !== 'kill')
  const root = part('div', 'shuttle-lifecycle-bar')
  const toolbar = document.createElement('ui-toolbar')
  toolbar.setAttribute('aria-label', options.label ?? `Lifecycle of ${fiber.fiber.name}`)
  const verbs: HTMLButtonElement[] = []
  const busy = (on: boolean): void => {
    setBusy(root, on)
    for (const verb of verbs) {
      verb.setAttribute('aria-disabled', String(on))
      flag(verb, 'disabled', on)
    }
  }
  for (const offer of offers) {
    const verb = document.createElement('button')
    verb.type = 'button'
    verb.textContent = offer.label
    verb.setAttribute('aria-disabled', 'false')
    verb.dataset.verb = offer.verb
    flag(verb, 'destructive', !!offer.destructive)
    verb.addEventListener('click', async () => {
      if (isBusy(root)) return
      busy(true)
      flag(verb, 'pending', true)
      let told: () => void
      try {
        const result = await client.act(fiber, offer)
        told = () => options.onAction?.(offer, result)
      } catch (error) {
        told = () => options.onError?.(error, offer)
      }
      flag(verb, 'pending', false)
      busy(false)
      notify(told)
    })
    verbs.push(verb)
    const holder = document.createElement('ui-toolbar-button')
    holder.append(verb)
    toolbar.append(holder)
  }
  flag(root, 'empty', !offers.length)
  root.append(toolbar)
  return root
}
