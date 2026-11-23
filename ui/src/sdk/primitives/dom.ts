/**
 * What every primitive is built from: an element that names its part with
 * `data-slot`, and state flags that are present or absent. No primitive
 * sets a class, a style or a colour; a skin selects these attributes.
 */

/** An element naming its part. */
export function part<K extends keyof HTMLElementTagNameMap>(tag: K, slot: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.dataset.slot = slot
  if (text !== undefined) el.textContent = text
  return el
}

/** Set or clear a presence flag, `data-<name>`. */
export function flag(el: HTMLElement, name: string, on: boolean): void {
  el.toggleAttribute(`data-${name}`, on)
}

/** Make an element a keyboard-reachable button that calls `activate` on a click, Enter or Space. */
export function pressable(el: HTMLElement, label: string, activate: () => void): void {
  el.setAttribute('role', 'button')
  el.tabIndex = 0
  el.setAttribute('aria-label', label)
  el.addEventListener('click', event => {
    if (event.target !== el && (event.target as Element).closest('button, a, input, textarea, select, iframe')) return
    activate()
  })
  el.addEventListener('keydown', event => {
    if (event.target !== el || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    activate()
  })
}

/** A native button naming its part. */
export function button(slot: string, text: string, onClick?: () => void): HTMLButtonElement {
  const el = part('button', slot, text)
  el.type = 'button'
  if (onClick) el.addEventListener('click', onClick)
  return el
}
