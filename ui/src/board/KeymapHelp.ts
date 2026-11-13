import '@ui-sdk/web/dialog'
import type { UiDialogElement } from '@ui-sdk/web/dialog'
import './keymap.css'
import './workspace/tokens.css'
import { helpSections, keyIntent, type KeySurface } from './keymap.js'
import { blockingDialogOpen } from './views/ViewRegistry.js'

/** One app-level overlay, available even when the reader owns the keystroke. */
export class KeymapHelp {
  private overlay: UiDialogElement | null = null
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
    const root = document.createElement('ui-dialog')
    const overlay = document.createElement('ui-dialog-content')
    overlay.setAttribute('aria-label', 'Keyboard shortcuts')
    overlay.className = 'kbn-keymap-overlay'
    const dialog = document.createElement('section')
    dialog.className = 'kbn-keymap-dialog'
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
    note.textContent = 'Bare keys work outside text fields. Esc or ? closes this guide.'
    dialog.append(header, note)
    const sections = document.createElement('div')
    sections.className = 'kbn-keymap-sections'
    for (const { title: name, note: aside, rows } of helpSections) {
      const section = document.createElement('section')
      const heading = document.createElement('h3')
      heading.textContent = name
      section.append(heading)
      if (aside) {
        const text = document.createElement('p')
        text.textContent = aside
        section.append(text)
      }
      const list = document.createElement('dl')
      for (const row of rows) {
        const key = document.createElement('dt')
        for (const label of row.keys) {
          const kbd = document.createElement('kbd')
          kbd.textContent = label
          key.append(kbd)
        }
        const description = document.createElement('dd')
        description.textContent = row.label
        list.append(key, description)
      }
      section.append(list)
      sections.append(section)
    }
    dialog.append(sections)
    overlay.append(dialog)
    overlay.addEventListener('click', event => { if (event.target === overlay) this.close() })
    root.append(overlay)
    this.overlay = root
    document.body.append(root)
    void root.api.open().then(() => {
      if (this.overlay === root) this.overlay = null
      queueMicrotask(() => root.remove())
    })
  }
  close(): void {
    if (!this.overlay) return
    this.overlay.api.close()
  }
  dispose(): void { this.close(); window.removeEventListener('keydown', this.keydown, true) }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (this.overlay) {
      if (!event.isComposing && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat && event.key === '?') {
        event.preventDefault()
        this.close()
      }
      return
    }
    if (!this.enabled() || blockingDialogOpen() || keyIntent(event, this.surface()) !== 'help') return
    event.preventDefault()
    event.stopImmediatePropagation()
    this.open()
  }
}
