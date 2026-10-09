import './keymap.css'
import './workspace/tokens.css'
import { bindingKeyLabel, keyIntent, surfaceBindings, type KeySurface } from './keymap.js'
import { VERDICT_DELAY_MS } from './workspace/verdictDelay.js'
import { blockingDialogOpen } from './views/ViewRegistry.js'

/** One app-level overlay, available even when the reader owns the keystroke. */
export class KeymapHelp {
  private overlay: HTMLElement | null = null
  private returnFocus: HTMLElement | null = null
  private surface: () => KeySurface
  private enabled: () => boolean
  constructor(surface: () => KeySurface, enabled: () => boolean = () => true) {
    this.surface = surface
    this.enabled = enabled
    window.addEventListener('keydown', this.keydown, true)
  }
  get isOpen(): boolean { return this.overlay !== null }
  open(): void {
    if (this.overlay) return
    this.returnFocus = document.activeElement as HTMLElement | null
    const overlay = document.createElement('div')
    overlay.className = 'kbn-keymap-overlay'
    const dialog = document.createElement('section')
    dialog.className = 'kbn-keymap-dialog'
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('data-state', 'open')
    dialog.setAttribute('aria-label', 'Keyboard shortcuts')
    const header = document.createElement('header')
    const title = document.createElement('h2')
    title.textContent = 'Keyboard shortcuts'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'kbn-keymap-close'
    close.setAttribute('aria-label', 'Close')
    close.textContent = '×'
    close.addEventListener('click', () => this.close())
    header.append(title, close)
    const note = document.createElement('p')
    note.textContent = `Bare keys work outside fields, without ⌘/Ctrl or IME composition. Verdict keys write after ${VERDICT_DELAY_MS / 1000} s; Undo or z cancels the latest pending verdict, even after navigation. Esc or ? closes this guide.`
    dialog.append(header, note)
    const sections = document.createElement('div')
    sections.className = 'kbn-keymap-sections'
    for (const surface of ['desk', 'overview', 'reader'] as const) {
      const section = document.createElement('section')
      const heading = document.createElement('h3')
      heading.textContent = surface === 'desk' ? 'Desk' : surface === 'overview' ? 'Overview' : 'Reader'
      const list = document.createElement('dl')
      for (const binding of surfaceBindings[surface]) {
        const key = document.createElement('dt')
        const kbd = document.createElement('kbd')
        kbd.textContent = bindingKeyLabel(binding)
        key.append(kbd)
        const description = document.createElement('dd')
        description.textContent = binding.label
        list.append(key, description)
      }
      section.append(heading, list)
      sections.append(section)
    }
    dialog.append(sections)
    overlay.append(dialog)
    overlay.addEventListener('click', event => { if (event.target === overlay) this.close() })
    this.overlay = overlay
    document.body.append(overlay)
    close.focus()
  }
  close(): void {
    if (!this.overlay) return
    this.overlay.remove()
    this.overlay = null
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true })
    this.returnFocus = null
  }
  dispose(): void { this.close(); window.removeEventListener('keydown', this.keydown, true) }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (this.overlay) {
      event.stopImmediatePropagation()
      if (!event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && (event.key === 'Escape' || event.key === '?')) {
        event.preventDefault()
        this.close()
      } else if (event.key === 'Tab') {
        event.preventDefault()
        this.overlay.querySelector<HTMLButtonElement>('button')?.focus()
      }
      return
    }
    if (!this.enabled() || blockingDialogOpen() || keyIntent(event, this.surface()) !== 'help') return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.open()
  }
}
