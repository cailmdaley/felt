import { anchorPopover, type Release } from './anchoredPopover.js'

/** Give a header action a glyph-led tile without changing its event wiring. */
export function headerTile(button: HTMLButtonElement, glyph: string, title = button.textContent ?? ''): HTMLButtonElement {
  const icon = document.createElement('span')
  icon.className = 'ws-header-tile-glyph'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = glyph
  const text = document.createElement('span')
  text.className = 'ws-header-tile-title'
  text.textContent = title
  button.classList.remove('kbn-ctl-btn')
  button.classList.add('ws-header-tile')
  button.replaceChildren(icon, text)
  return button
}

export interface HeaderSheet {
  trigger: HTMLButtonElement
  panel: HTMLElement
  close(restore?: boolean): boolean
  dispose(): void
}

/** A visual action sheet, anchored in the top layer on every viewport. */
export function headerSheet(name: 'Act' | 'Look', beforeOpen: () => void): HeaderSheet {
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'ws-header-control'
  trigger.title = name
  trigger.setAttribute('aria-label', name)
  trigger.setAttribute('aria-haspopup', 'dialog')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24">${name === 'Act'
    ? '<path d="m13 3-8 10h6l-1 8 9-11h-7z"/>'
    : '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'}</svg>`
  const panel = document.createElement('section')
  panel.className = 'ws-header-sheet'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', name)
  panel.hidden = true
  const heading = document.createElement('h2')
  heading.className = 'ws-header-sheet-title'
  heading.textContent = name
  panel.append(heading)
  let release: Release | null = null
  const close = (restore = false): boolean => {
    if (panel.hidden) return false
    release?.(); release = null
    panel.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', keyboard, true)
    if (restore && trigger.isConnected) trigger.focus({ preventScroll: true })
    return true
  }
  const outside = (event: PointerEvent): void => {
    if (!panel.contains(event.target as Node) && !trigger.contains(event.target as Node)) close()
  }
  const keyboard = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); close(true)
    } else if (event.key === 'Tab' && panel.contains(event.target as Node)) {
      const items = visibleButtons()
      const at = items.indexOf(document.activeElement as HTMLButtonElement)
      if ((!event.shiftKey && at === items.length - 1) || (event.shiftKey && at === 0)) {
        event.preventDefault(); close(true)
      }
    } else if (panel.contains(event.target as Node)) {
      // Lifecycle shortcuts belong to the page only while the sheet is closed.
      event.stopPropagation()
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
      if (step) {
        event.preventDefault()
        const items = visibleButtons()
        const at = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(at + step + items.length) % items.length]?.focus()
      }
    }
  }
  const visibleButtons = (): HTMLButtonElement[] => [...panel.querySelectorAll<HTMLButtonElement>('button')]
    .filter(button => !button.disabled && !button.closest('[hidden]'))
  const press = (): void => {
    if (close(true)) return
    beforeOpen()
    panel.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    release = anchorPopover(panel, trigger, { placement: 'below-end', gap: 8 })
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', keyboard, true)
    visibleButtons()[0]?.focus({ preventScroll: true })
  }
  trigger.addEventListener('click', press)
  return { trigger, panel, close, dispose: () => { close(); trigger.removeEventListener('click', press) } }
}
