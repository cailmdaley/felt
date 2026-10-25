import type { Channel, DocKey } from './documents.js'
import { sentFiles } from './SentFiles.js'
import './page-sheet.css'

const HISTORY_KEY = 'shuttlePageSheet'

/** Threads and dated sends, with modal focus containment and a browser-Back entry. */
export class PageSheet {
  readonly el = document.createElement('dialog')
  private readonly body = document.createElement('div')
  private readonly threads = document.createElement('div')
  private readonly list = document.createElement('div')
  private readonly heading = document.createElement('h2')
  private readonly token = `files:${Math.random().toString(36).slice(2)}`
  private model: { channel: Channel; selected: DocKey; fresh: ReadonlySet<DocKey> } | null = null
  private opener: HTMLElement | null = null
  private afterClose: (() => void) | null = null
  private pendingBack = false

  private readonly onChoose: (key: DocKey) => void
  constructor(_base: string, onChoose: (key: DocKey) => void) {
    this.onChoose = onChoose
    this.el.className = 'ws-page-sheet'
    this.el.dataset.part = 'page-sheet'
    this.el.setAttribute('aria-label', 'Threads and sent files')
    const panel = document.createElement('section'); panel.className = 'ws-page-sheet-panel'
    const close = document.createElement('button'); close.type = 'button'; close.className = 'ws-page-sheet-grabber'
    close.setAttribute('aria-label', 'Close sent files'); close.addEventListener('click', () => this.close())
    const head = document.createElement('div'); head.className = 'ws-page-sheet-head'; head.append(this.heading)
    this.body.className = 'ws-page-sheet-body'
    this.threads.className = 'ws-page-sheet-threads'
    this.body.append(this.threads, this.list); panel.append(close, head, this.body); this.el.append(panel)
    this.el.addEventListener('click', event => { if (event.target === this.el) this.close() })
    this.el.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    let start: number | null = null
    close.addEventListener('pointerdown', event => { start = event.clientY; close.setPointerCapture(event.pointerId) })
    close.addEventListener('pointerup', event => { if (start !== null && event.clientY - start > 44) this.close(); start = null })
    close.addEventListener('pointercancel', () => { start = null })
    window.addEventListener('popstate', this.pop)
    window.addEventListener('keydown', this.keydown, true)
  }
  get isOpen(): boolean { return this.el.open }
  update(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>): void {
    this.model = { channel, selected, fresh }
    if (this.isOpen) this.render()
  }
  show(opener: HTMLElement, threads: HTMLElement | null = null): void {
    if (this.isOpen || this.pendingBack || !this.model) return
    this.opener = opener
    this.threads.replaceChildren(...(threads ? [threads] : [])); this.threads.hidden = !threads
    this.heading.textContent = threads ? 'Threads and sent files' : 'Sent files'
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: this.token }, '')
    this.open()
  }
  private render(): void {
    if (!this.model) return
    const { channel, selected, fresh } = this.model
    this.list.replaceChildren(sentFiles(channel, selected, fresh, key => this.close(() => this.onChoose(key))))
  }
  private open(): void {
    this.render(); this.el.showModal(); this.body.scrollTop = 0
    this.el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    this.opener?.setAttribute('aria-expanded', 'true')
  }
  close(after?: () => void): void {
    if (!this.isOpen || this.pendingBack) return
    this.afterClose = after ?? null
    if (window.history.state?.[HISTORY_KEY] === this.token) { this.pendingBack = true; window.history.back() }
    else this.dismiss()
  }
  private dismiss(): void {
    if (this.el.open) this.el.close()
    this.pendingBack = false
    this.opener?.setAttribute('aria-expanded', 'false')
    if (this.opener?.isConnected && !this.opener.closest('[inert]')) this.opener.focus({ preventScroll: true })
    const after = this.afterClose; this.afterClose = null; after?.()
  }
  hide(): void {
    this.model = null; this.afterClose = null
    if (window.history.state?.[HISTORY_KEY] === this.token) {
      const state = { ...window.history.state }; delete state[HISTORY_KEY]; window.history.replaceState(state, '')
    }
    this.dismiss()
  }
  private readonly pop = (): void => {
    if (window.history.state?.[HISTORY_KEY] === this.token && this.model) { if (!this.isOpen) this.open() }
    else if (this.isOpen || this.pendingBack) this.dismiss()
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!this.isOpen) return
    event.stopImmediatePropagation()
    if (event.key === 'Escape') { event.preventDefault(); this.close() }
    if (event.key === 'Tab') {
      const buttons = [...this.el.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.checkVisibility())
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && (document.activeElement === first || !this.el.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !this.el.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
  }
  dispose(): void {
    this.hide(); window.removeEventListener('popstate', this.pop); window.removeEventListener('keydown', this.keydown, true); this.el.remove()
  }
}
