import { anchorPopover, type Release } from './anchoredPopover.js'
import { coarsePointer } from '../mobile.js'

/**
 * A native `<select>` whose list opens as an anchored popover under the
 * select itself. The browser's own popup is placed by the platform and lands
 * away from the control inside the reader's transformed stage; this list
 * follows the shared anchoring rule instead. The `<select>` stays the value
 * and its `change` event the commit, so callers and forms see no difference.
 * A coarse pointer keeps the platform's own picker, which is a system sheet.
 */
let dismissOpen: (() => void) | null = null

/** Closes the open select list, returning focus to its select; false when none is open. */
export function dismissSelectPicker(): boolean {
  if (!dismissOpen) return false
  dismissOpen()
  return true
}

export function anchorSelect(select: HTMLSelectElement): () => void {
  let panel: HTMLElement | null = null
  let release: Release | null = null

  const close = (restore = false): void => {
    if (!panel) return
    if (dismissOpen === restoreClose) dismissOpen = null
    release?.(); release = null
    panel.remove(); panel = null
    select.setAttribute('aria-expanded', 'false')
    window.removeEventListener('pointerdown', outside, true)
    if (restore && select.isConnected) select.focus({ preventScroll: true })
  }
  const restoreClose = (): void => close(true)
  const outside = (event: PointerEvent): void => {
    if (panel?.contains(event.target as Node) || event.target === select) return
    close()
  }
  const choose = (value: string): void => {
    const changed = select.value !== value
    select.value = value
    close(true)
    if (changed) select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  const open = (): void => {
    if (panel || select.disabled) return
    const list = document.createElement('div')
    list.className = 'ws-select-picker'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', select.getAttribute('aria-label') ?? '')
    const items: HTMLButtonElement[] = []
    const option = (source: HTMLOptionElement): HTMLButtonElement => {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'ws-select-option'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(source.value === select.value))
      item.textContent = source.textContent
      item.disabled = source.disabled
      item.tabIndex = -1
      item.addEventListener('click', (event) => { event.stopPropagation(); choose(source.value) })
      items.push(item)
      return item
    }
    for (const child of select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const group = document.createElement('div')
        group.className = 'ws-select-group'
        group.setAttribute('role', 'group')
        group.setAttribute('aria-label', child.label)
        const label = document.createElement('div')
        label.className = 'ws-select-group-label'
        label.textContent = child.label
        group.append(label, ...[...child.querySelectorAll('option')].map(option))
        list.append(group)
      } else if (child instanceof HTMLOptionElement) list.append(option(child))
    }
    list.addEventListener('keydown', (event) => {
      const enabled = items.filter(item => !item.disabled)
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement)
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation()
        const step = event.key === 'ArrowDown' ? 1 : -1
        enabled[(at + step + enabled.length) % enabled.length]?.focus()
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation()
        enabled[event.key === 'Home' ? 0 : enabled.length - 1]?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation()
        close(true)
      } else if (event.key === 'Tab') close(true)
    })
    list.addEventListener('mousedown', (event) => event.preventDefault())
    select.after(list)
    panel = list
    select.setAttribute('aria-expanded', 'true')
    release = anchorPopover(list, select, { placement: 'below-start', matchWidth: true })
    window.addEventListener('pointerdown', outside, true)
    dismissOpen?.()
    dismissOpen = restoreClose
    const current = items.find(item => item.getAttribute('aria-selected') === 'true' && !item.disabled) ?? items.find(item => !item.disabled)
    current?.focus({ preventScroll: true })
    current?.scrollIntoView?.({ block: 'nearest' })
  }

  const press = (event: MouseEvent): void => {
    if (event.button !== 0 || coarsePointer()) return
    event.preventDefault()
    if (panel) { close(true); return }
    select.focus({ preventScroll: true })
    open()
  }
  const key = (event: KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || coarsePointer()) return
    if (![' ', 'Enter', 'ArrowDown', 'ArrowUp', 'F4'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    open()
  }
  select.setAttribute('aria-haspopup', 'listbox')
  select.setAttribute('aria-expanded', 'false')
  select.addEventListener('mousedown', press)
  select.addEventListener('keydown', key)
  return () => {
    close()
    select.removeEventListener('mousedown', press)
    select.removeEventListener('keydown', key)
  }
}
