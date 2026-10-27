import type { Channel, DocKey } from './documents.js'
import { sentFiles } from './SentFiles.js'
import './page-sheet.css'

const HISTORY_KEY = 'shuttlePageSheet'

/** The phone's threads panel: the family, then its sent files, with modal focus containment and a browser-Back entry. */
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
  private expanded = false

  private readonly onChoose: (key: DocKey) => void
  private readonly onVisibility: () => void
  constructor(_base: string, onChoose: (key: DocKey) => void, onVisibility = (): void => {}) {
    this.onChoose = onChoose
    this.onVisibility = onVisibility
    this.el.className = 'ws-page-sheet'
    this.el.dataset.part = 'page-sheet'
    this.el.setAttribute('aria-label', 'Threads and sent files')
    const panel = document.createElement('section'); panel.className = 'ws-page-sheet-panel'; panel.dataset.part = 'page-sheet-panel'
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
    window.addEventListener('resize', this.position)
    window.addEventListener('popstate', this.pop)
    this.el.addEventListener('keydown', this.keydown)
  }
  get isOpen(): boolean { return this.el.open }
  update(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>): void {
    if (this.model && (this.model.channel.uid !== channel.uid || this.model.channel.owner !== channel.owner)) this.expanded = false
    this.model = { channel, selected, fresh }
    if (this.isOpen) this.render()
  }
  show(opener: HTMLElement, threads: HTMLElement | null = null): void {
    if (this.isOpen || this.pendingBack || !this.model) return
    this.opener = opener
    this.threads.replaceChildren(...(threads ? [threads] : [])); this.threads.hidden = !threads
    this.heading.textContent = threads ? 'Threads and sent files' : 'Sent files'
    this.el.setAttribute('aria-label', this.heading.textContent)
    this.el.querySelector('button')?.setAttribute('aria-label', 'Close threads and files')
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: this.token }, '')
    this.open()
  }
  private render(): void {
    if (!this.model) return
    const { channel, selected, fresh } = this.model
    const files = sentFiles(channel, selected, fresh, key => this.close(() => this.onChoose(key)), this.expanded, expanded => { this.expanded = expanded; this.render(); this.list.querySelector<HTMLElement>('[data-part="sent-files-more"]')?.focus({ preventScroll: true }) })
    if (this.threads.hidden) files.querySelector('h3')?.remove()
    this.list.replaceChildren(files)
  }
  private open(): void {
    this.render(); this.position(); this.el.showModal(); this.body.scrollTop = 0; this.onVisibility()
    this.el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    this.opener?.setAttribute('aria-expanded', 'true')
  }
  private readonly position = (): void => {
    const card = this.el.closest('.ws-reader')?.querySelector('.ws-page.ws-selected')?.getBoundingClientRect()
    if (!card) return
    const width = Math.min(480, card.width - 32)
    this.el.style.setProperty('--ws-files-left', `${card.right - width - 16}px`)
    this.el.style.setProperty('--ws-files-top', `${card.top + 52}px`)
    this.el.style.setProperty('--ws-files-width', `${width}px`)
    this.el.style.setProperty('--ws-files-height', `${Math.max(120, card.height - 72)}px`)
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
    this.onVisibility()
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
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); this.close() }
    if (event.key === 'Tab') {
      const buttons = [...this.el.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex="0"]')].filter(button => button.checkVisibility() && !button.matches(':disabled'))
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && (document.activeElement === first || !this.el.contains(document.activeElement))) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !this.el.contains(document.activeElement))) { event.preventDefault(); first?.focus() }
    }
  }
  dispose(): void {
    this.hide(); window.removeEventListener('resize', this.position); window.removeEventListener('popstate', this.pop); this.el.removeEventListener('keydown', this.keydown); this.el.remove()
  }
}
