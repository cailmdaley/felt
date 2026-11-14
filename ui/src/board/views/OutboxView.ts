import { ago } from '../civilDay.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { composeOutbox, type HeldSpeech, type OutboxItem } from '../outbox.js'
import { docKey } from '../workspace/documents.js'
import { createViewPage } from './ViewPage.js'
import { keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './OutboxView.css'

const MARKS: Record<OutboxItem['kind'], string> = {
  ask: '<path d="M4 4h16v12H10l-5 4v-4H4z"/><path d="M10 8a2 2 0 0 1 4 0c0 2-2 2-2 4m0 2v.1"/>',
  review: '<path d="M6 3h9l4 4v14H6zM15 3v5h4M9 14l2 2 5-5"/>',
  file: '<path d="M8 3h8l4 4v14H8zM16 3v5h4M4 7v14M11 12h6m-6 4h6"/>',
  spoken: '<path d="M3 10h4l5-5v14l-5-5H3zM16 8q5 4 0 8m3-11q8 7 0 14"/>',
}

/** A quiet reading list. Only a deliberate click moves a page or releases speech. */
export class OutboxView implements TemporalView {
  readonly id = 'outbox' as const
  readonly title = 'Outbox'
  readonly hotkey = '5'
  private ctx: ViewContext | null = null
  private list: HTMLElement | null = null
  private note: HTMLElement | null = null
  private held: HeldSpeech[] = []
  private dismissed = new Set<string>()
  private pending = new Set<string>()
  private reachMs = 14 * 86_400_000
  private items: OutboxItem[] = []
  private rows = new Map<string, HTMLElement>()
  private unsubscribe?: () => void
  private reading = false
  private loaded = false
  private generation = 0
  private closeFile?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    const page = createViewPage('Outbox')
    page.root.classList.add('kbn-outbox')
    this.list = document.createElement('div')
    this.list.setAttribute('role', 'list')
    this.note = document.createElement('p')
    this.note.className = 'kbn-outbox-note'
    if (!this.loaded) this.note.textContent = 'Reading the Outbox…'
    const keys = document.createElement('span')
    keys.className = 'kbn-outbox-keys'
    keys.textContent = 'j / k to move · Enter to open · x to dismiss'
    page.titleRow.append(keys)
    page.body.append(this.list, this.note)
    host.append(page.root)
    this.unsubscribe = ctx.sends?.subscribe(() => this.draw())
    this.refresh(ctx)
  }
  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    this.draw()
    void ctx.sends?.refresh().catch(() => { this.status('Sent files unavailable — showing the last read.') })
    void this.read()
  }
  private async read(): Promise<void> {
    if (this.reading || !this.ctx) return
    this.reading = true
    const generation = this.generation, base = this.ctx.shuttleBase
    const reads = await Promise.allSettled([
      getDaemonJson<{ dismissed: string[]; reach_ms: number }>(`${base}/api/v1/outbox/dismissed`),
      getDaemonJson<{ held: HeldSpeech[] }>(`${base}/api/v1/speak`),
    ])
    if (generation !== this.generation) return
    this.reading = false
    this.loaded = true
    const [dismissals, speech] = reads
    if (dismissals.status === 'fulfilled') {
      this.dismissed = new Set(dismissals.value.dismissed)
      this.reachMs = dismissals.value.reach_ms
      for (const key of this.dismissed) this.pending.delete(key)
    }
    if (speech.status === 'fulfilled') this.held = speech.value.held
    this.status(reads.some(read => read.status === 'rejected') ? 'Some Outbox sources are unavailable — showing the last read.' : '')
    this.draw()
  }
  private status(text: string): void { if (this.note) this.note.textContent = text }
  private draw(): void {
    if (!this.ctx || !this.list || !this.loaded) return
    const now = Date.now()
    this.items = composeOutbox({ cards: [...this.ctx.cards, ...(this.ctx.response.threads ?? [])], files: this.ctx.sends?.files ?? [], held: this.held, dismissed: new Set([...this.dismissed, ...this.pending]), reachMs: this.reachMs, now })
    const visible = new Set(this.items.map(item => item.key))
    for (const [key, row] of this.rows) if (!visible.has(key)) { row.remove(); this.rows.delete(key) }
    this.list.querySelector('.kbn-outbox-empty')?.remove()
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]
      let row = this.rows.get(item.key)
      if (!row) {
        row = this.row(item.key)
        this.rows.set(item.key, row)
      }
      row.querySelector('.kbn-outbox-name')!.textContent = item.name
      row.querySelector('.kbn-outbox-text')!.textContent = item.text.replace(/\s+/g, ' ')
      row.querySelector('.kbn-outbox-age')!.textContent = ago(item.at, now)
      row.querySelector('.kbn-outbox-open')!.setAttribute('aria-label', `${item.name}: ${item.kind}, ${item.text}`)
      const mark = row.querySelector('.kbn-outbox-mark')!
      mark.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${MARKS[item.kind]}</svg>`
      mark.setAttribute('title', item.kind)
      // Keep unchanged nodes in place: a poll must not take focus from a row.
      if (this.list.children[i] !== row) this.list.insertBefore(row, this.list.children[i] ?? null)
    }
    if (!this.items.length) {
      const empty = document.createElement('p')
      empty.className = 'kbn-outbox-empty'
      empty.textContent = 'Nothing waiting in the Outbox.'
      this.list.append(empty)
    }
  }
  private row(key: string): HTMLElement {
    const row = document.createElement('div')
    row.className = 'kbn-outbox-row'
    row.setAttribute('role', 'listitem')
    row.dataset.key = key
    const open = document.createElement('button')
    open.type = 'button'; open.className = 'kbn-outbox-open'
    for (const part of ['mark', 'name', 'text', 'age']) {
      const span = document.createElement('span')
      span.className = `kbn-outbox-${part}`
      if (part === 'mark') span.setAttribute('aria-hidden', 'true')
      open.append(span)
    }
    open.addEventListener('click', () => { const item = this.items.find(item => item.key === key); if (item) this.open(item) })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'; dismiss.className = 'kbn-outbox-dismiss'
    dismiss.textContent = '×'; dismiss.setAttribute('aria-label', 'Dismiss item'); dismiss.title = 'Dismiss (x)'
    dismiss.addEventListener('click', () => { void this.dismiss(key) })
    row.append(open, dismiss)
    return row
  }
  private open(item: OutboxItem): void {
    const ctx = this.ctx
    if (!ctx) return
    if (item.kind === 'file') {
      if (item.card && ctx.workspace) ctx.workspace.openPage(item.card, docKey(item.file.host ?? '', item.file.fullPath, item.card.originId, item.card.fiberDir))
      else this.showFile(item)
    } else if (item.card) {
      // openFromDesk reaches this card: voice's in-view target releases its held lines.
      if (ctx.workspace) ctx.workspace.openFromDesk(item.card)
      else ctx.openCard(item.card.id)
    }
  }
  private showFile(item: Extract<OutboxItem, { kind: 'file' }>): void {
    this.closeFile?.()
    const dialog = document.createElement('dialog')
    dialog.className = 'kbn-outbox-file'
    dialog.setAttribute('aria-label', item.file.basename)
    const close = document.createElement('button')
    close.type = 'button'; close.textContent = 'Close'; close.addEventListener('click', () => dialog.close())
    const viewer = buildFileViewer(this.ctx!.shuttleBase, item.file.fullPath, item.file.host ?? '', undefined, undefined, { active: true })
    dialog.append(close, viewer)
    this.closeFile = () => { disposeFileViewer(viewer); dialog.remove(); this.closeFile = undefined }
    dialog.addEventListener('close', () => this.closeFile?.(), { once: true })
    document.body.append(dialog)
    dialog.showModal()
  }
  private async dismiss(key: string): Promise<void> {
    const item = this.items.find(item => item.key === key), ctx = this.ctx
    if (!item || !ctx) return
    const index = this.items.indexOf(item)
    const focused = this.rows.get(key)?.contains(document.activeElement)
    this.pending.add(key)
    this.draw()
    if (focused) this.focus(Math.min(index, this.items.length - 1))
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/outbox/dismiss', { key, ...(item.fiber ? { fiber: item.fiber } : {}) })
    } catch {
      this.pending.delete(key)
      this.draw()
      this.status('Dismissal could not be saved. The item is still here.')
    }
  }
  private focus(index: number): void {
    const item = this.items[index]
    const row = item && this.rows.get(item.key)
    row?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }
  keydown(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey || keystrokeIsSpokenFor()) return false
    const key = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.kbn-outbox-row')?.dataset.key
    const index = this.items.findIndex(item => item.key === key)
    if (['j', 'ArrowDown', 'k', 'ArrowUp', 'g', 'G'].includes(event.key)) {
      const next = event.key === 'g' ? 0 : event.key === 'G' ? this.items.length - 1 : index < 0 ? 0 : index + (['j', 'ArrowDown'].includes(event.key) ? 1 : -1)
      this.focus(Math.max(0, Math.min(this.items.length - 1, next)))
      return true
    }
    if (index < 0 || event.repeat) return false
    if (event.key === 'x' || event.key === 'Delete') { void this.dismiss(this.items[index].key); return true }
    if (['Enter', 'o', 'l', 'ArrowRight'].includes(event.key)) {
      if (event.key === 'Enter' && (document.activeElement as HTMLElement)?.classList.contains('kbn-outbox-dismiss')) return false
      this.open(this.items[index]); return true
    }
    return false
  }
  unmount(): void {
    this.generation++
    this.reading = false
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.closeFile?.()
    this.ctx = null; this.list = null; this.note = null
    this.rows.clear()
  }
}
registerView(new OutboxView())
