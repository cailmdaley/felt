import { announce } from '@ui-sdk/core'
import { ago } from '../civilDay.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { isMobileViewport } from '../mobile.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { composeChannels, setAsideKey, type Channel, type HeldSpeech, type Waiting } from '../outbox.js'
import type { SentFile } from '../sentFiles.js'
import { stateDot } from '../stateDot.js'
import { cardNamed, THREAD_LABEL, threadState } from '../threads.js'
import { turnOf } from '../turn.js'
import { fileBytesUrl, renderMarkdown } from '../utils.js'
import { COMPANION_NAMES, docKey } from '../workspace/documents.js'
import { renderFiberMarkdown } from '../workspace/FiberProse.js'
import { readFiber } from '../workspace/fiberSource.js'
import { charters } from '../workspace/RolePage.js'
import { createViewPage } from './ViewPage.js'
import { keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './OutboxView.css'

const SEEN = 'shuttle.outbox.channel-seen:'
const RAIL = 'shuttle.outbox.rail-hidden'
const KIND_WORD: Record<Waiting['kind'], string> = { ask: 'asks', review: 'for review', turn: 'your turn' }
/** How far a finger or a trackpad must travel sideways to open or close the rail. */
const SWIPE_PX = 60
/** A touch that begins this close to the screen's left edge can draw the rail open. */
const EDGE_PX = 28
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
const waitKey = (item: Waiting): string => `${item.kind}:${fiberOf(item.card)}:${item.at}`
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
const stored = (key: string): string | null => { try { return localStorage.getItem(key) } catch { return null } }
const store = (key: string, value: string): void => { try { localStorage.setItem(key, value) } catch { /* A convenience only. */ } }
function lastSeen(key: string): number {
  const value = Number(stored(SEEN + key) ?? NaN)
  return Number.isFinite(value) ? value : -Infinity
}

/**
 * The Outbox: one channel per orchestrator with anything waiting on the
 * human. The rail lists the channels, newest wait first, with the cold ones
 * on a shelf below; a channel shows its orchestrator's tapestry beside its
 * threads, the waiting ones first, and a reply goes to the orchestrator or
 * to the thread chosen.
 */
export class OutboxView implements TemporalView {
  readonly id = 'outbox' as const
  readonly title = 'Outbox'
  readonly hotkey = '5'
  private ctx: ViewContext | null = null
  private layout: HTMLElement | null = null
  private rail: HTMLOListElement | null = null
  private railToggle: HTMLButtonElement | null = null
  private channelEl: HTMLElement | null = null
  private head: HTMLElement | null = null
  private side: HTMLElement | null = null
  private label: HTMLElement | null = null
  private tapestry: HTMLElement | null = null
  private reply: HTMLTextAreaElement | null = null
  private replyTo: HTMLElement | null = null
  private note: HTMLElement | null = null
  private form: HTMLFormElement | null = null
  private channels: Channel[] = []
  private current: string | null = null
  /** The thread chosen in the current channel, by fiber; null is the orchestrator. */
  private selected: string | null = null
  private railHidden = false
  private held: HeldSpeech[] = []
  private dismissed: string[] = []
  private pending: string[] = []
  private names = new Map<string, string>()
  private reachMs = 14 * 86_400_000
  private readonly replied = new Set<string>()
  private readonly tempering = new Set<string>()
  /** When each channel was last read before this visit to it, for the marks of what is new. */
  private readonly before = new Map<string, number>()
  private sig = ''
  private tapestryFor = ''
  private viewer: HTMLElement | null = null
  private loaded = false
  private reading = false
  private readGeneration = 0
  private tapestryGeneration = 0
  private unsubscribe?: () => void
  private stopGestures?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    // The view outlives its mounts: coming back to the channel it showed is reading it again.
    if (this.current) this.visit(this.current)
    const page = createViewPage('Outbox')
    page.root.classList.add('kbn-outbox')
    this.railToggle = button('kbn-ch-rail-toggle', '', () => this.setRail(!this.railHidden))
    page.titleRow.append(el('span', 'kbn-ch-keys', 'j / k channels · [ the rail · Enter to reply · Esc to leave it'), this.railToggle)
    this.layout = el('div', 'kbn-ch-layout')
    this.rail = el('ol', 'kbn-ch-rail')
    this.rail.setAttribute('aria-label', 'Channels waiting on you')
    this.rail.id = `kbn-ch-rail-${Math.random().toString(36).slice(2)}`
    this.railToggle.setAttribute('aria-controls', this.rail.id)
    this.channelEl = el('article', 'kbn-ch')
    this.channelEl.tabIndex = -1
    this.head = el('header', 'kbn-ch-head')
    const columns = el('div', 'kbn-ch-columns')
    const main = el('div', 'kbn-ch-main')
    this.label = el('div', 'kbn-ch-tapestry-label')
    this.tapestry = el('div', 'kbn-ch-tapestry')
    main.append(this.label, this.tapestry)
    this.side = el('div', 'kbn-ch-side')
    columns.append(main, this.side)
    this.channelEl.append(this.head, columns, this.replyBar())
    this.layout.append(this.rail, this.channelEl)
    this.note = el('p', 'kbn-ch-note', 'Reading the Outbox…')
    this.note.setAttribute('role', 'status')
    page.body.append(this.note, this.layout)
    host.append(page.root)
    this.stopGestures = this.gestures(page.root)
    this.railHidden = stored(RAIL) === '1'
    this.showRail()
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
    this.channels = composeChannels({
      cards: boardCards(ctx.response), parentOf: card => index.parentOf(card), names: this.names,
      files: ctx.sends?.files ?? [], held: this.held, dismissed: [...this.dismissed, ...this.pending], now: Date.now(), reachMs: this.reachMs,
    })
    if (!this.channels.some(channel => channel.key === this.current)) this.open(this.channels[0]?.key ?? null, false)
    this.drawRail()
    this.drawChannel()
  }
  /** Comes to a channel, on its orchestrator; what it held when last read is kept for this visit's marks. */
  private open(key: string | null, focus: boolean): void {
    if (key !== this.current) {
      this.current = key
      this.selected = null
      if (key) this.visit(key)
    }
    if (!focus) return
    // On a phone the rail is a drawer over the channel: choosing one puts it away.
    if (isMobileViewport()) this.setRail(true)
    this.drawRail(); this.drawChannel()
    this.channelEl?.focus({ preventScroll: true })
    this.channelEl?.scrollTo?.({ top: 0 })
  }
  private visit(key: string): void {
    this.before.set(key, lastSeen(key))
    store(SEEN + key, String(Date.now()))
  }
  private get channel(): Channel | undefined { return this.channels.find(channel => channel.key === this.current) }
  /** The card shown and replied to: the chosen thread, else the orchestrator. */
  private get target(): KanbanCard | undefined {
    const channel = this.channel
    if (!channel || !this.selected) return channel?.root
    return [...channel.waiting.map(item => item.card), ...channel.threads].find(card => fiberOf(card) === this.selected) ?? channel.root
  }
  /** Chooses a thread to read and answer; choosing it again, or the orchestrator, comes back to the orchestrator. */
  private select(card: KanbanCard | null): void {
    const key = card && fiberOf(card) !== this.current ? fiberOf(card) : null
    this.selected = key === this.selected ? null : key
    this.drawChannel()
  }

  private drawRail(): void {
    const rail = this.rail!, now = Date.now()
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.kbn-ch-pick')?.dataset.channel
    const items: HTMLLIElement[] = []
    for (const channel of this.channels) {
      if (channel.cold && !items.some(item => item.classList.contains('kbn-ch-shelf'))) items.push(el('li', 'kbn-ch-shelf', 'Gone cold'))
      const item = el('li', 'kbn-ch-rail-item')
      const pick = button('kbn-ch-pick', '', () => this.open(channel.key, true))
      pick.dataset.channel = channel.key
      pick.toggleAttribute('data-cold', channel.cold)
      const count = channel.waiting.length, seen = lastSeen(channel.key)
      pick.append(el('span', 'kbn-ch-pick-name', channel.root.name))
      if (channel.role) pick.append(el('span', 'kbn-ch-pick-role', channel.role))
      pick.append(el('span', 'kbn-ch-pick-wait', `${count} waiting · ${ago(channel.newest, now)}`))
      pick.toggleAttribute('data-new', channel.key !== this.current && (channel.newest > seen || channel.files.some(file => file.timestamp > seen)))
      if (channel.key === this.current) pick.setAttribute('aria-current', 'true')
      pick.setAttribute('aria-label', `${channel.root.name}: ${count} waiting, the newest for ${ago(channel.newest, now)}`)
      item.append(pick)
      items.push(item)
    }
    rail.replaceChildren(...items)
    // A poll redraws the rail: the channel that had focus keeps it.
    if (focused) rail.querySelector<HTMLElement>(`[data-channel="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  }

  private drawChannel(): void {
    if (!this.head || !this.side || !this.form || !this.label) return
    const channel = this.channel, target = this.target
    if (!this.ctx?.workspace?.isActive) this.ctx?.see?.(target ?? null)
    this.form.hidden = !channel
    if (!channel || !target) {
      this.sig = ''
      this.head.replaceChildren(el('p', 'kbn-ch-empty', 'Nobody is waiting on you.'))
      this.side.replaceChildren()
      this.label.replaceChildren()
      this.dropTapestry()
      return
    }
    const now = Date.now(), before = this.before.get(channel.key) ?? -Infinity
    const sig = JSON.stringify([channel.key, channel.root.name, channel.root.outcome, channel.role, this.selected, channel.waiting.map(waitKey),
      channel.threads.map(card => [fiberOf(card), threadState(card), card.name]), channel.files.map(file => [file.fullPath, file.timestamp]),
      channel.held.map(line => [line.fiber_id, line.n, line.first]), [...this.replied], [...this.tempering]])
    if (sig !== this.sig) {
      this.sig = sig
      this.head.replaceChildren(...this.header(channel, before, now))
      this.side.replaceChildren(...this.threads(channel, before, now))
      const label = el('p', 'kbn-ch-label')
      if (target === channel.root) label.append(el('span', '', 'Tapestry'))
      else label.append(button('kbn-ch-back', `← ${channel.root.name}`, () => this.select(null)), el('span', '', ` › ${target.name}`))
      this.label.replaceChildren(label)
    }
    // Ages tick in place, so a channel being read is never rebuilt under the reader.
    for (const age of this.channelEl!.querySelectorAll<HTMLElement>('[data-at]')) age.textContent = ago(Number(age.dataset.at), now)
    this.replyTo!.textContent = target.name
    this.drawTapestry(target, channel)
  }
  private header(channel: Channel, before: number, now: number): HTMLElement[] {
    const title = el('div', 'kbn-ch-title')
    title.append(el('h3', 'kbn-ch-name', channel.root.name))
    if (channel.role) title.append(el('span', 'kbn-ch-role', channel.role))
    const parts: HTMLElement[] = [title]
    if (channel.root.outcome) parts.push(el('p', 'kbn-ch-outcome', channel.root.outcome))
    parts.push(el('p', 'kbn-ch-waits', `${channel.waiting.length} waiting`))
    const own = this.attachments(channel, channel.root, before, now)
    if (own) parts.push(own)
    return parts
  }
  /** The family's threads: the waiting ones first and lit, then the other live ones, quieter. */
  private threads(channel: Channel, before: number, now: number): HTMLElement[] {
    const waiting = el('ol', 'kbn-ch-waiting')
    waiting.setAttribute('aria-label', 'Waiting on you')
    waiting.append(...channel.waiting.map(item => this.waitingRow(channel, item, item.at > before, before, now)))
    const parts: HTMLElement[] = [waiting]
    if (!channel.threads.length) return parts
    const quiet = el('ul', 'kbn-ch-quiet')
    quiet.setAttribute('aria-label', 'Its other threads')
    for (const card of channel.threads) {
      const row = el('li', 'kbn-ch-thread')
      row.toggleAttribute('data-chosen', fiberOf(card) === this.selected)
      const pick = button('kbn-ch-thread-name', card.name, () => this.select(card))
      pick.title = THREAD_LABEL[threadState(card)]
      row.append(stateDot(card, card => this.openCard(card)), pick)
      const attached = this.attachments(channel, card, before, now)
      if (attached) row.append(attached)
      quiet.append(row)
    }
    parts.push(el('p', 'kbn-ch-quiet-label', 'Other threads'), quiet)
    return parts
  }
  private waitingRow(channel: Channel, item: Waiting, fresh: boolean, before: number, now: number): HTMLLIElement {
    const key = waitKey(item), card = item.card, root = fiberOf(card) === channel.key
    const row = el('li', 'kbn-ch-item')
    row.dataset.kind = item.kind
    row.toggleAttribute('data-chosen', root ? !this.selected : fiberOf(card) === this.selected)
    row.toggleAttribute('data-new', fresh)
    const pick = button('kbn-ch-item-pick', '', () => this.select(card))
    const meta = el('span', 'kbn-ch-item-meta')
    const age = el('span', 'kbn-ch-age', ago(item.at, now))
    age.dataset.at = String(item.at)
    meta.append(el('span', 'kbn-ch-kind', KIND_WORD[item.kind]), el('span', 'kbn-ch-item-name', root ? `${card.name} · orchestrator` : card.name), age)
    const text = el('span', 'kbn-ch-item-text')
    // The orchestrator's outcome heads the channel already; its row says why it waits.
    const words = root && item.kind === 'turn' ? turnOf(card).detail : item.text
    text.innerHTML = renderMarkdown(words || (item.kind === 'review' ? 'Closed for your review.' : ''))
    pick.append(meta, text)
    const acts = el('div', 'kbn-ch-acts')
    acts.append(button('kbn-ch-act', 'Open', () => this.openCard(card)))
    if (item.kind === 'review') {
      const temper = button('kbn-ch-act', this.tempering.has(key) ? 'Tempering…' : 'Temper', () => { void this.temper(item) })
      temper.disabled = this.tempering.has(key)
      temper.title = 'Accept the work as done'
      acts.append(temper)
    }
    if (this.replied.has(fiberOf(card))) acts.append(el('span', 'kbn-ch-replied', 'Replied'))
    row.append(pick, acts)
    const attached = root ? null : this.attachments(channel, card, before, now)
    if (attached) row.append(attached)
    return row
  }
  /** The files a card sent and the lines it spoke while out of view. */
  private attachments(channel: Channel, card: KanbanCard, before: number, now: number): HTMLElement | null {
    const lines = channel.held.filter(line => line.fiber_id === card.uid || line.fiber_id === card.id)
    const files = channel.files.filter(file => cardNamed([card], file.uid ?? '', file.host ?? ''))
    if (!lines.length && !files.length) return null
    const box = el('div', 'kbn-ch-attached')
    for (const line of lines) {
      const said = button('kbn-ch-said', '', () => this.openCard(card))
      said.append(el('span', 'kbn-ch-said-text', `“${line.first}”`), el('span', 'kbn-ch-age', line.n > 1 ? `${line.n} lines held` : 'held'))
      said.toggleAttribute('data-new', (line.at ?? now) > before)
      said.title = 'Hear it on its card'
      box.append(said)
    }
    if (files.length) {
      const chips = el('div', 'kbn-ch-files')
      for (const file of files.slice(0, 8)) {
        const chip = button('kbn-ch-file', file.basename, () => this.openFile(file))
        chip.toggleAttribute('data-new', file.timestamp > before)
        chip.title = `Sent ${ago(file.timestamp, now)}`
        chips.append(chip)
      }
      box.append(chips)
    }
    return box
  }

  /** The shown card's tapestry (or report), else its constitution. Redrawn only when the card changes. */
  private drawTapestry(card: KanbanCard, channel: Channel): void {
    const key = `${card.originId}\0${fiberOf(card)}`
    if (key === this.tapestryFor) return
    this.dropTapestry()
    this.tapestryFor = key
    const generation = ++this.tapestryGeneration, base = this.ctx!.shuttleBase
    void (async () => {
      let path: string | undefined
      for (const name of card.fiberDir ? COMPANION_NAMES : []) {
        const found = await head(fileBytesUrl(base, `${card.fiberDir}/${name}`, card.originId), RESOURCE_PRIORITY.neighbour)
        if (found?.exists) { path = `${card.fiberDir}/${name}`; break }
      }
      path ??= channel.files.find(file => /^(tapestry|report)\.html$/i.test(file.basename) && cardNamed([card], file.uid ?? '', file.host ?? ''))?.fullPath
      if (generation !== this.tapestryGeneration) return
      if (path) {
        this.viewer = buildFileViewer(base, path, card.originId, undefined, undefined, { active: true })
        this.tapestry!.append(this.viewer)
        return
      }
      const entry = await readFiber(base, card.id, card.originId).catch(() => null)
      if (generation !== this.tapestryGeneration || !entry) return
      const prose = el('div', 'kbn-ch-prose ws-prose kbn-detail-prose')
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
    const form = this.form = el('form', 'kbn-ch-reply')
    const label = el('label', 'kbn-ch-reply-label', 'Reply to ')
    this.replyTo = el('span', 'kbn-ch-reply-to')
    label.append(this.replyTo)
    this.reply = el('textarea', 'kbn-ch-reply-text')
    this.reply.rows = 2
    this.reply.placeholder = 'Write back…'
    label.htmlFor = this.reply.id = `kbn-ch-reply-${Math.random().toString(36).slice(2)}`
    this.reply.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() }
    })
    const send = el('button', 'kbn-ch-send', 'Send')
    send.type = 'submit'
    const later = button('kbn-ch-later', 'Not now', () => { void this.setAside() })
    later.title = 'Set this channel aside until something new waits in it'
    const top = el('div', 'kbn-ch-reply-top'), row = el('div', 'kbn-ch-reply-row')
    top.append(label, later)
    row.append(this.reply, send)
    form.append(top, row)
    form.addEventListener('submit', event => { event.preventDefault(); void this.send() })
    return form
  }
  /** Sends to the card replied to, then comes back to the orchestrator; the channel stays. */
  private async send(): Promise<void> {
    const card = this.target, text = this.reply?.value.trim(), ctx = this.ctx
    if (!card || !text || !ctx) return
    const channel = this.current
    this.reply!.disabled = true
    try {
      const answer = await postDaemonJson<{ delivered?: boolean | null; error?: string }>(ctx.shuttleBase, '/api/v1/deliver',
        { fiber_id: card.id, origin: card.originId, text, from: 'human' }, 'Reply failed')
      if (answer?.delivered === false) throw new Error(answer.error ?? `${card.name} did not receive it`)
      this.replied.add(fiberOf(card))
      if (!this.reply) return
      this.reply.value = ''
      this.status(answer?.delivered === null ? `Sent to ${card.name}; its arrival is not yet confirmed.` : `Sent to ${card.name}.`)
      announce(`Sent to ${card.name}.`)
      if (this.current === channel) { this.selected = null; this.drawChannel() }
      ctx.requestRefresh()
    } catch (error) {
      this.status(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.reply) this.reply.disabled = false
    }
  }
  private async setAside(): Promise<void> {
    const channel = this.channel, ctx = this.ctx
    if (!channel || !ctx) return
    const key = setAsideKey(channel)
    this.pending.push(key)
    this.draw()
    this.open(this.current, true)
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/outbox/dismiss', { key, fiber: channel.key })
    } catch {
      this.pending = this.pending.filter(item => item !== key)
      this.draw()
      this.status(`${channel.root.name} could not be set aside; it is still here.`)
    }
  }
  private async temper(item: Waiting): Promise<void> {
    const key = waitKey(item), ctx = this.ctx
    if (!ctx) return
    this.tempering.add(key)
    this.drawChannel()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/transition', { fiber_id: item.card.id, target: 'tempered', origin: item.card.originId }, 'Temper failed')
      // It stays disabled until the refreshed feed takes the review away.
      ctx.requestRefresh()
    } catch (error) {
      this.tempering.delete(key)
      this.status(`${item.card.name} was not tempered: ${error instanceof Error ? error.message : String(error)}`)
      this.drawChannel()
    }
  }

  /** Hides or shows the rail, remembered in this browser. */
  private setRail(hidden: boolean): void {
    if (hidden === this.railHidden) return
    this.railHidden = hidden
    store(RAIL, hidden ? '1' : '0')
    this.showRail()
  }
  private showRail(): void {
    this.layout?.toggleAttribute('data-rail-hidden', this.railHidden)
    if (!this.railToggle) return
    this.railToggle.textContent = this.railHidden ? 'Show channels' : 'Hide channels'
    this.railToggle.setAttribute('aria-expanded', String(!this.railHidden))
  }
  /**
   * Sideways gestures while the Outbox is shown: a touch drawn in from the left edge
   * opens the rail and one drawn leftward closes it; a two-finger trackpad
   * swipe does the same, back to open and forward to close.
   */
  private gestures(root: HTMLElement): () => void {
    let start: Touch | null = null
    let travel = 0, last = 0
    const down = (event: TouchEvent): void => { start = event.touches.length === 1 ? event.touches[0] : null }
    const up = (event: TouchEvent): void => {
      const end = event.changedTouches[0]
      if (!start || !end) return
      const dx = end.clientX - start.clientX, dy = end.clientY - start.clientY, edge = start.clientX < EDGE_PX
      start = null
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx)) return
      if (dx > 0 && edge) this.setRail(false)
      else if (dx < 0) this.setRail(true)
    }
    const wheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      // The page has no sideways scroll; taking the gesture keeps the browser from going back a page.
      event.preventDefault()
      // One swipe is a burst of wheel events: it acts once, and a pause starts the next.
      if (event.timeStamp - last > 300) travel = 0
      last = event.timeStamp
      if (Number.isNaN(travel)) return
      travel += event.deltaX
      if (Math.abs(travel) < SWIPE_PX) return
      this.setRail(travel > 0)
      travel = NaN
    }
    // Touch events, not pointer events: the browser cancels a pointer it starts panning, but a touch still ends.
    // A touch at the screen's edge can begin outside the page's own margins.
    document.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('touchend', up, { passive: true })
    root.addEventListener('wheel', wheel, { passive: false })
    return () => {
      document.removeEventListener('touchstart', down)
      document.removeEventListener('touchend', up)
      root.removeEventListener('wheel', wheel)
    }
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
    if (!this.channels.length) return
    const at = this.channels.findIndex(channel => channel.key === this.current)
    this.open(this.channels[Math.max(0, Math.min(this.channels.length - 1, at + by))].key, true)
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape' && document.activeElement === this.reply) { this.channelEl?.focus({ preventScroll: true }); return true }
    if (keystrokeIsSpokenFor()) return false
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.setRail(!this.railHidden); return true }
    if (event.key === 'Enter' && !(document.activeElement as HTMLElement | null)?.closest('button, a') && this.channel) { this.reply?.focus(); return true }
    return false
  }
  unmount(): void {
    this.dropTapestry()
    this.readGeneration++
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.stopGestures?.(); this.stopGestures = undefined
    this.reading = false
    this.ctx = null
    this.layout = this.rail = this.railToggle = this.channelEl = this.head = this.side = this.label = this.tapestry = this.note = this.replyTo = null
    this.reply = null
    this.form = null
    this.sig = ''
  }
}
registerView(new OutboxView())
