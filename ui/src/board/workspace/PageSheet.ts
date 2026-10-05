import { extractEmbeds } from '../attachments.js'
import { Thumbnail } from './Thumbnail.js'
import { documentLabelMetadata, type Channel, type DocKey } from './documents.js'
import './page-sheet.css'

const HISTORY_KEY = 'shuttlePageSheet'
interface SheetModel { channel: Channel; selected: DocKey; fresh: ReadonlySet<DocKey> }
type Row = { button: HTMLButtonElement; title: HTMLElement; summary: HTMLElement; thumb: Thumbnail }

/** A phone page picker with native modal focus containment and its own browser-Back entry. */
export class PageSheet {
  readonly el = document.createElement('dialog')
  private readonly panel = document.createElement('section')
  private readonly list = document.createElement('div')
  private readonly rows = new Map<DocKey, Row>()
  private readonly token = `pages:${Math.random().toString(36).slice(2)}`
  private model: SheetModel | null = null
  private afterClose: (() => void) | null = null
  private opener: HTMLElement | null = null
  private pendingBack = false
  private readonly onChoose: (key: DocKey) => void
  private readonly base: string

  constructor(base: string, onChoose: (key: DocKey) => void) {
    this.base = base; this.onChoose = onChoose
    this.el.className = 'ws-page-sheet'
    this.el.setAttribute('aria-label', 'Pages in this constitution')
    this.panel.className = 'ws-page-sheet-panel'
    const grabber = document.createElement('button')
    grabber.type = 'button'; grabber.className = 'ws-page-sheet-grabber'
    grabber.setAttribute('aria-label', 'Close pages')
    grabber.addEventListener('click', () => this.close())
    const heading = document.createElement('h2'); heading.textContent = 'Pages'
    this.list.className = 'ws-page-sheet-list'
    this.panel.append(grabber, heading, this.list)
    this.el.append(this.panel)
    this.el.addEventListener('click', event => { if (event.target === this.el) this.close() })
    this.el.addEventListener('cancel', event => { event.preventDefault(); this.close() })
    this.list.addEventListener('scroll', () => { for (const row of this.rows.values()) row.thumb.schedule() }, { passive: true })
    let drag: { id: number; y: number } | null = null
    let suppressClick = false
    grabber.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !event.isPrimary) return
      suppressClick = false; drag = { id: event.pointerId, y: event.clientY }
      grabber.setPointerCapture(event.pointerId)
    })
    grabber.addEventListener('pointermove', event => {
      if (drag?.id !== event.pointerId) return
      const distance = Math.max(0, event.clientY - drag.y)
      if (distance > 12) suppressClick = true
      this.panel.style.setProperty('--ws-sheet-drag', `${distance}px`)
    })
    const finish = (event: PointerEvent): void => {
      if (drag?.id !== event.pointerId) return
      const close = event.type === 'pointerup' && event.clientY - drag.y >= 44
      drag = null; this.panel.style.removeProperty('--ws-sheet-drag')
      if (close) this.close()
    }
    grabber.addEventListener('pointerup', finish)
    grabber.addEventListener('pointercancel', finish)
    grabber.addEventListener('click', event => { if (suppressClick) { suppressClick = false; event.preventDefault(); event.stopImmediatePropagation() } }, true)
    window.addEventListener('popstate', this.pop)
    window.addEventListener('keydown', this.keydown, true)
  }

  get isOpen(): boolean { return this.el.open }

  update(channel: Channel, selected: DocKey, fresh: ReadonlySet<DocKey>): void {
    this.model = { channel, selected, fresh }
    if (this.isOpen) this.render()
  }

  show(opener: HTMLElement): void {
    if (this.isOpen || this.pendingBack || !this.model) return
    this.opener = opener
    window.history.pushState({ ...window.history.state, [HISTORY_KEY]: this.token }, '')
    this.open()
  }

  private open(): void {
    this.render()
    this.el.showModal()
    const selected = this.model && this.rows.get(this.model.selected)?.button
    selected?.focus({ preventScroll: true })
    selected?.scrollIntoView({ block: 'nearest' })
    for (const row of this.rows.values()) row.thumb.schedule()
    this.opener?.setAttribute('aria-expanded', 'true')
  }

  /** The callback runs after the sheet's history entry is removed, so selection edits the reader entry. */
  close(after?: () => void): void {
    if (!this.isOpen || this.pendingBack) return
    this.afterClose = after ?? null
    if (window.history.state?.[HISTORY_KEY] === this.token) {
      this.pendingBack = true
      window.history.back()
    } else this.dismiss()
  }

  private dismiss(): void {
    if (this.el.open) this.el.close()
    this.pendingBack = false
    this.opener?.setAttribute('aria-expanded', 'false')
    if (this.opener?.isConnected && !this.opener.closest('[inert]')) this.opener.focus({ preventScroll: true })
    for (const row of this.rows.values()) row.thumb.dispose()
    this.rows.clear(); this.list.replaceChildren()
    const after = this.afterClose; this.afterClose = null
    after?.()
  }

  /** Navigation away invalidates a Forward entry for this sheet. */
  hide(): void {
    this.model = null; this.afterClose = null
    if (window.history.state?.[HISTORY_KEY] === this.token) {
      const state = { ...window.history.state }; delete state[HISTORY_KEY]
      window.history.replaceState(state, '')
    }
    this.dismiss()
  }

  private render(): void {
    const model = this.model
    if (!model) return
    const { channel, selected, fresh } = model
    const keys = new Set(channel.documents.map(doc => doc.key))
    for (const [key, row] of this.rows) if (!keys.has(key)) { row.thumb.dispose(); row.button.remove(); this.rows.delete(key) }
    channel.documents.forEach((doc, index) => {
      let row = this.rows.get(doc.key)
      if (!row) {
        const button = document.createElement('button')
        button.type = 'button'; button.className = 'ws-page-sheet-row'; button.dataset.key = doc.key
        const thumb = new Thumbnail({ key: `sheet:${doc.key}`, shuttleBase: this.base,
          file: doc.kind === 'fiber' ? undefined : { fullPath: doc.path, owner: doc.owner, basename: doc.name },
          fallback: channel.outcome ?? channel.name, captioned: true, className: 'ws-page-sheet-thumb',
          // At 56 px, PDFs use their designed face instead of mounting a native viewer.
          priority: () => doc.kind !== 'pdf' && this.isOpen && this.onScreen(button) ? 4 : 0,
          distance: () => Math.abs(index - channel.documents.findIndex(d => d.key === this.model?.selected)),
        })
        if (doc.kind === 'fiber') thumb.setProse(extractEmbeds(channel.body).body || channel.outcome || '', channel.labels[index])
        const text = document.createElement('span'); text.className = 'ws-page-sheet-text'
        const title = document.createElement('span'); title.className = 'ws-page-sheet-title'
        const summary = document.createElement('span'); summary.className = 'ws-page-sheet-summary'
        text.append(title, summary); button.append(thumb.el, text)
        button.addEventListener('click', () => this.close(() => this.onChoose(doc.key)))
        row = { button, title, summary, thumb }; this.rows.set(doc.key, row)
      }
      const metadata = documentLabelMetadata(doc, channel.labels[index], channel.owner)
      row.title.textContent = doc.kind === 'fiber' ? channel.labels[index] : metadata.title
      row.summary.textContent = metadata.summary
      row.button.title = doc.path
      if (doc.key === selected) row.button.setAttribute('aria-current', 'page')
      else row.button.removeAttribute('aria-current')
      row.button.classList.toggle('ws-page-sheet-fresh', fresh.has(doc.key))
      row.button.setAttribute('aria-label', `${row.title.textContent}${fresh.has(doc.key) ? ', new arrival' : ''}`)
      const at = this.list.children[index]
      if (at !== row.button) this.list.insertBefore(row.button, at ?? null)
      row.thumb.schedule()
    })
  }

  private onScreen(button: HTMLElement): boolean {
    const item = button.getBoundingClientRect(), list = this.list.getBoundingClientRect()
    return item.bottom > list.top && item.top < list.bottom
  }

  private readonly pop = (): void => {
    if (window.history.state?.[HISTORY_KEY] === this.token && this.model) {
      if (!this.isOpen) this.open()
    } else if (this.isOpen || this.pendingBack) this.dismiss()
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!this.isOpen) return
    // The dialog owns every key while open; focus wraps without entering browser chrome.
    this.el.closest('.ws-reader')?.classList.add('ws-keyboard')
    event.stopImmediatePropagation()
    if (event.key === 'Tab') {
      const buttons = [...this.el.querySelectorAll<HTMLButtonElement>('button')].filter(button => !button.closest('[inert]') && button.checkVisibility())
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && (document.activeElement === first || !this.el.contains(document.activeElement))) {
        event.preventDefault(); last?.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !this.el.contains(document.activeElement))) {
        event.preventDefault(); first?.focus()
      }
    }
    if (event.key === 'Escape') { event.preventDefault(); this.close() }
  }

  dispose(): void {
    this.hide()
    window.removeEventListener('popstate', this.pop)
    window.removeEventListener('keydown', this.keydown, true)
    this.el.remove()
  }
}
