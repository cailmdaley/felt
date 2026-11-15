import { announce } from '@ui-sdk/core'
import { ago } from '../civilDay.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { composeAudience, setAsideKey, type Block, type HeldSpeech, type Office } from '../outbox.js'
import type { SentFile } from '../sentFiles.js'
import { stateDot } from '../stateDot.js'
import { cardNamed, THREAD_LABEL, threadState } from '../threads.js'
import { fileBytesUrl, renderMarkdown } from '../utils.js'
import { COMPANION_NAMES, docKey } from '../workspace/documents.js'
import { renderFiberMarkdown } from '../workspace/FiberProse.js'
import { readFiber } from '../workspace/fiberSource.js'
import { charters } from '../workspace/RolePage.js'
import { createViewPage } from './ViewPage.js'
import { keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './OutboxView.css'

const SEEN = 'shuttle.outbox.office-seen:'
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
const blockKey = (block: Block): string => `${block.kind}:${fiberOf(block.card)}:${block.at}`
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const button = (className: string, text: string, onClick: () => void): HTMLButtonElement => {
  const node = el('button', className, text)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}
function lastSeen(key: string): number | undefined {
  try { const value = Number(localStorage.getItem(SEEN + key) ?? NaN); return Number.isFinite(value) ? value : undefined } catch { return undefined }
}
function markSeen(key: string, at: number): void {
  try { localStorage.setItem(SEEN + key, String(at)) } catch { /* Marks are a convenience. */ }
}

/**
 * The Outbox: an audience with the offices blocked on the human. One office's
 * letter fills the page (what it needs, from which card, beside that card's
 * tapestry), the waiting offices run down the rail, and a reply goes to the
 * card that asked before the next office comes up.
 */
export class OutboxView implements TemporalView {
  readonly id = 'outbox' as const
  readonly title = 'Outbox'
  readonly hotkey = '5'
  private ctx: ViewContext | null = null
  private rail: HTMLOListElement | null = null
  private letter: HTMLElement | null = null
  private paper: HTMLElement | null = null
  private tapestry: HTMLElement | null = null
  private reply: HTMLTextAreaElement | null = null
  private replyTo: HTMLElement | null = null
  private note: HTMLElement | null = null
  private offices: Office[] = []
  private current: string | null = null
  private target: string | null = null
  private held: HeldSpeech[] = []
  private dismissed: string[] = []
  private pending: string[] = []
  private names = new Map<string, string>()
  private reachMs = 14 * 86_400_000
  private readonly replied = new Set<string>()
  private readonly tempering = new Set<string>()
  /** When each office was last read before this visit to it, for the marks of what is new. */
  private readonly before = new Map<string, number>()
  private letterSig = ''
  private tapestryFor = ''
  private viewer: HTMLElement | null = null
  private loaded = false
  private reading = false
  private readGeneration = 0
  private tapestryGeneration = 0
  private form: HTMLFormElement | null = null
  private unsubscribe?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    const page = createViewPage('Outbox')
    page.root.classList.add('kbn-audience')
    const keys = el('span', 'kbn-aud-keys', 'j / k between offices · Enter to reply · Esc to leave it')
    page.titleRow.append(keys)
    const layout = el('div', 'kbn-aud')
    this.rail = el('ol', 'kbn-aud-rail')
    this.rail.setAttribute('aria-label', 'Offices waiting on you')
    const reading = el('div', 'kbn-aud-reading')
    this.letter = el('article', 'kbn-aud-letter')
    this.letter.tabIndex = -1
    this.paper = el('div', 'kbn-aud-paper')
    this.tapestry = el('div', 'kbn-aud-tapestry')
    this.letter.append(this.paper, this.tapestry)
    reading.append(this.letter, this.replyBar())
    layout.append(this.rail, reading)
    this.note = el('p', 'kbn-aud-note', 'Reading the Outbox…')
    this.note.setAttribute('role', 'status')
    page.body.append(this.note, layout)
    host.append(page.root)
    this.unsubscribe = ctx.sends?.subscribe(() => this.draw())
    void charters(ctx.shuttleBase).then(list => {
      this.names = new Map(list.flatMap(charter => charter.name ? [[charter.slug, charter.name] as [string, string]] : []))
      this.draw()
    }).catch(() => {})
    this.refresh(ctx)
  }
  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    this.draw()
    void ctx.sends?.refresh().catch(() => {})
    void this.read()
  }
  private async read(): Promise<void> {
    if (this.reading || !this.ctx) return
    this.reading = true
    const generation = this.readGeneration, base = this.ctx.shuttleBase
    const [dismissals, speech] = await Promise.allSettled([
      getDaemonJson<{ dismissed: string[]; reach_ms: number }>(`${base}/api/v1/outbox/dismissed`),
      getDaemonJson<{ held: HeldSpeech[] }>(`${base}/api/v1/speak`),
    ])
    if (generation !== this.readGeneration) return
    this.reading = false
    this.loaded = true
    if (dismissals.status === 'fulfilled') {
      this.dismissed = dismissals.value.dismissed
      this.reachMs = dismissals.value.reach_ms
      this.pending = this.pending.filter(key => !this.dismissed.includes(key))
    }
    if (speech.status === 'fulfilled') this.held = speech.value.held
    this.status(dismissals.status === 'rejected' || speech.status === 'rejected' ? 'Some Outbox sources are unavailable — showing the last read.' : '')
    this.draw()
  }
  private status(text: string): void { if (this.note) this.note.textContent = text }

  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.rail || !this.loaded) return
    const index = threadIndexFor(ctx.response)
    this.offices = composeAudience({
      cards: boardCards(ctx.response), parentOf: card => index.parentOf(card), names: this.names,
      files: ctx.sends?.files ?? [], held: this.held, dismissed: [...this.dismissed, ...this.pending], now: Date.now(), reachMs: this.reachMs,
    })
    if (!this.offices.some(office => office.key === this.current)) this.open(this.offices[0]?.key ?? null, false)
    this.drawRail()
    this.drawLetter()
  }
  /** Comes to an office: what it held when last read is kept for this visit's marks, and now it has been read. */
  private open(key: string | null, focus: boolean): void {
    if (key !== this.current) {
      this.current = key
      this.target = null
      if (key) { this.before.set(key, lastSeen(key) ?? -Infinity); markSeen(key, Date.now()) }
    }
    if (focus) { this.drawRail(); this.drawLetter(); this.letter?.focus({ preventScroll: true }); this.letter?.scrollTo?.({ top: 0 }) }
  }
  private get office(): Office | undefined { return this.offices.find(office => office.key === this.current) }
  /** The block the reply answers: the one chosen in the letter, else the longest waiting. */
  private get block(): Block | undefined {
    const office = this.office
    return office?.blocks.find(block => blockKey(block) === this.target) ?? office?.blocks.find(block => !this.replied.has(blockKey(block))) ?? office?.blocks[0]
  }

  private drawRail(): void {
    const rail = this.rail!, now = Date.now()
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.kbn-aud-office')?.dataset.office
    rail.replaceChildren(...this.offices.map(office => {
      const item = el('li', 'kbn-aud-rail-item')
      const pick = button('kbn-aud-office', '', () => this.open(office.key, true))
      pick.dataset.office = office.key
      const fresh = office.newest > (lastSeen(office.key) ?? -Infinity) || office.files.some(file => file.timestamp > (lastSeen(office.key) ?? -Infinity))
      pick.append(el('span', 'kbn-aud-office-name', office.name), el('span', 'kbn-aud-office-wait', `${office.blocks.length > 1 ? `${office.blocks.length} things · ` : ''}${ago(office.since, now)}`))
      pick.toggleAttribute('data-new', fresh && office.key !== this.current)
      if (office.key === this.current) pick.setAttribute('aria-current', 'true')
      pick.setAttribute('aria-label', `${office.name}: ${office.blocks.length} waiting, the oldest for ${ago(office.since, now)}`)
      item.append(pick)
      return item
    }))
    rail.hidden = !this.offices.length
    // A poll redraws the rail: the office that had focus keeps it.
    if (focused) rail.querySelector<HTMLElement>(`[data-office="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  }

  private drawLetter(): void {
    const office = this.office, block = this.block
    if (!this.ctx?.workspace?.isActive) this.ctx?.see?.(block?.card ?? null)
    this.form!.hidden = !block
    if (!office || !block) {
      this.letterSig = ''
      this.paper!.replaceChildren(el('p', 'kbn-aud-empty', 'Nobody is waiting on you.'))
      this.dropTapestry()
      return
    }
    const now = Date.now(), before = this.before.get(office.key) ?? -Infinity
    const sig = JSON.stringify([office.key, office.name, blockKey(block), office.blocks.map(blockKey), office.threads.map(card => [fiberOf(card), threadState(card), card.name]),
      office.files.map(file => [file.fullPath, file.timestamp]), office.held.map(line => [line.fiber_id, line.n, line.first]), [...this.replied], [...this.tempering]])
    if (sig !== this.letterSig) {
      this.letterSig = sig
      const paper = this.paper!
      const headline = el('header', 'kbn-aud-head')
      const waits = office.blocks.length === 1 ? 'One thing waits on you' : `${office.blocks.length} things wait on you`
      headline.append(el('h3', 'kbn-aud-name', office.name), el('p', 'kbn-aud-waits', waits))
      if (office.threads.length) headline.append(this.strip(office.threads))
      const blocks = el('ol', 'kbn-aud-blocks')
      blocks.append(...office.blocks.map(item => this.blockRow(item, item === block, item.at > before, now)))
      paper.replaceChildren(headline, blocks)
      const attached = this.attachments(office, before, now)
      if (attached) paper.append(attached)
    }
    // Ages tick in place, so a letter being read is never rebuilt under the reader.
    for (const age of this.paper!.querySelectorAll<HTMLElement>('[data-at]')) age.textContent = ago(Number(age.dataset.at), now)
    if (this.replyTo) this.replyTo.textContent = block.card.name
    this.drawTapestry(block.card, office)
  }
  private blockRow(block: Block, chosen: boolean, fresh: boolean, now: number): HTMLLIElement {
    const key = blockKey(block)
    const row = el('li', 'kbn-aud-block')
    row.dataset.kind = block.kind
    row.toggleAttribute('data-chosen', chosen && this.office!.blocks.length > 1)
    row.toggleAttribute('data-new', fresh)
    const meta = el('div', 'kbn-aud-block-meta')
    const from = button('kbn-aud-from', block.card.name, () => { this.target = key; this.drawLetter() })
    from.title = 'Reply to this'
    const age = el('span', 'kbn-aud-age', ago(block.at, now))
    age.dataset.at = String(block.at)
    meta.append(el('span', 'kbn-aud-kind', block.kind === 'ask' ? 'asks' : 'for your review'), from, age)
    const text = el('div', 'kbn-aud-text')
    text.innerHTML = renderMarkdown(block.text || (block.kind === 'review' ? 'Closed for your review.' : ''))
    const acts = el('div', 'kbn-aud-acts')
    acts.append(button('kbn-aud-act', 'Open', () => this.openCard(block.card)))
    if (block.kind === 'review') {
      const temper = button('kbn-aud-act', this.tempering.has(key) ? 'Tempering…' : 'Temper', () => { void this.temper(block) })
      temper.disabled = this.tempering.has(key)
      temper.title = 'Accept the work as done'
      acts.append(temper)
    }
    if (this.replied.has(key)) acts.append(el('span', 'kbn-aud-replied', 'Replied'))
    row.append(meta, text, acts)
    return row
  }
  /** The office's other threads, one dot and name each. */
  private strip(threads: KanbanCard[]): HTMLElement {
    const strip = el('ul', 'kbn-aud-threads')
    strip.setAttribute('aria-label', 'Its other threads')
    for (const card of threads) {
      const item = el('li', 'kbn-aud-thread')
      item.title = THREAD_LABEL[threadState(card)]
      item.append(stateDot(card, card => this.openCard(card)), el('span', 'kbn-aud-thread-name', card.name))
      strip.append(item)
    }
    return strip
  }
  private attachments(office: Office, before: number, now: number): HTMLElement | null {
    if (!office.files.length && !office.held.length) return null
    const box = el('section', 'kbn-aud-attached')
    box.setAttribute('aria-label', 'Sent with it')
    for (const line of office.held) {
      const said = button('kbn-aud-said', '', () => { const card = this.cardOf(line.fiber_id); if (card) this.openCard(card) })
      said.append(el('span', 'kbn-aud-said-text', `“${line.first}”`), el('span', 'kbn-aud-age', line.n > 1 ? `${line.n} lines held` : 'held'))
      said.toggleAttribute('data-new', (line.at ?? now) > before)
      said.title = 'Hear it on its card'
      box.append(said)
    }
    const files = el('div', 'kbn-aud-files')
    for (const file of office.files.slice(0, 8)) {
      const chip = button('kbn-aud-file', file.basename, () => this.openFile(file))
      chip.toggleAttribute('data-new', file.timestamp > before)
      chip.title = `Sent ${ago(file.timestamp, now)}`
      files.append(chip)
    }
    if (office.files.length) box.append(files)
    return box
  }

  /** The asking card's tapestry (or report) beneath the letter, else its constitution. Redrawn only when the card changes. */
  private drawTapestry(card: KanbanCard, office: Office): void {
    const key = `${card.originId}\0${fiberOf(card)}`
    if (key === this.tapestryFor) return
    this.dropTapestry()
    this.tapestryFor = key
    const generation = ++this.tapestryGeneration, base = this.ctx!.shuttleBase
    const label = el('p', 'kbn-aud-tapestry-label', `From ${card.name}`)
    this.tapestry!.append(label)
    void (async () => {
      let path: string | undefined
      for (const name of card.fiberDir ? COMPANION_NAMES : []) {
        const found = await head(fileBytesUrl(base, `${card.fiberDir}/${name}`, card.originId), RESOURCE_PRIORITY.neighbour)
        if (found?.exists) { path = `${card.fiberDir}/${name}`; break }
      }
      path ??= office.files.find(file => /^(tapestry|report)\.html$/i.test(file.basename) && cardNamed([card], file.uid ?? '', file.host ?? ''))?.fullPath
      if (generation !== this.tapestryGeneration) return
      if (path) {
        this.viewer = buildFileViewer(base, path, card.originId, undefined, undefined, { active: true })
        this.tapestry!.append(this.viewer)
        return
      }
      const entry = await readFiber(base, card.id, card.originId).catch(() => null)
      if (generation !== this.tapestryGeneration || !entry) return
      const prose = el('div', 'kbn-aud-prose ws-prose kbn-detail-prose')
      prose.innerHTML = renderFiberMarkdown(entry.fiber.body ?? '', '', card).html
      this.tapestry!.append(prose)
    })()
  }
  private dropTapestry(): void {
    this.tapestryGeneration++
    disposeFileViewer(this.viewer)
    this.viewer = null
    this.tapestryFor = ''
    this.tapestry?.replaceChildren()
  }

  private replyBar(): HTMLElement {
    const form = this.form = el('form', 'kbn-aud-reply')
    const label = el('label', 'kbn-aud-reply-label', 'Reply to ')
    this.replyTo = el('span', 'kbn-aud-reply-to')
    label.append(this.replyTo)
    this.reply = el('textarea', 'kbn-aud-reply-text')
    this.reply.rows = 2
    this.reply.placeholder = 'Write back…'
    label.htmlFor = this.reply.id = `kbn-aud-reply-${Math.random().toString(36).slice(2)}`
    this.reply.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() }
    })
    const send = el('button', 'kbn-aud-send', 'Send')
    send.type = 'submit'
    const later = button('kbn-aud-later', 'Not now', () => { void this.setAside() })
    later.title = 'Set this office aside until something new blocks in it'
    const top = el('div', 'kbn-aud-reply-top'), row = el('div', 'kbn-aud-reply-row')
    top.append(label, later)
    row.append(this.reply, send)
    form.append(top, row)
    form.addEventListener('submit', event => { event.preventDefault(); void this.send() })
    return form
  }
  private async send(): Promise<void> {
    const block = this.block, text = this.reply?.value.trim(), ctx = this.ctx
    if (!block || !text || !ctx) return
    const office = this.current
    this.reply!.disabled = true
    try {
      const answer = await postDaemonJson<{ delivered?: boolean | null; error?: string }>(ctx.shuttleBase, '/api/v1/deliver',
        { fiber_id: block.card.id, origin: block.card.originId, text, from: 'human' }, 'Reply failed')
      if (answer?.delivered === false) throw new Error(answer.error ?? `${block.card.name} did not receive it`)
      this.replied.add(blockKey(block))
      this.reply!.value = ''
      this.status(answer?.delivered === null ? `Sent to ${block.card.name}; its arrival is not yet confirmed.` : `Sent to ${block.card.name}.`)
      announce(`Sent to ${block.card.name}.`)
      if (this.current === office) this.step(1)
      ctx.requestRefresh()
    } catch (error) {
      this.status(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.reply) this.reply.disabled = false
    }
  }
  private async setAside(): Promise<void> {
    const office = this.office, ctx = this.ctx
    if (!office || !ctx) return
    const key = setAsideKey(office)
    this.pending.push(key)
    this.draw()
    this.open(this.current, true)
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/outbox/dismiss', { key, ...(office.seat ? { fiber: fiberOf(office.seat) } : {}) })
    } catch {
      this.pending = this.pending.filter(item => item !== key)
      this.draw()
      this.status(`${office.name} could not be set aside; it is still here.`)
    }
  }
  private async temper(block: Block): Promise<void> {
    const key = blockKey(block), ctx = this.ctx
    if (!ctx) return
    this.tempering.add(key)
    this.drawLetter()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/transition', { fiber_id: block.card.id, target: 'tempered', origin: block.card.originId }, 'Temper failed')
      ctx.requestRefresh()
    } catch (error) {
      this.status(`${block.card.name} was not tempered: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.tempering.delete(key)
      this.drawLetter()
    }
  }

  private cardOf(id: string): KanbanCard | undefined {
    return this.ctx ? boardCards(this.ctx.response).find(card => card.uid === id || card.id === id) : undefined
  }
  /** openFromDesk reaches the card as the Desk does, so voice's in-view target releases its held lines. */
  private openCard(card: KanbanCard): void {
    if (this.ctx?.workspace) this.ctx.workspace.openFromDesk(card)
    else this.ctx?.openCard(card.id)
  }
  private openFile(file: SentFile): void {
    const card = file.uid ? cardNamed(this.ctx ? boardCards(this.ctx.response) : [], file.uid, file.host ?? '') : undefined
    if (card && this.ctx?.workspace) this.ctx.workspace.openPage(card, docKey(file.host ?? '', file.fullPath, card.originId, card.fiberDir))
    else if (card) this.openCard(card)
  }
  private step(by: number): void {
    if (!this.offices.length) return
    const at = this.offices.findIndex(office => office.key === this.current)
    this.open(this.offices[Math.max(0, Math.min(this.offices.length - 1, at + by))].key, true)
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape' && document.activeElement === this.reply) { this.letter?.focus({ preventScroll: true }); return true }
    if (keystrokeIsSpokenFor()) return false
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === 'Enter' && !(document.activeElement as HTMLElement | null)?.closest('button, a') && this.office) { this.reply?.focus(); return true }
    return false
  }
  unmount(): void {
    this.dropTapestry()
    this.readGeneration++
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.reading = false
    this.ctx = null
    this.rail = this.letter = this.paper = this.tapestry = this.note = this.replyTo = null
    this.reply = null
    this.form = null
    this.letterSig = ''
  }
}
registerView(new OutboxView())
