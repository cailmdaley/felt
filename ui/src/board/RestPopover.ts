import type { KanbanCard } from './KanbanTypes.js'
import { anchorPopover } from './workspace/anchoredPopover.js'

/** A blank date deliberately rests without a return day. */
export function restPopover(card: KanbanCard, anchor: HTMLElement, submit: (until: string) => Promise<void>): () => void {
  const previous = document.activeElement as HTMLElement | null
  const panel = document.createElement('form')
  panel.className = 'kbn-rest-popover'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', `Rest ${card.name}`)
  const label = document.createElement('label')
  label.textContent = 'Rest until'
  const input = document.createElement('input')
  input.type = 'date'
  input.setAttribute('aria-label', 'Return date')
  const hint = document.createElement('small')
  hint.textContent = 'Leave empty to rest undated · Enter to rest'
  const button = document.createElement('button')
  button.type = 'submit'
  button.textContent = 'Rest'
  label.append(input)
  panel.append(label, hint, button)
  // Keep the board's palette without inheriting an inert Desk or reader body.
  const root = anchor.closest('.kbn-modal') ?? document.body
  root.append(panel)
  const release = anchorPopover(panel, anchor, { gap: 8 })
  const close = (): void => {
    release()
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', escape, true)
    panel.remove()
    if (previous?.isConnected) previous.focus({ preventScroll: true })
  }
  const outside = (event: PointerEvent): void => { if (!panel.contains(event.target as Node)) close() }
  const escape = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close() }
  }
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); panel.requestSubmit() }
  })
  panel.addEventListener('submit', event => {
    event.preventDefault()
    if (!input.checkValidity()) return
    const until = input.value
    close()
    void submit(until)
  })
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', escape, true)
  input.focus()
  return close
}
