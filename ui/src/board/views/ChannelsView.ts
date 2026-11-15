import { announce } from '@ui-sdk/core'
import { ago } from '../civilDay.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import { composeChannels, officeOf, setAsideKey, unpinKey, type Channel, type HeldSpeech, type Message } from '../channels.js'
import type { SentFile } from '../sentFiles.js'
import { stateDot } from '../stateDot.js'
import { cardNamed } from '../threads.js'
import { basename, fileBytesUrl, renderMarkdown } from '../utils.js'
import { COMPANION_NAMES, docKey, type DocKey } from '../workspace/documents.js'
import { declaredTitle } from '../workspace/DocumentTitles.js'
import { renderFiberMarkdown } from '../workspace/FiberProse.js'
import { readFiber } from '../workspace/fiberSource.js'
import { charters } from '../workspace/RolePage.js'
import { createViewPage } from './ViewPage.js'
import { isTypingTarget, keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './ChannelsView.css'

const SEEN = 'shuttle.channels.seen:'
const RAIL = 'shuttle.channels.rail-hidden'
/** A pin is renewed by use at most this often; it lapses with the board's reach. */
const RENEW_MS = 86_400_000
/** How far a finger or a trackpad must travel sideways to open or close the rail. */
const SWIPE_PX = 60
/** Find lists at most this many documents beneath the channels it matches. */
const FOUND_DOCUMENTS = 12
/** One document of a channel, or one Find turned up: the fiber it belongs to, its page, its name and when it was sent (0 for a fiber's own companion). */
interface Doc { card: KanbanCard; key: DocKey; name: string; path: string; at: number }
const fiberOf = (card: KanbanCard): string => card.uid ?? card.id
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
/** Whether anything from `node` up to `stop` can still scroll sideways by `toward` (positive: rightward). */
function scrollsSideways(node: Element | null, stop: Element, toward: number): boolean {
  for (; node && node !== stop; node = node.parentElement) {
    if (node.scrollWidth <= node.clientWidth || !/auto|scroll/.test(getComputedStyle(node).overflowX)) continue
    if (toward > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth : node.scrollLeft > 0) return true
  }
  return false
}
function lastSeen(key: string): number {
  const value = Number(stored(SEEN + key) ?? NaN)
  return Number.isFinite(value) ? value : -Infinity
}

/**
 * Channels: a channel per office (or per top-level constitution without
 * one), listed while something in it waits on the human or while he keeps
 * it pinned. A channel reads like a chat: each worker's line, oldest first,
 * the ones waiting on him lit, the seat's tapestry pinned beside them, and a
 * reply bar that answers the seat or the worker chosen. Beside the tapestry
 * are the channel's files: every member's companions and sent documents.
 * Find (the bar's, or the rail's own on a phone) reaches every channel and
 * every document the fleet sent; the rail keeps what was read lately.
 */
export class ChannelsView implements TemporalView {
  readonly id = 'channels' as const
  readonly title = 'Channels'
  readonly hotkey = '3'
  private ctx: ViewContext | null = null
  private layout: HTMLElement | null = null
  private list: HTMLOListElement | null = null
  private finder: HTMLInputElement | null = null
  private found: HTMLElement | null = null
  private lately: HTMLElement | null = null
  private tabs: HTMLElement | null = null
  private filesEl: HTMLOListElement | null = null
  private railToggle: HTMLButtonElement | null = null
  private channelEl: HTMLElement | null = null
  private head: HTMLElement | null = null
  private feed: HTMLOListElement | null = null
  private label: HTMLElement | null = null
  private tapestry: HTMLElement | null = null
  private reply: HTMLTextAreaElement | null = null
  private replyTo: HTMLElement | null = null
  private later: HTMLButtonElement | null = null
  private note: HTMLElement | null = null
  private form: HTMLFormElement | null = null
  private channels: Channel[] = []
  private current: string | null = null
  /** What Find is looking for; '' lists the channels as they wait. */
  private query = ''
  /** What the aside shows beside the lines: the pinned tapestry, or the channel's files. */
  private pane: 'tapestry' | 'files' = 'tapestry'
  /** Each member's own companions (tapestry, artifact, report), probed once its channel's files are shown. */
  private readonly companions = new Map<string, string[]>()
  /** The worker chosen in the current channel; null is the seat. It stays chosen until the reader chooses again. */
  private chosen: KanbanCard | null = null
  /** What was typed in each channel's reply bar, kept while the reader is elsewhere. */
  private readonly drafts = new Map<string, string>()
  private railHidden = false
  private held: HeldSpeech[] = []
  private dismissed: string[] = []
  private pending: string[] = []
  private pinned = new Map<string, number>()
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
  private unsubscribeLibrary?: () => void
  private stopGestures?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    // The view outlives its mounts: coming back to the channel it showed is reading it again.
    if (this.current) this.visit(this.current)
    const page = createViewPage('Channels')
    page.root.classList.add('kbn-channels')
    this.railToggle = button('kbn-ch-rail-toggle', '', () => this.setRail(!this.railHidden))
    page.titleRow.append(el('span', 'kbn-ch-keys', 'j / k channels · [ the rail · Enter to reply'), this.railToggle)
    this.layout = el('div', 'kbn-ch-layout')
    this.layout.append(this.railEl(), this.channelPane())
    this.note = el('p', 'kbn-ch-note', 'Reading the channels…')
    this.note.setAttribute('role', 'status')
    page.body.append(this.note, this.layout)
    host.append(page.root)
    this.stopGestures = this.gestures(page.root)
    this.railHidden = stored(RAIL) === '1'
    this.showRail()
    this.unsubscribe = ctx.sends?.subscribe(() => this.draw())
    this.unsubscribeLibrary = ctx.workspace?.library.subscribe(() => this.draw())
    ctx.workspace?.library.visit()
    void charters(ctx.shuttleBase).then(list => {
      this.names = new Map(list.flatMap(charter => charter.name ? [[charter.slug, charter.name] as [string, string]] : []))
      this.draw()
    }).catch(() => {})
    this.refresh(ctx)
  }
  private railEl(): HTMLElement {
    const rail = el('nav', 'kbn-ch-rail')
    rail.id = `kbn-ch-rail-${Math.random().toString(36).slice(2)}`
    rail.setAttribute('aria-label', 'Channels')
    this.railToggle!.setAttribute('aria-controls', rail.id)
    this.list = el('ol', 'kbn-ch-list')
    // The bar's Find serves the desktop; a phone's bar has none, so the rail carries its own.
    this.finder = el('input', 'kbn-ch-finder')
    this.finder.type = 'search'
    this.finder.placeholder = 'Find a channel or file…'
    this.finder.setAttribute('aria-label', 'Find a channel or file')
    this.finder.addEventListener('input', () => this.find(this.finder!.value))
    this.finder.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.openFirst() }
      if (event.key === 'Escape' && this.finder!.value) { event.stopPropagation(); this.find('') }
    })
    this.found = el('section', 'kbn-ch-shelfed')
    this.found.setAttribute('aria-label', 'Files found')
    this.lately = el('section', 'kbn-ch-shelfed')
    this.lately.setAttribute('aria-label', 'Read lately')
    rail.append(this.finder, this.list, this.found, this.lately)
    return rail
  }
  private channelPane(): HTMLElement {
    this.channelEl = el('article', 'kbn-ch')
    this.channelEl.tabIndex = -1
    this.head = el('header', 'kbn-ch-head')
    this.tabs = el('div', 'kbn-ch-tabs')
    const columns = el('div', 'kbn-ch-columns')
    const talk = el('section', 'kbn-ch-talk')
    this.feed = el('ol', 'kbn-ch-feed')
    talk.append(this.feed, this.replyBar())
    const canvas = el('aside', 'kbn-ch-canvas')
    this.label = el('p', 'kbn-ch-label')
    this.tapestry = el('div', 'kbn-ch-tapestry')
    this.filesEl = el('ol', 'kbn-ch-files')
    canvas.append(this.label, this.tapestry, this.filesEl)
    columns.append(talk, canvas)
    this.channelEl.append(this.head, columns)
    return this.channelEl
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
    const [records, speech] = await Promise.allSettled([
      getDaemonJson<{ dismissed: string[]; pinned?: Record<string, number>; reach_ms: number }>(`${base}/api/v1/channels/dismissed`),
      getDaemonJson<{ held: HeldSpeech[] }>(`${base}/api/v1/speak`),
    ])
    if (generation !== this.readGeneration) return
    this.reading = false
    this.loaded = true
    if (records.status === 'fulfilled') {
      this.dismissed = records.value.dismissed
      this.reachMs = records.value.reach_ms
      this.pending = this.pending.filter(key => !this.dismissed.includes(key))
      // A pin made here stands until the feed carries one as new.
      for (const [key, at] of Object.entries(records.value.pinned ?? {})) this.pinned.set(key, Math.max(at, this.pinned.get(key) ?? 0))
      for (const [key, at] of this.pinned) if (Date.now() - at > this.reachMs) this.pinned.delete(key)
    }
    if (speech.status === 'fulfilled') this.held = speech.value.held
    this.status(records.status === 'rejected' || speech.status === 'rejected' ? 'Some channel sources are unavailable — showing the last read.' : '')
    this.draw()
  }
  private status(text: string): void { if (this.note) this.note.textContent = text }

  /**
   * The rail's channels: while Find looks for something, every channel it
   * matches; otherwise those listed, and the one being read, which stays
   * until the reader moves on.
   */
  private get listed(): Channel[] {
    if (!this.query) return this.channels.filter(channel => channel.listed || channel.key === this.current)
    const query = this.query.toLowerCase()
    return this.channels.filter(channel => [channel.name, ...channel.members.flatMap(card => [card.name, card.path]),
      ...this.documents(channel).flatMap(doc => [doc.name, doc.path])].some(text => text.toLowerCase().includes(query)))
  }
  /** Filters the rail by what Find holds, from the bar's field or the rail's own. */
  find(query: string): void {
    this.query = query.trim()
    if (this.finder && this.finder.value !== query) this.finder.value = query
    this.drawRail()
  }
  /** Enter in Find opens the first channel it found, else the first document. */
  private openFirst(): void {
    const channel = this.listed[0]
    if (channel) { this.open(channel.key, true); return }
    this.found?.querySelector<HTMLButtonElement>('button')?.click()
  }
  /**
   * A channel's documents: each member's own companions once probed, then
   * everything its members sent, newest first, each document once.
   */
  private documents(channel: Channel): Doc[] {
    const library = this.ctx?.workspace?.library
    const docs = new Map<DocKey, Doc>()
    for (const card of channel.members) for (const path of this.companions.get(`${card.originId}\0${fiberOf(card)}`) ?? []) {
      const key = docKey(card.originId, path, card.originId, card.fiberDir)
      docs.set(key, { card, key, name: basename(path), path, at: 0 })
    }
    const sent = channel.members.flatMap(card => (library?.receipts(fiberOf(card)) ?? []).map(receipt => ({ card, receipt })))
      .sort((a, b) => b.receipt.timestamp - a.receipt.timestamp)
    for (const { card, receipt } of sent) if (!docs.has(receipt.key)) {
      docs.set(receipt.key, { card, key: receipt.key, name: declaredTitle(receipt.key)?.title ?? receipt.basename, path: receipt.fullPath, at: receipt.timestamp })
    }
    return [...docs.values()]
  }
  /** Probes each member's companions once, in the neighbour lane, redrawing the files as they turn up. */
  private probeCompanions(channel: Channel): void {
    const base = this.ctx?.shuttleBase ?? ''
    for (const card of channel.members) {
      const id = `${card.originId}\0${fiberOf(card)}`
      if (!card.fiberDir || this.companions.has(id)) continue
      this.companions.set(id, [])
      void Promise.all(COMPANION_NAMES.map(async name => {
        const path = `${card.fiberDir}/${name}`
        return (await head(fileBytesUrl(base, path, card.originId), RESOURCE_PRIORITY.neighbour).catch(() => null))?.exists ? path : null
      })).then(paths => {
        const found = paths.filter((path): path is string => !!path)
        if (!found.length) return
        this.companions.set(id, found)
        this.drawFiles()
      })
    }
  }
  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.list || !this.loaded) return
    const index = threadIndexFor(ctx.response)
    this.channels = composeChannels({
      cards: boardCards(ctx.response), parentOf: card => index.parentOf(card), names: this.names, files: ctx.sends?.files ?? [], held: this.held,
      dismissed: [...this.dismissed, ...this.pending], pinned: this.pinned, now: Date.now(), reachMs: this.reachMs,
    })
    if (!this.channels.some(channel => channel.key === this.current)) this.open(this.listed[0]?.key ?? null, false)
    this.drawRail()
    this.drawChannel()
  }
  /**
   * Comes to a channel, on its seat, with its own draft; what it held when
   * last read is kept for this visit's marks. Choosing it deliberately (not
   * stepping through with j / k) renews its pin.
   */
  private open(key: string | null, focus: boolean, deliberate = focus): void {
    if (key !== this.current) {
      if (this.current && this.reply) this.drafts.set(this.current, this.reply.value)
      this.current = key
      this.chosen = null
      if (this.reply) this.reply.value = (key && this.drafts.get(key)) || ''
      if (key) this.visit(key)
    }
    if (!focus) return
    if (key && deliberate) this.renew(key)
    // On a phone the rail is a drawer over the channel: choosing one puts it away.
    if (isMobileViewport()) this.setRail(true)
    this.drawRail(); this.drawChannel()
    this.channelEl?.focus({ preventScroll: true })
    this.form?.scrollIntoView?.({ block: 'nearest' })
  }
  private visit(key: string): void {
    this.before.set(key, lastSeen(key))
    store(SEEN + key, String(Date.now()))
  }
  private get channel(): Channel | undefined { return this.channels.find(channel => channel.key === this.current) }
  /** The card replied to: the worker chosen (its freshest copy, even once its line has gone), else the seat. */
  private get target(): KanbanCard | undefined {
    const channel = this.channel, chosen = this.chosen
    if (!channel || !chosen) return channel?.seat
    return channel.messages.find(message => fiberOf(message.card) === fiberOf(chosen))?.card ?? chosen
  }
  /** Chooses a worker to read and answer; choosing it again, or the seat, comes back to the seat. */
  private select(card: KanbanCard | null): void {
    const same = card && this.chosen && fiberOf(card) === fiberOf(this.chosen)
    this.chosen = card && !same && fiberOf(card) !== fiberOf(this.channel!.seat) ? card : null
    this.drawChannel()
  }

  private drawRail(): void {
    const list = this.list!, now = Date.now()
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('.kbn-ch-pick')?.dataset.channel
    const items: HTMLLIElement[] = []
    for (const channel of this.listed) {
      if (channel.cold && !items.some(item => item.classList.contains('kbn-ch-shelf'))) items.push(el('li', 'kbn-ch-shelf', 'Gone cold'))
      const item = el('li', 'kbn-ch-rail-item')
      const pick = button('kbn-ch-pick', '', () => this.open(channel.key, true))
      pick.dataset.channel = channel.key
      pick.toggleAttribute('data-waiting', channel.waiting && !channel.cold)
      pick.toggleAttribute('data-quiet', !channel.waiting || channel.cold)
      pick.append(el('span', 'kbn-ch-pick-name', channel.name))
      if (channel.waiting) {
        const age = el('span', 'kbn-ch-pick-age', ago(channel.newest, now))
        age.dataset.at = String(channel.newest)
        pick.append(age)
      }
      const seen = lastSeen(channel.key)
      pick.toggleAttribute('data-new', channel.key !== this.current && (channel.newest > seen || channel.files.some(file => file.timestamp > seen)))
      if (channel.key === this.current) pick.setAttribute('aria-current', 'true')
      item.append(pick)
      items.push(item)
    }
    if (this.query && !items.length) items.push(el('li', 'kbn-ch-hush kbn-ch-none', 'No channel matches.'))
    list.replaceChildren(...items)
    // A poll redraws the rail: the channel that had focus keeps it.
    if (focused) list.querySelector<HTMLElement>(`[data-channel="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
    this.drawFound()
    this.drawLately()
  }
  /** The documents Find matches, across every channel and every fiber the fleet sent from. */
  private drawFound(): void {
    const found = this.found!, query = this.query.toLowerCase(), library = this.ctx?.workspace?.library
    const channelOf = new Map(this.channels.flatMap(channel => channel.members.map(card => [fiberOf(card), channel.name] as const)))
    const matches = !query || !library ? [] : library.documents().filter(({ card, receipt }) =>
      [receipt.basename, receipt.fullPath, declaredTitle(receipt.key)?.title ?? '', card.name, channelOf.get(fiberOf(card)) ?? ''].some(text => text.toLowerCase().includes(query)))
      .slice(0, FOUND_DOCUMENTS)
    found.hidden = !matches.length
    found.replaceChildren(el('h4', 'kbn-ch-shelf', 'Files'), this.docList(matches.map(({ card, receipt }) => ({
      card, key: receipt.key, name: declaredTitle(receipt.key)?.title ?? receipt.basename, path: receipt.fullPath, at: receipt.timestamp,
    })), doc => channelOf.get(fiberOf(doc.card)) ?? doc.card.name))
  }
  /** What was read lately in this session, while Find is not looking. */
  private drawLately(): void {
    const cards = this.query ? [] : this.ctx?.workspace?.readLatelyCards() ?? []
    this.lately!.hidden = !cards.length
    const list = el('ol', 'kbn-ch-lately')
    list.append(...cards.map(card => {
      const item = el('li', '')
      const pick = button('kbn-ch-doc', '', () => this.ctx?.workspace?.openPage(card))
      pick.append(el('span', 'kbn-ch-doc-name', card.name))
      pick.title = card.outcome ?? card.path
      item.append(pick)
      return item
    }))
    this.lately!.replaceChildren(el('h4', 'kbn-ch-shelf', 'Read lately'), list)
  }
  /** A quiet list of documents, each opening in the reader; `whose` says where each comes from. */
  private docList(docs: Doc[], whose: (doc: Doc) => string): HTMLOListElement {
    const list = el('ol', 'kbn-ch-doclist'), now = Date.now()
    list.append(...docs.map(doc => {
      const item = el('li', '')
      const pick = button('kbn-ch-doc', '', () => this.ctx?.workspace?.openPage(doc.card, doc.key))
      pick.title = doc.path
      const meta = el('span', 'kbn-ch-doc-meta', whose(doc))
      if (doc.at) {
        const age = el('span', 'kbn-ch-age', ` · ${ago(doc.at, now)}`)
        meta.append(age)
      }
      pick.append(el('span', 'kbn-ch-doc-name', doc.name), meta)
      item.append(pick)
      return item
    }))
    return list
  }

  private drawChannel(): void {
    if (!this.head || !this.feed || !this.form || !this.label) return
    const channel = this.channel, target = this.target
    if (!this.ctx?.workspace?.isActive) this.ctx?.see?.(target ?? null)
    this.form.hidden = !channel
    if (!channel || !target) {
      this.sig = ''
      this.head.replaceChildren(el('p', 'kbn-ch-empty', 'Nobody is waiting on you.'))
      this.feed.replaceChildren()
      this.label.replaceChildren()
      this.filesEl!.replaceChildren()
      this.dropTapestry()
      return
    }
    const now = Date.now(), before = this.before.get(channel.key) ?? -Infinity
    const sig = JSON.stringify([channel.key, channel.name, this.chosen && fiberOf(this.chosen), channel.messages.map(message => [fiberOf(message.card), message.kind, message.text, message.at, message.card.name]),
      channel.files.map(file => [file.fullPath, file.timestamp]), channel.held.map(line => [line.fiber_id, line.n, line.first]), [...this.replied], [...this.tempering]])
    if (sig !== this.sig) {
      this.sig = sig
      this.head.replaceChildren(el('h3', 'kbn-ch-name', channel.name), this.tabs!)
      this.feed.replaceChildren(...channel.messages.map(message => this.messageRow(channel, message, before, now)))
      if (!channel.messages.length) this.feed.append(el('li', 'kbn-ch-hush', 'Quiet.'))
      if (target === channel.seat) this.label.replaceChildren(el('span', '', channel.seat.name))
      else this.label.replaceChildren(button('kbn-ch-back', `← ${channel.seat.name}`, () => this.select(null)), el('span', '', ` › ${target.name}`))
    }
    // Ages tick in place, so a channel being read is never rebuilt under the reader.
    for (const age of this.layout!.querySelectorAll<HTMLElement>('[data-at]')) age.textContent = ago(Number(age.dataset.at), now)
    this.replyTo!.textContent = target.name
    this.later!.hidden = !channel.waiting && !channel.pinned
    this.later!.title = channel.waiting ? 'Set this channel aside until something new waits in it' : 'Unpin this channel'
    this.drawTabs(channel)
    this.drawTapestry(target, channel)
    this.drawFiles()
  }
  /** The header's choice of what stands beside the lines, and a pin for a channel that would otherwise leave the rail. */
  private drawTabs(channel: Channel): void {
    const tab = (pane: 'tapestry' | 'files', text: string): HTMLButtonElement => {
      const node = button('kbn-ch-tab', text, () => { this.pane = pane; this.drawChannel() })
      node.setAttribute('aria-pressed', String(this.pane === pane))
      return node
    }
    const count = this.documents(channel).length
    this.tabs!.replaceChildren(tab('tapestry', 'Tapestry'), tab('files', count ? `Files ${count}` : 'Files'))
    if (!channel.listed) this.tabs!.append(button('kbn-ch-tab kbn-ch-pin', 'Pin', () => { void this.pin(channel); this.draw() }))
  }
  /** The channel's files, when they are the pane shown. */
  private drawFiles(): void {
    const channel = this.channel, files = this.pane === 'files' && channel
    this.tapestry!.hidden = !!files
    this.label!.hidden = !!files
    this.filesEl!.hidden = !files
    if (!files) return
    this.probeCompanions(channel)
    const docs = this.documents(channel)
    this.filesEl!.replaceChildren(...(docs.length ? this.docList(docs, doc => doc.card.name).children : [el('li', 'kbn-ch-hush', 'No files yet.')]))
  }
  /** One worker's line: who, when, what, and what it sent; its actions show once it is chosen. */
  private messageRow(channel: Channel, message: Message, before: number, now: number): HTMLLIElement {
    const card = message.card, chosen = fiberOf(card) === fiberOf(this.target!)
    const row = el('li', 'kbn-ch-msg')
    if (message.kind) row.dataset.kind = message.kind
    row.toggleAttribute('data-chosen', chosen)
    row.toggleAttribute('data-new', !!message.kind && message.at > before)
    const body = el('div', 'kbn-ch-msg-body')
    const pick = button('kbn-ch-msg-pick', '', () => this.select(card))
    const who = el('span', 'kbn-ch-msg-head')
    who.append(el('span', 'kbn-ch-msg-name', card.name))
    const office = officeOf(card.shuttleRole)
    if (office && `role:${office}` !== channel.key) who.append(el('span', 'kbn-ch-msg-role', this.names.get(office) ?? office))
    const age = el('span', 'kbn-ch-age', ago(message.at, now))
    age.dataset.at = String(message.at)
    who.append(age)
    pick.append(who)
    const words = message.text || (message.kind === 'review' ? 'Closed for your review.' : '')
    if (words) {
      const text = el('div', 'kbn-ch-msg-text')
      text.innerHTML = renderMarkdown(words)
      pick.append(text)
    }
    body.append(pick)
    const attached = this.attachments(channel, card, before, now)
    if (attached) body.append(attached)
    const acts = el('div', 'kbn-ch-acts')
    acts.append(button('kbn-ch-act', 'Open', () => this.openCard(card)))
    if (message.kind === 'review') {
      const key = `${fiberOf(card)}:${message.at}`
      const temper = button('kbn-ch-act', this.tempering.has(key) ? 'Tempering…' : 'Temper', () => { void this.temper(card, key) })
      temper.disabled = this.tempering.has(key)
      temper.title = 'Accept the work as done'
      acts.append(temper)
    }
    body.append(acts)
    if (this.replied.has(fiberOf(card))) body.append(el('span', 'kbn-ch-replied', 'Replied'))
    row.append(stateDot(card, card => this.openCard(card)), body)
    return row
  }
  /** The files a card sent and the lines it spoke while out of view. */
  private attachments(channel: Channel, card: KanbanCard, before: number, now: number): HTMLElement | null {
    const lines = channel.held.filter(line => line.fiber_id === card.uid || line.fiber_id === card.id)
    const files = channel.files.filter(file => cardNamed([card], file.uid ?? '', file.host ?? ''))
    if (!lines.length && !files.length) return null
    const box = el('div', 'kbn-ch-attached')
    for (const line of lines) {
      const said = button('kbn-ch-said', `“${line.first}”`, () => this.openCard(card))
      said.toggleAttribute('data-new', (line.at ?? now) > before)
      said.title = line.n > 1 ? `${line.n} lines held — hear them on its card` : 'Hear it on its card'
      box.append(said)
    }
    for (const file of files.slice(0, 8)) {
      const chip = button('kbn-ch-file', file.basename, () => this.openFile(file))
      chip.toggleAttribute('data-new', file.timestamp > before)
      chip.title = `Sent ${ago(file.timestamp, now)}`
      box.append(chip)
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
    label.htmlFor = this.reply.id = `kbn-ch-reply-${Math.random().toString(36).slice(2)}`
    this.reply.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit() }
    })
    const send = el('button', 'kbn-ch-send', 'Send')
    send.type = 'submit'
    this.later = button('kbn-ch-later', 'Not now', () => { void this.setAside() })
    const top = el('div', 'kbn-ch-reply-top'), row = el('div', 'kbn-ch-reply-row')
    top.append(label, this.later)
    row.append(this.reply, send)
    form.append(top, row)
    form.addEventListener('submit', event => { event.preventDefault(); void this.send() })
    return form
  }
  /** Sends to the card replied to, then comes back to the seat; the channel stays. */
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
      if (channel) { this.renew(channel); this.drafts.delete(channel) }
      if (!this.reply) return
      if (this.current === channel) { this.reply.value = ''; this.chosen = null; this.drawChannel() }
      this.status(answer?.delivered === null ? `Sent to ${card.name}; its arrival is not yet confirmed.` : `Sent to ${card.name}.`)
      announce(`Sent to ${card.name}.`)
      ctx.requestRefresh()
    } catch (error) {
      this.status(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (this.reply) this.reply.disabled = false
    }
  }
  /** Not now: sets a waiting channel aside, or unpins a quiet pinned one, and moves on to the next. */
  private async setAside(): Promise<void> {
    const channel = this.channel, ctx = this.ctx
    if (!channel || !ctx) return
    const key = channel.waiting ? setAsideKey(channel) : unpinKey(channel.key, Date.now())
    const listed = this.listed, at = listed.indexOf(channel)
    const next = listed.filter(each => each !== channel)[Math.min(at, listed.length - 2)]
    this.pending.push(key)
    this.open(next?.key ?? null, true, false)
    this.draw()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber: fiberOf(channel.seat) })
    } catch {
      this.pending = this.pending.filter(item => item !== key)
      this.draw()
      this.status(`${channel.name} could not be ${channel.waiting ? 'set aside' : 'unpinned'}; it is still here.`)
    }
  }
  /** Pins a channel across the fleet; use renews it, and it lapses with the board's reach. */
  private async pin(channel: Channel): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    this.pinned.set(channel.key, Date.now())
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/pin', { key: channel.key, fiber: fiberOf(channel.seat) }, 'Pin failed')
    } catch (error) {
      this.status(`${channel.name} is pinned here only: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  private renew(key: string): void {
    const channel = this.channels.find(each => each.key === key)
    if (channel?.pinned && Date.now() - (this.pinned.get(key) ?? 0) > RENEW_MS) void this.pin(channel)
  }
  private async temper(card: KanbanCard, key: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    this.tempering.add(key)
    this.drawChannel()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/transition', { fiber_id: card.id, target: 'tempered', origin: card.originId }, 'Temper failed')
      // It stays disabled until the refreshed feed takes the review away.
      ctx.requestRefresh()
    } catch (error) {
      this.tempering.delete(key)
      this.status(`${card.name} was not tempered: ${error instanceof Error ? error.message : String(error)}`)
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
   * Sideways gestures over the channel's lines or the rail, while the Channels
   * view is the surface shown: a touch drawn rightward from the lines opens the
   * rail and one drawn leftward closes it; a two-finger trackpad swipe does
   * the same, back to open and forward to close. Content that scrolls
   * sideways keeps the gesture, and the tapestry is never a gesture surface.
   */
  private gestures(root: HTMLElement): () => void {
    const surface = (target: EventTarget | null): Element | null =>
      this.ctx?.workspace?.isActive ? null : (target as Element | null)?.closest?.('.kbn-ch-talk, .kbn-ch-rail') ?? null
    let start: { x: number; y: number; on: Element } | null = null
    let travel = 0, last = 0
    const down = (event: TouchEvent): void => {
      const on = event.touches.length === 1 ? surface(event.target) : null
      start = on ? { x: event.touches[0].clientX, y: event.touches[0].clientY, on } : null
    }
    const up = (event: TouchEvent): void => {
      const end = event.changedTouches[0], from = start
      start = null
      if (!from || !end) return
      const dx = end.clientX - from.x, dy = end.clientY - from.y
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx) || scrollsSideways(event.target as Element, root, -dx)) return
      if (dx < 0) this.setRail(true)
      else if (from.on.classList.contains('kbn-ch-talk')) this.setRail(false)
    }
    const wheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !surface(event.target) || scrollsSideways(event.target as Element, root, event.deltaX)) return
      // Taking the gesture keeps the browser from going back a page.
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
    root.addEventListener('touchstart', down, { passive: true })
    root.addEventListener('touchend', up, { passive: true })
    root.addEventListener('wheel', wheel, { passive: false })
    return () => {
      root.removeEventListener('touchstart', down)
      root.removeEventListener('touchend', up)
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
    const listed = this.listed
    if (!listed.length) return
    const at = listed.findIndex(channel => channel.key === this.current)
    this.open(listed[Math.max(0, Math.min(listed.length - 1, at + by))].key, true, false)
  }

  keydown(event: KeyboardEvent): boolean {
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    if (event.key === 'Escape' && (document.activeElement === this.reply || document.activeElement === this.finder)) { this.channelEl?.focus({ preventScroll: true }); return true }
    // Enter in the bar's Find opens what it found first.
    if (event.key === 'Enter' && this.query && isTypingTarget(document.activeElement as HTMLElement | null) && document.activeElement !== this.reply && document.activeElement !== this.finder) { this.openFirst(); return true }
    if (keystrokeIsSpokenFor()) return false
    if (event.key === '/' && this.finder?.getClientRects().length) { this.setRail(false); this.finder.focus({ preventScroll: true }); return true }
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.setRail(!this.railHidden); return true }
    if (event.key === 'Enter' && !(document.activeElement as HTMLElement | null)?.closest('button, a, input') && this.channel) { this.reply?.focus(); return true }
    return false
  }
  unmount(): void {
    this.dropTapestry()
    this.readGeneration++
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.unsubscribeLibrary?.(); this.unsubscribeLibrary = undefined
    this.stopGestures?.(); this.stopGestures = undefined
    this.reading = false
    this.ctx = null
    this.layout = this.channelEl = this.head = this.label = this.tapestry = this.note = this.replyTo = null
    this.list = null; this.found = null; this.lately = null; this.finder = null; this.feed = null; this.railToggle = null; this.later = null
    this.tabs = null; this.filesEl = null
    this.reply = null
    this.form = null
    this.sig = ''
  }
}
registerView(new ChannelsView())
