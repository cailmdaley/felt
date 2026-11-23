import '@ui-sdk/web/dialog'
import './RestPopover.css'
import './ConfirmDialog.css'
import { onScrimPress } from './dismissGesture.js'

export interface ConfirmDialog {
  /** True once confirmed; false when cancelled, dismissed or closed. Settles with the dialog gone and focus back where it was. */
  answer: Promise<boolean>
  close(): void
}

/**
 * Ask before an act, in the page: a centered dialog with Cancel and the act's
 * own word. Enter confirms, Esc or a press outside cancels. A page in a Rex
 * pane needs it, its web view answering `window.confirm` false unasked.
 */
export function confirmDialog(question: string, act: string): ConfirmDialog {
  const dialog = document.createElement('ui-dialog')
  const scrim = document.createElement('ui-dialog-content')
  scrim.setAttribute('aria-label', act)
  scrim.setAttribute('initial-focus', '.kbn-confirm-yes')
  scrim.className = 'kbn-rest-scrim'
  const panel = document.createElement('div')
  panel.className = 'kbn-confirm'
  panel.tabIndex = -1
  const words = document.createElement('p')
  words.className = 'kbn-confirm-question'
  words.textContent = question
  const buttons = document.createElement('div')
  buttons.className = 'kbn-confirm-buttons'
  const button = (className: string, text: string): HTMLButtonElement => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = className
    el.textContent = text
    return el
  }
  const cancel = button('kbn-confirm-no', 'Cancel')
  const confirm = button('kbn-confirm-yes', act)
  buttons.append(cancel, confirm)
  panel.append(words, buttons)
  scrim.append(panel)
  dialog.append(scrim)
  document.body.append(dialog)

  let confirmed = false
  const close = (): void => { dialog.api.close() }
  const yes = (): void => { confirmed = true; close() }
  cancel.addEventListener('click', close)
  confirm.addEventListener('click', yes)
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.target === cancel) return
    event.preventDefault()
    event.stopPropagation()
    // The Enter that asked, still held, is no answer.
    if (!event.repeat) yes()
  })
  onScrimPress(scrim, close)
  const answer = dialog.api.open().then(() => new Promise<boolean>(resolve => queueMicrotask(() => {
    dialog.remove()
    resolve(confirmed)
  })))
  return { answer, close }
}
