import { announce } from '@ui-sdk/core'
import '@ui-sdk/web/tooltip'
import { relative, retime } from '../elements/time.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import {
  arranged, clearLineKey, clearedLines, lineIds, composeChannels, composeStream, fiberOf, hideKey, railOrder, reordered, showKey, unclearLineKey, unpinKey,
  type Channel, type Entry, type Item, type Station, type Stream,
} from '../channels.js'
import { layTube, rowHeight, type Excursion, type TubeLine, type TubeRow } from '../tube.js'
import { createRailReorder, type RailReorder } from '../channelRail.js'
import { openActionMenu } from '../conversationMenu.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { clearToast } from '../utils.js'
import { ATTENTION_ORDER, attentionOf, lastActive, type Waits } from '../attention.js'
import { turnOf } from '../turn.js'
import { docKey } from '../workspace/documents.js'
import { headerIcon, type HeaderIcon } from '../workspace/headerIcon.js'
import { declaredTitle, watchDocumentTitles } from '../workspace/DocumentTitles.js'
import { docButtons } from '../workspace/docButtons.js'
import { previewsHeight, Unfold, type UnfoldFile } from '../elements/filePreview.js'
import { groups, kindWord, post } from '../elements/post.js'
import { doing, threadRow } from '../elements/threadRow.js'
import { onDesk } from '../workspace/fiberPageState.js'
import type { Dock } from '../workspace/Dock.js'
import { createViewPage } from './ViewPage.js'
import { isTypingTarget, keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './ChannelsView.css'

/** When this device last read each channel: its ink dot. */
const SEEN = 'shuttle.channels.seen:'
/** Whether the desktop rail is put away on this device. */
const RAIL = 'shuttle.channels.rail-hidden'
/** The channel this device was last in. */
const LAST = 'shuttle.channels.last'
/** A pin is renewed by use at most this often; it lapses with the board's reach. */
const RENEW_MS = 86_400_000
/** The rail's order and its hides are written again once this old, well inside the board's reach. */
const KEEP_MS = 7 * 86_400_000
/** How far a finger or a trackpad must travel sideways to bring the rail in or put it away. */
const SWIPE_PX = 60
/** About how tall a post stands without its files: its head and two lines of words. */
const POST_PX = 64
/** A stream within this many pixels of its foot follows what arrives. */
const FOLLOW_PX = 24
/** Jump to lists at most this many documents beneath the channels it matches. */
const FOUND_DOCUMENTS = 12
/** Narrower than this, the rail is a drawer drawn in over the stream. */
const DRAWER_PX = 1100
/** The tube map's geometry: the bundle's centre, the first lane's, the step between lanes, a curve's radius, the whole margin, the dot column. */
const TUBE = { bundle: 4, first: 10, pitch: 5, radius: 3, gutter: 34, dot: 14 } as const
/** Where a station sits in its row: an item's dot, a start's ring, an end's terminus, a tick. */
const STATION_Y = { item: 20, start: 11, end: 9, tick: 8 } as const
const SVG = 'http://www.w3.org/2000/svg'
/** A thread's colour on the tube map, one of six, the same wherever its lines are drawn. */
const hue = (card: KanbanCard): string => {
  let hash = 0
  for (const char of fiberOf(card)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return String(hash % 6)
}
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

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
/** A control drawn as an icon, named by its tooltip. */
interface IconButton { root: HTMLElement; button: HTMLButtonElement; name: (label: string) => void }
function iconButton(className: string, icon: HeaderIcon, label: string, onClick: () => void): IconButton {
  const root = document.createElement('ui-tooltip'), trigger = document.createElement('ui-tooltip-trigger'), tip = document.createElement('ui-tooltip-content')
  const node = button(`kbn-ch-icon ${className}`, '', onClick)
  node.innerHTML = headerIcon(icon)
  tip.className = 'kbn-ch-tip'
  tip.textContent = label
  trigger.append(node)
  root.append(trigger, tip)
  return { root, button: node, name: text => { tip.textContent = text } }
}
/** Threads in the order a list of them reads: what waits on the human first, then what works, each by its latest activity. */
const ranked = (cards: KanbanCard[], waits: Waits): KanbanCard[] =>
  cards.sort((a, b) => ATTENTION_ORDER.indexOf(attentionOf(a, waits)) - ATTENTION_ORDER.indexOf(attentionOf(b, waits)) || lastActive(b) - lastActive(a))
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
 * Channels: a rail of the channels (what waits on the human floated to the
 * top, the rest in the human's order, each movable and with a menu to hide,
 * pin or move it; Jump to finds the rest and the fleet's documents), and a
 * channel's stream of what its workers addressed to the human — each worker's
 * question, post, close or sent files as one compact item, beside a tube map
 * of its threads' lives (`layTube`), each a line from its start to its end
 * with its items wired to it. Choosing an item or a line opens that
 * constitution's view; its files unfold in place.
 * The channel's head carries its chair's pages, and its console speaks to its
 * chair. Opening a channel looks at nothing; only a click on something in it
 * moves Rex and voice. On a phone the rail is the first screen.
 */
export class ChannelsView implements TemporalView {
  readonly id = 'channels' as const
  readonly title = 'Channels'
  readonly hotkey = '3'
  private ctx: ViewContext | null = null
  private layout: HTMLElement | null = null
  private list: HTMLOListElement | null = null
  private jump: HTMLInputElement | null = null
  private found: HTMLElement | null = null
  private railToggle: IconButton | null = null
  private channelEl: HTMLElement | null = null
  private head: HTMLElement | null = null
  private stream: HTMLOListElement | null = null
  private note: HTMLElement | null = null
  /** The console, to the channel's chair. */
  private dock: Dock | null = null
  /** Whose draft the console holds: the channel it was last opened on. */
  private drafted: string | null = null
  /** What was typed to each channel's chair, by channel, kept while the reader is elsewhere. */
  private readonly drafts = new Map<string, string>()
  /** Each item's files as previews that unfold in place, by item, kept across redraws with the close's tapestry it found. */
  private readonly unfolds = new Map<string, { unfold: Unfold; lead?: UnfoldFile; files: UnfoldFile[] }>()
  /** The stream's rows as last drawn, by entry, each with what it drew: a row that would draw the same is kept, an unfolded file in it with it. */
  private readonly rows = new Map<string, { sig: string; node: HTMLLIElement }>()
  private channels: Channel[] = []
  private current: string | null = null
  /** What Jump to is looking for; '' lists the rail. */
  private query = ''
  /** The item a document or view was opened from, which takes focus again when the reader closes. */
  private returnTo: string | null = null
  /** The reader stands over Channels: nothing redraws beneath it. */
  private away = false
  /**
   * The threads running now in this channel, as the stream was last drawn:
   * each with a life not yet ended, what waits on the human first, then what
   * works, each by its latest activity. The ring counts them, and it and the
   * bundle list them.
   */
  private running: KanbanCard[] = []
  /** The stream follows what arrives while the reader is at its foot. */
  private following = true
  /** The worker Rex last brought this channel to, whose latest line is marked. */
  private marked: string | null = null
  private railHidden = false
  /** A phone shows the rail until a channel is chosen. */
  private phoneRail = true
  /** Where the view is narrow, the rail is a drawer drawn in over the stream, put away once a channel is chosen. */
  private drawer = false
  private dismissed: string[] = []
  private pending: string[] = []
  private pinned = new Map<string, number>()
  /** The human's order of the channels, and when it was written. */
  private order: string[] = []
  private orderAt = 0
  private rail: RailReorder | null = null
  /** The rail's entries, each made movable, undone when they are drawn again. */
  private railBindings: Array<() => void> = []
  /** A poll arrived while an entry was picked up: the rail is drawn once it lands. */
  private railStale = false
  private sigs = { rail: '', head: '', stream: '' }
  private width: ResizeObserver | null = null
  /** Follows the console's height, which a drawn-in rail ends above. */
  private consoleSize: ResizeObserver | null = null
  private loaded = false
  private reading = false
  private generation = 0
  private unsubscribe: Array<() => void> = []
  private stopGestures?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    // The view outlives its mounts: coming back to the channel it showed is reading it again.
    if (this.current) store(SEEN + this.current, String(Date.now()))
    const page = createViewPage('Channels')
    page.root.classList.add('kbn-channels')
    // The board's tab bar names the view: the channel's own head is the view's top row, the rail's toggle at its right.
    page.titleRow.remove()
    this.railToggle = iconButton('kbn-ch-rail-toggle', 'rail', '', () => this.setRail(this.railShown()))
    this.layout = el('div', 'kbn-ch-layout')
    this.layout.append(this.railEl(), this.channelPane())
    this.note = el('p', 'kbn-ch-note', 'Reading the channels…')
    this.note.setAttribute('role', 'status')
    page.body.append(this.note, this.layout)
    host.append(page.root)
    this.stopGestures = this.gestures(page.root)
    this.rail = createRailReorder({
      onOrder: keys => this.reorder(keys),
      onMenu: (key, pick, point) => this.railMenu(key, pick, point),
      onSettled: () => { if (this.railStale) this.drawRail() },
    })
    this.width = new ResizeObserver(([entry]) => {
      const layout = this.layout!, drawer = entry.contentRect.width < DRAWER_PX && !isMobileViewport()
      if (drawer === layout.hasAttribute('data-drawer')) return
      layout.toggleAttribute('data-drawer', drawer)
      this.showRail()
    })
    this.width.observe(this.layout)
    // A drawn-in rail ends where the console begins.
    this.consoleSize = new ResizeObserver(() => this.layout?.style.setProperty('--kbn-ch-console', `${this.dock?.el.offsetHeight ?? 0}px`))
    if (this.dock) this.consoleSize.observe(this.dock.el)
    // A press outside the drawn-in rail puts it away.
    this.layout.addEventListener('pointerdown', event => {
      if (this.overDrawer() && !(event.target as Element).closest('.kbn-ch-rail, .kbn-ch-rail-toggle')) this.setRail(true)
    })
    this.railHidden = stored(RAIL) === '1'
    this.showRail()
    const workspace = ctx.workspace!
    this.unsubscribe = [
      ctx.sends?.subscribe(() => this.draw()) ?? (() => {}),
      workspace.board.subscribe(() => this.draw()),
      workspace.library.subscribe(() => { if (this.query) this.drawRail() }),
      // A found page is named by its declared title once the page is read.
      watchDocumentTitles(() => { if (this.query) this.drawFound() }),
    ]
    this.refresh(ctx)
  }
  private railEl(): HTMLElement {
    const rail = el('nav', 'kbn-ch-rail')
    rail.id = `kbn-ch-rail-${Math.random().toString(36).slice(2)}`
    rail.setAttribute('aria-label', 'Channels')
    this.railToggle!.button.setAttribute('aria-controls', rail.id)
    this.jump = el('input', 'kbn-ch-jump')
    this.jump.type = 'search'
    this.jump.placeholder = 'Jump to…'
    this.jump.setAttribute('aria-label', 'Jump to a channel or file')
    this.jump.addEventListener('input', () => this.find(this.jump!.value))
    this.jump.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.openFirst() }
      if (event.key === 'Escape' && this.jump!.value) { event.stopPropagation(); this.find('') }
    })
    this.list = el('ol', 'kbn-ch-list')
    this.found = el('section', 'kbn-ch-found')
    this.found.setAttribute('aria-label', 'Files found')
    rail.append(this.jump, this.list, this.found)
    return rail
  }
  private channelPane(): HTMLElement {
    this.channelEl = el('article', 'kbn-ch')
    this.channelEl.tabIndex = -1
    this.head = el('header', 'kbn-ch-head')
    this.stream = el('ol', 'kbn-ch-stream')
    this.stream.addEventListener('scroll', () => {
      const list = this.stream!
      this.following = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_PX
    }, { passive: true })
    this.dock = this.ctx!.workspace!.console({ keepPlace: true })
    this.dock.el.hidden = true
    this.channelEl.append(this.head, this.stream, this.dock.el)
    return this.channelEl
  }
  /** Opens the console on the channel's chair, with the draft kept for that channel; a chair with no worker to run has none. Its pages stand in the channel's head, so the console names none. */
  private seatConsole(channel: Channel | undefined): void {
    const dock = this.dock
    if (!dock) return
    dock.el.hidden = !channel || !onDesk(channel.seat)
    if (!channel || dock.el.hidden) return
    const was = this.drafted
    if (was && was !== channel.key) this.drafts.set(was, dock.draft)
    dock.open(channel.seat)
    if (was !== channel.key) { dock.draft = this.drafts.get(channel.key) ?? ''; this.drafted = channel.key }
  }
  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    ctx.workspace?.globeHost.feeds.refresh()
    this.draw()
    void ctx.sends?.refresh().catch(() => {})
    void this.read()
  }
  private async read(ctx = this.ctx): Promise<void> {
    if (this.reading || !ctx) return
    this.reading = true
    const generation = this.generation
    const records = await getDaemonJson<{ dismissed: string[]; pinned?: Record<string, number>; order?: { keys: string[]; at: number } | null; reach_ms: number }>(`${ctx.shuttleBase}/api/v1/channels/dismissed`)
      .then(value => ({ ok: true as const, value }), () => ({ ok: false as const }))
    if (generation !== this.generation) return
    this.reading = false
    this.loaded = true
    if (records.ok) {
      this.dismissed = records.value.dismissed
      this.pending = this.pending.filter(key => !this.dismissed.includes(key))
      // A pin made here stands until the feed carries one as new.
      for (const [key, at] of Object.entries(records.value.pinned ?? {})) this.pinned.set(key, Math.max(at, this.pinned.get(key) ?? 0))
      for (const [key, at] of this.pinned) if (Date.now() - at > records.value.reach_ms) this.pinned.delete(key)
      // An order written here stands until the feed carries one as new.
      const order = records.value.order
      if (order && order.at >= this.orderAt) { this.order = order.keys; this.orderAt = order.at }
    }
    this.status(records.ok ? '' : 'Some channel sources are unavailable — showing the last read.')
    this.draw()
    if (records.ok) this.keep()
    // Every channel in the rail reads its families, for what is new in it, and so does one whose line to the human stands, to learn whether it waits.
    const board = ctx.workspace!.board
    board.read(this.compose(ctx).filter(channel => channel.listed || channel.key === this.current || channel.members.some(card => board.waiting.has(fiberOf(card)))).flatMap(channel => channel.families))
  }
  /** The channels the board's cards make, with what the daemon keeps of their order, pins and hides. */
  private compose(ctx: ViewContext): Channel[] {
    const index = threadIndexFor(ctx.response)
    return composeChannels({
      cards: boardCards(ctx.response), parentOf: card => index.parentOf(card), names: ctx.workspace!.charterNames,
      dismissed: [...this.dismissed, ...this.pending], pinned: this.pinned, waits: ctx.workspace!.board.waiting, now: Date.now(),
    })
  }
  /** A channel's stream: what its families' records, its sent files and its threads' launches make of it. */
  private streamOf(channel: Channel, ctx = this.ctx!): Stream {
    const workspace = ctx.workspace!
    return composeStream({
      channel, records: workspace.board.records(channel.families), files: ctx.sends?.files ?? [], waits: workspace.board.waiting,
      launches: card => workspace.globeHost.feeds.marks(card)?.launches ?? [], cleared: clearedLines([...this.dismissed, ...this.pending]),
      now: Date.now(), reachMs: workspace.board.reachMs,
    })
  }
  /** Something addressed to the human arrived in the channel since this device last read it. */
  private unread(channel: Channel): boolean {
    const seen = lastSeen(channel.key)
    return this.streamOf(channel).entries.some(entry => entry.kind !== 'station' && entry.arrived > seen)
  }
  private status(text: string): void { if (this.note) this.note.textContent = text }
  /** The order and the hides lapse with the board's reach, so while they stand they are written again. */
  private keep(): void {
    const now = Date.now()
    if (this.order.length && now - this.orderAt > KEEP_MS) void this.writeOrder(this.order)
    for (const channel of this.channels) if (channel.hidden && now - channel.hidden > KEEP_MS) void this.dismiss(channel, hideKey(channel.key, now))
  }

  /**
   * The rail's channels, what waits on the human first and then in the human's
   * order: while Jump to looks for something, every channel it matches, hidden
   * ones too; otherwise those listed and the one being read, unless it is hidden.
   */
  private get listed(): Channel[] {
    const rail = railOrder(this.channels, this.order)
    if (!this.query) return rail.filter(channel => channel.listed || (channel.key === this.current && !channel.hidden))
    const query = this.query.toLowerCase()
    // A channel's key, its name, its title and its members are all searchable.
    return rail.filter(channel => [channel.key.slice(channel.key.indexOf(':') + 1), channel.name, channel.title, ...channel.members.flatMap(card => [card.name, card.path])].some(text => text.toLowerCase().includes(query)))
  }
  /** Filters the rail by what Jump to holds, from the rail's field or the bar's Find. */
  find(query: string): void {
    this.query = query.trim()
    if (this.jump && this.jump.value !== query) this.jump.value = query
    this.drawRail()
  }
  /** Enter in Jump to opens the first channel it found, else the first document. */
  private openFirst(): void {
    const channel = this.listed[0]
    if (channel) { this.find(''); this.open(channel.key, true); return }
    this.found?.querySelector<HTMLButtonElement>('button')?.click()
  }
  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.list || !this.loaded) return
    // Nothing redraws under the reader; coming back draws once and returns focus where the reader was opened from.
    if (ctx.workspace?.isActive) { this.depart(); return }
    const returning = this.away
    if (returning) for (const { unfold } of this.unfolds.values()) unfold.resume()
    this.away = false
    this.channels = this.compose(ctx)
    if (!this.channels.some(channel => channel.key === this.current)) this.resume()
    this.drawRail()
    this.drawChannel()
    if (returning) this.returnFocus()
  }
  /** Opens the reader from the item named `from`, which takes the focus back when the reader closes. */
  private leaveFor(from: string | null, open: () => void): void {
    this.returnTo = from
    this.depart()
    open()
  }
  /** The reader covers the channel: an unfolded file under it stops reading and playing, and the return is awaited. */
  private depart(): void {
    if (!this.away) for (const { unfold } of this.unfolds.values()) unfold.suspend()
    this.away = true
  }
  /** The item the reader was opened from (its unfolded file, when it has one, so ← → and Escape work at once), else the console. */
  private returnFocus(): void {
    const from = this.returnTo
    this.returnTo = null
    if (from && this.unfolds.get(from)?.unfold.focus()) return
    const item = from && this.layout?.querySelector<HTMLElement>(`[data-item="${CSS.escape(from)}"]`)
    if (item) item.focus({ preventScroll: true })
    else this.dock?.focus()
  }
  /** Fills `container` with `children`, leaving in place a child it already holds; the item that had focus in it keeps it. */
  private rebuild(container: HTMLElement, children: Node[]): void {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-item]')
    const item = focused && container.contains(focused) ? focused.dataset.item : undefined
    const keep = new Set(children)
    for (const node of [...container.childNodes]) if (!keep.has(node)) node.remove()
    children.forEach((child, index) => { if (container.childNodes[index] !== child) container.insertBefore(child, container.childNodes[index] ?? null) })
    if (item && !container.contains(document.activeElement)) container.querySelector<HTMLElement>(`[data-item="${CSS.escape(item)}"]`)?.focus({ preventScroll: true })
  }
  /**
   * Comes to a channel: the one left is read to now, and the families of the
   * one come to are read. Choosing it (not stepping with j / k) renews its pin
   * and brings it back to the rail if it was hidden. It looks at nothing.
   */
  private open(key: string | null, focus: boolean, deliberate = focus): void {
    if (key !== this.current) {
      if (this.current) store(SEEN + this.current, String(Date.now()))
      this.current = key
      if (key) { store(SEEN + key, String(Date.now())); store(LAST, key) }
      this.following = true
      this.marked = null
      const channel = this.channel
      if (channel) this.ctx?.workspace?.board.read(channel.families)
    }
    if (!focus) return
    if (key && deliberate) {
      this.renew(key)
      const channel = this.channels.find(each => each.key === key)
      if (channel?.hidden) void this.dismiss(channel, showKey(key, Date.now()))
    }
    if (isMobileViewport() || this.drawn) this.setRail(true)
    this.drawRail(); this.drawChannel()
    this.channelEl?.focus({ preventScroll: true })
  }
  /**
   * The board follows Rex to a worker: its channel opens, scrolled to that
   * worker's latest post (else the latest station on its line), which is
   * marked; false when no channel holds it.
   * Following looks at nothing and renews no pin.
   */
  reveal(id: string, origin: string): boolean {
    if (!this.loaded) return false
    let card: KanbanCard | undefined
    const channel = this.channels.find(each => (card = each.everyone.find(one => one.originId === origin && (one.uid === id || one.id === id))))
    if (!channel || !card) return false
    this.open(channel.key, true, false)
    this.marked = fiberOf(card)
    this.mark(true)
    return true
  }
  /** Marks the latest line of the worker Rex followed to, if the channel shows one; `bring` scrolls it into sight with the keys. */
  private mark(bring = false): void {
    for (const row of this.stream?.querySelectorAll('[data-marked]') ?? []) row.removeAttribute('data-marked')
    // Its latest post, else the latest station on its line.
    const own = this.marked ? [...this.stream?.querySelectorAll<HTMLElement>(`:scope > [data-fiber="${CSS.escape(this.marked)}"]`) ?? []] : []
    const row = own.filter(each => each.matches('.kbn-ch-item')).at(-1) ?? own.at(-1)
    if (!row) return
    row.setAttribute('data-marked', '')
    if (!bring) return
    row.scrollIntoView({ block: 'center' })
    row.querySelector<HTMLElement>('[data-item]')?.focus({ preventScroll: true })
  }
  /** With no channel to show, the one this device was last in, else the first listed; a phone shows its rail, with no channel behind it. */
  private resume(): void {
    const channel = this.current === null ? this.channels.find(each => each.key === stored(LAST)) : undefined
    this.open(isMobileViewport() ? null : channel?.key ?? this.listed[0]?.key ?? null, false)
  }
  private get channel(): Channel | undefined { return this.channels.find(channel => channel.key === this.current) }

  private drawRail(): void {
    const list = this.list!, rail = this.rail!, listed = this.listed
    rail.set(listed.map(channel => channel.key))
    // Nothing is rebuilt under an entry pressed or picked up; it is drawn once it lands.
    this.railStale = rail.moving
    if (rail.moving) return
    const unread = new Map(listed.map(channel => [channel.key, channel.key !== this.current && !channel.waiting && this.unread(channel)]))
    // A poll that changed nothing in the rail leaves it be.
    const sig = JSON.stringify([this.query, this.current, listed.map(channel => [channel.key, channel.name, channel.title, channel.chaired, channel.waiting, !!channel.hidden, unread.get(channel.key)])])
    if (sig === this.sigs.rail) { this.drawFound(); return }
    this.sigs.rail = sig
    for (const unbind of this.railBindings) unbind()
    this.railBindings = []
    const items: HTMLLIElement[] = []
    for (const channel of listed) {
      const item = el('li', 'kbn-ch-rail-item')
      item.toggleAttribute('data-waiting', channel.waiting)
      const pick = button('kbn-ch-pick', '', () => { this.find(''); this.open(channel.key, true) })
      pick.dataset.channel = channel.key
      pick.dataset.item = `channel:${channel.key}`
      pick.toggleAttribute('data-lone', !channel.chaired)
      pick.toggleAttribute('data-unread', unread.get(channel.key))
      pick.toggleAttribute('data-waiting', channel.waiting)
      pick.append(el('span', 'kbn-ch-pick-hash', channel.chaired ? '#' : '·'), el('span', 'kbn-ch-pick-name', channel.name))
      if (channel.hidden) pick.append(el('span', 'kbn-ch-pick-hidden', 'hidden'))
      // A dot means one of two things: gold, waiting on the human; ink, new since this device last read it.
      if (channel.waiting || unread.get(channel.key)) {
        const mark = el('span', channel.waiting ? 'kbn-ch-pick-mark' : 'kbn-ch-pick-unread')
        mark.title = channel.waiting ? 'Waiting on you' : 'New since you read it'
        pick.append(mark)
      }
      pick.title = channel.waiting ? `${channel.title} — waiting on you` : channel.title
      if (channel.key === this.current) pick.setAttribute('aria-current', 'true')
      pick.setAttribute('aria-haspopup', 'menu')
      item.append(pick)
      items.push(item)
      // What waits on the human stays on top, and Jump to's matches are not the rail's order.
      this.railBindings.push(rail.attach(pick, channel.key, channel.waiting || !!this.query))
    }
    if (this.query && !items.length) items.push(el('li', 'kbn-ch-hush kbn-ch-none', 'No channel matches.'))
    this.rebuild(list, items)
    this.drawFound()
  }
  /** The documents Jump to matches, across every channel and every fiber the fleet sent from. */
  private drawFound(): void {
    const found = this.found!, query = this.query.toLowerCase(), library = this.ctx?.workspace?.library
    const matches = !query || !library ? [] : library.documents().filter(({ card, receipt }) =>
      [receipt.basename, receipt.fullPath, declaredTitle(receipt.key)?.title ?? '', card.name].some(text => text.toLowerCase().includes(query)))
      .slice(0, FOUND_DOCUMENTS)
    found.hidden = !matches.length
    const now = Date.now(), list = el('ol', 'kbn-ch-doclist')
    list.append(...matches.map(({ card, receipt }) => {
      const item = el('li', ''), id = `found:${receipt.key}`
      const pick = button('kbn-ch-doc', '', () => this.openPage(id, card, receipt.key))
      pick.dataset.item = id
      pick.title = receipt.fullPath
      pick.append(el('span', 'kbn-ch-doc-name', declaredTitle(receipt.key)?.title ?? receipt.basename), el('span', 'kbn-ch-doc-meta', `${slug(card)} · ${relative(receipt.timestamp, now)}`))
      item.append(pick)
      return item
    }))
    this.rebuild(found, [el('h4', 'kbn-ch-shelf', 'Files'), list])
  }

  private drawChannel(): void {
    if (!this.head || !this.stream) return
    const channel = this.channel
    this.seatConsole(channel)
    this.layout?.toggleAttribute('data-channel', !!channel)
    if (!channel) {
      this.sigs = { ...this.sigs, head: '', stream: '' }
      this.head.replaceChildren(this.railToggle!.root, el('p', 'kbn-ch-empty', this.channels.length ? 'Choose a channel.' : 'No channels yet.'))
      this.stream.replaceChildren()
      this.sweep(new Set())
      this.rows.clear()
      return
    }
    const now = Date.now(), { entries, running } = this.streamOf(channel), failed = channel.families.some(uid => this.ctx!.workspace!.board.failed(uid))
    const seat = channel.seat
    // The head and the stream are drawn apart, so what arrives leaves a focused page or an open menu in the head be.
    const head = JSON.stringify([channel.key, channel.name, channel.title, fiberOf(seat), seat.modifiedAt, this.ctx!.workspace!.globeHost.feeds.files(seat).length])
    if (head !== this.sigs.head) {
      this.sigs.head = head
      const back = iconButton('kbn-ch-back', 'back', 'Channels', () => this.setRail(false))
      const name = el('h3', 'kbn-ch-name')
      name.append(channel.chaired ? el('span', 'kbn-ch-handle', channel.name) : channel.name)
      name.toggleAttribute('data-lone', !channel.chaired)
      name.title = channel.title
      // The chair's pages: opening one is a deliberate look at the chair.
      const pages = docButtons(seat, { ...this.ctx!.workspace!.globeHost.feeds, open: (card, doc) => this.leaveFor(null, () => this.ctx?.workspace?.openPage(card, doc)) })
      pages.classList.add('kbn-ch-pages')
      const menu: IconButton = iconButton('kbn-ch-menu', 'actions', 'Channel menu', () => this.railMenu(channel.key, menu.button))
      menu.button.setAttribute('aria-haspopup', 'menu')
      this.head.replaceChildren(this.railToggle!.root, back.root, name, pages, menu.root)
    }
    const waits = this.ctx!.workspace!.board.waiting
    // A row draws an entry; the thread's state, which moves while its worker runs, is painted on it in place.
    // A line follows the one before it in its group: the row above, of the same thread, moments before.
    const grouped = entries.map((entry, row) => { const before = entries[row - 1]; return entry.kind !== 'station' && before?.kind !== 'station' && groups(before, entry) })
    // What the elements draw of its card: its name, slug and office.
    const said = entries.map((entry, row) => [entry.id, entry.kind, entry.at, entry.card.name, slug(entry.card), entry.card.shuttleRole, entry.line, entry.kind === 'station' ? [entry.what, entry.end] : [entry.text, entry.waiting, entry.clears, kindWord(entry), grouped[row], entry.files.map(file => [file.host, file.fullPath, file.timestamp])]])
    // Each fiber's newest close leads its previews with its tapestry; an older close lets its go.
    const newest = new Map<string, Item>()
    for (const entry of entries) if (entry.kind === 'close') newest.set(fiberOf(entry.card), entry)
    const leading = new Set(newest.values())
    for (const entry of entries) {
      const made = entry.kind === 'close' && !leading.has(entry) ? this.unfolds.get(`item:${entry.id}`) : undefined
      if (made?.lead) { made.lead = undefined; this.showPreviews(made) }
    }
    const leads = entries.map(entry => this.unfolds.get(`item:${entry.id}`)?.lead?.key)
    // The width a post's previews wrap in: the stream's, less the gutter and the post's padding.
    const wide = this.stream.clientWidth ? this.stream.clientWidth - TUBE.gutter - 26 : Infinity
    const stream = JSON.stringify([channel.key, failed, said, entries.map(entry => [attentionOf(entry.card, waits), turnOf(entry.card).turn]), leads, wide])
    if (stream !== this.sigs.stream) {
      this.sigs.stream = stream
      // Each row reckoned by its parts' sizes, a post's by its previews as they wrap (a tapestry it shows leading them), before anything in it loads.
      const tube = layTube(entries, entries.map((entry, row) => entry.kind === 'station' ? rowHeight(entry) : POST_PX + previewsHeight([...leads[row] ? ['tapestry.html'] : [], ...entry.files.map(file => file.fullPath)], wide)))
      // The lanes share their room, each step no wider than the mock's nine pixels.
      this.stream.style.setProperty('--kbn-ch-tube', `${TUBE.gutter}px`)
      const lay = { waits, now, last: entries.length - 1 }
      this.running = ranked(running, waits)
      const count = el('li', 'kbn-ch-count'), ring = button('kbn-ch-count-ring', String(this.running.length), () => this.bundleMenu())
      ring.hidden = !this.running.length
      ring.title = this.runningTitle()
      ring.setAttribute('aria-label', ring.title)
      ring.setAttribute('aria-haspopup', 'menu')
      count.append(ring)
      this.entriesDrawn = entries
      this.titles.clear()
      const kept = new Set<string>()
      this.rebuild(this.stream, [count, ...entries.map((entry, row) => {
        const sig = JSON.stringify(said[row]), was = this.rows.get(entry.id)
        const node = was?.sig === sig ? was.node : entry.kind === 'station' ? this.stationRow(entry, now) : this.itemRow(entry, now, grouped[row])
        this.rows.set(entry.id, { sig, node })
        kept.add(entry.id)
        if (was?.node === node && entry.kind !== 'station') node.querySelector(':scope > .constitution-state-dot')?.replaceWith(this.dot(entry))
        node.dataset.row = String(row)
        const own = tube.rows[row].own
        node.dataset.state = own ? this.lineState(own.line, waits) : ''
        if (own) node.dataset.hue = hue(own.line.card)
        const gutter = this.gutter(tube.rows[row], row, lay)
        if (node.firstChild instanceof SVGSVGElement) node.firstChild.replaceWith(gutter)
        else node.prepend(gutter)
        return node
      })])
      for (const id of this.rows.keys()) if (!kept.has(id)) this.rows.delete(id)
      this.mark()
      for (const close of leading) this.lead(close)
      this.sweep(new Set(entries.flatMap(entry => entry.kind === 'station' ? [] : [`item:${entry.id}`])))
      if (!entries.length) this.stream.append(el('li', 'kbn-ch-hush', failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing addressed to you here yet.'))
      if (this.following) this.stream.scrollTop = this.stream.scrollHeight
    }
    retime(this.layout!, now)
  }
  /** A line's colour: the thread's state now while the line runs, the ink once it has ended. */
  private lineState(line: TubeLine, waits: Waits): string {
    return line.to === Infinity ? attentionOf(line.card, waits) : 'ended'
  }
  /** What a line says on hover: whose it is, and every station along it; worked out once a draw. */
  private lineTitle(line: TubeLine, now: number): string {
    const kept = this.titles.get(line.id)
    if (kept) return kept
    const said = this.entriesDrawn.flatMap(entry => {
      if (entry.line !== line.id) return []
      const what = entry.kind === 'station' ? { start: 'started', tick: 'handed off', end: entry.end ?? 'closed' }[entry.what] : kindWord(entry)
      return [[what, relative(entry.at, now)].filter(Boolean).join(' ')]
    })
    const title = `${slug(line.card)}: ${[...line.from < 0 ? ['running before this stretch'] : [], ...said].join(', ')}`
    this.titles.set(line.id, title)
    return title
  }
  /** The entries the stream last drew, row by row. */
  private entriesDrawn: Entry[] = []
  private readonly titles = new Map<string, string>()
  /**
   * A row's gutter: the bundle every running line rides, a heavier neutral
   * line; the lanes of the lines out of it beside their events; and the row's
   * own event — a start's ring curving into its lane or into the bundle, an
   * item's stub, a handoff's open ring, an end curving to its terminus — a
   * line leaving the bundle on a curve just above its event and rejoining it
   * just below. A line, a stub or a station opens its constitution's view;
   * the bundle lists the threads it carries.
   */
  private gutter(row: TubeRow, index: number, lay: { waits: Waits; now: number; last: number }): SVGSVGElement {
    const box = svg('svg', { class: 'kbn-ch-gutter', width: TUBE.gutter })
    box.setAttribute('aria-hidden', 'true')
    const lane = (excursion: Excursion): number => TUBE.first + TUBE.pitch * excursion.lane
    const bx = TUBE.bundle, station = TUBE.gutter - TUBE.dot / 2, r = TUBE.radius
    const own = row.own, y = own ? STATION_Y[own.what] : 0
    const group = (line: TubeLine): SVGGElement => {
      const g = svg('g', { class: 'kbn-ch-line', 'data-line': line.id, 'data-state': this.lineState(line, lay.waits), 'data-hue': hue(line.card) })
      const title = svg('title', {})
      title.textContent = this.lineTitle(line, lay.now)
      g.append(title)
      g.addEventListener('click', event => { event.stopPropagation(); this.openLine(line.card) })
      return g
    }
    const path = (g: SVGGElement, d: string, className = 'kbn-ch-track'): void => { g.append(svg('path', { class: className, d }), svg('path', { class: 'kbn-ch-hit', d })) }
    // The bundle: through the row, or from where a line joins it, or down to where one leaves.
    const { top, bottom } = row.bundle
    if (top || bottom) {
      const g = svg('g', { class: 'kbn-ch-bundle' })
      const title = svg('title', {})
      title.textContent = this.runningTitle()
      g.append(title)
      g.addEventListener('click', event => { event.stopPropagation(); this.bundleMenu({ x: event.clientX, y: event.clientY }) })
      // Where the bundle meets the row's own line: a curve leaving or rejoining it nine pixels off the event, a wired start's or end's arc its radius off.
      const meet = own?.leaves || own?.rejoins ? 9 : own && !own.excursion && (own.what === 'start' || own.what === 'end') ? r : 0
      const span = { x1: bx, x2: bx, y1: top ? 0 : y + meet, y2: bottom ? '100%' : y - meet }
      g.append(svg('line', { class: 'kbn-ch-bundle-v', ...span }), svg('line', { class: 'kbn-ch-hit', ...span }))
      // Lines still running run on past the last row to the stream's foot.
      if (bottom && index === lay.last) g.append(svg('rect', { class: 'kbn-ch-bundle-foot', x: bx - 1.25, y: '100%', width: 2.5, height: 10 }))
      box.append(g)
    }
    for (const excursion of row.through) {
      const g = group(excursion.line), x = lane(excursion)
      const span = { x1: x, x2: x, y1: 0, y2: '100%' }
      g.append(svg('line', { class: 'kbn-ch-track', ...span }), svg('line', { class: 'kbn-ch-hit', ...span }))
      box.append(g)
    }
    if (!own) return box
    const g = group(own.line), ex = own.excursion
    // Where the row's line runs: its lane, or the bundle it is wired to.
    const lx = ex ? lane(ex) : bx
    if (ex) {
      // Out of the bundle just above the event, back into it just below; a lane through the event's row between.
      const enter = own.leaves ? `M${bx} ${Math.max(0, y - 9)}C${bx} ${y - 4} ${lx} ${y - 6} ${lx} ${y - 1}` : own.what === 'start' || own.what === 'end' ? '' : `M${lx} 0V${y}`
      if (enter) path(g, enter)
      if (own.rejoins) path(g, `M${lx} ${y}C${lx} ${y + 5} ${bx} ${y + 3} ${bx} ${y + 9}`)
      else if (own.what !== 'end' && own.what !== 'start') g.append(svg('line', { class: 'kbn-ch-track', x1: lx, x2: lx, y1: y, y2: '100%' }))
    }
    if (own.what === 'start') {
      path(g, `M${station - 4} ${y}H${lx + r}A${r} ${r} 0 0 0 ${lx} ${y + r}`)
      // Into its lane, on down the row; into the bundle, which carries it on.
      if (ex && !own.rejoins) g.append(svg('line', { class: 'kbn-ch-track', x1: lx, x2: lx, y1: y + r, y2: '100%' }))
      g.append(svg('circle', { class: 'kbn-ch-ring', cx: station, cy: y, r: 3.5 }))
    } else if (own.what === 'end') {
      path(g, `M${lx} ${ex ? 0 : y - r}${ex ? `V${y - r}` : ''}A${r} ${r} 0 0 0 ${lx + r} ${y}H${station - 4}`)
      const shape = own.line.end ?? 'closed'
      if (shape === 'tempered') g.append(svg('path', { class: 'kbn-ch-term', 'data-end': shape, d: `M${station} ${y - 4.5}L${station + 4.5} ${y}L${station} ${y + 4.5}L${station - 4.5} ${y}Z` }))
      else if (shape === 'discarded') g.append(svg('path', { class: 'kbn-ch-cross', 'data-end': shape, d: `M${station - 3.5} ${y - 3.5}L${station + 3.5} ${y + 3.5}M${station + 3.5} ${y - 3.5}L${station - 3.5} ${y + 3.5}` }))
      else g.append(svg('rect', { class: 'kbn-ch-term', 'data-end': shape, x: station - 3, y: y - 3, width: 6, height: 6 }))
    } else {
      // An item's stub to its dot; a handoff's stub to an open ring.
      path(g, `M${lx} ${y}H${station - (own.what === 'tick' ? 3 : 5)}`)
      g.append(svg('circle', { class: 'kbn-ch-junction', cx: lx, cy: y, r: 2 }))
      if (own.what === 'tick') g.append(svg('circle', { class: 'kbn-ch-hand', cx: station, cy: y, r: 3 }))
    }
    box.append(g)
    return box
  }
  private runningTitle(): string {
    return `${this.running.length} running: ${this.running.map(card => slug(card)).join(', ')}`
  }
  /** The threads running now, listed as thread rows: each opens its constitution's view. */
  private bundleMenu(point?: { x: number; y: number }): void {
    // The count's ring is the list's anchor, wherever on the bundle it was asked for: focus returns to it.
    const anchor = this.stream?.querySelector<HTMLElement>(':scope > .kbn-ch-count > .kbn-ch-count-ring')
    const workspace = this.ctx?.workspace
    if (!this.running.length || !anchor || !workspace) return
    // The threads as they stand now, not as the stream last drew them.
    const now = Date.now(), waits = workspace.board.waiting, current = new Map(this.channel?.everyone.map(card => [fiberOf(card), card]))
    openActionMenu(anchor, ranked(this.running.map(card => current.get(fiberOf(card)) ?? card), waits).map(card => ({
      label: `${slug(card)}: ${doing(card, waits, workspace.said(card)).text}`,
      content: threadRow(card, { waits, now, said: workspace.said(card), hue: hue(card) }),
      run: () => this.openLine(card),
    })), `${this.running.length} running`, point)
  }
  /** A line, a station or a terminus opens its constitution's view, as an item does, and moves nothing else. */
  private openLine(card: KanbanCard, from: string | null = null): void {
    this.leaveFor(from, () => this.ctx?.workspace?.openFromDesk(card))
  }
  /** A station on a line: a start's ring and slug, a tick, or an end's terminus; the slug is written here, once per line. */
  private stationRow(station: Station, now: number): HTMLLIElement {
    const row = el('li', `kbn-ch-station kbn-ch-st-${station.what}`)
    row.dataset.line = station.line
    row.dataset.fiber = fiberOf(station.card)
    row.dataset.slug = slug(station.card)
    row.dataset.what = station.what === 'end' ? `end:${station.end ?? 'closed'}` : station.what
    if (station.what === 'start') {
      // The thread as a chip (its slug and office); the ring in the margin is its dot.
      const who = button('kbn-ch-slug', '', () => this.openLine(station.card, `station:${station.id}`))
      who.append(threadRow(station.card, { waits: this.ctx!.workspace!.board.waiting, now, density: 'chip', hue: hue(station.card) }))
      who.dataset.item = `station:${station.id}`
      const what = { start: 'started', tick: 'handed off', end: station.end ?? 'closed' }[station.what]
      who.title = `${station.card.name} — ${what} ${relative(station.at, now)}`
      row.append(who)
    } else {
      const what = station.what === 'tick' ? 'handed off' : station.end ?? 'closed'
      row.setAttribute('aria-label', `${slug(station.card)} ${what} ${relative(station.at, now)}`)
      row.title = `${slug(station.card)} ${what} ${relative(station.at, now)}`
    }
    return row
  }
  /** One thing a worker addressed to the human, as a post (elements/post.ts). */
  private itemRow(item: Item, now: number, grouped: boolean): HTMLLIElement {
    const id = `item:${item.id}`
    const open = (): void => this.leaveFor(id, () => this.ctx?.workspace?.openFromDesk(item.card))
    return post(item, {
      now, dot: this.dot(item), open, grouped, clear: this.check(item),
      previews: item.kind === 'close' || item.files.length ? this.previews(item, id) : undefined,
    })
  }
  /** An item's state dot, which opens its worker's view. */
  private dot(item: Item): HTMLButtonElement {
    return stateDot(item.card, this.ctx!.workspace!.board.waiting, () => this.leaveFor(`item:${item.id}`, () => this.ctx?.workspace?.openFromDesk(item.card)))
  }
  /**
   * A line's ✓, on every post and file line: the line leaves the stream, and
   * a waiting post stops waiting too. A question or a close that waits is
   * answered, not cleared, and has none.
   */
  private check(item: Item): HTMLButtonElement | undefined {
    if (item.waiting ? !item.clears : item.kind !== 'post' && item.kind !== 'file') return undefined
    const { card } = item
    const done = button('kbn-ch-clear', '✓', () => {
      done.disabled = true
      void this.clearLine(item, done)
    })
    done.title = item.clears ? 'Clear: read, nothing to answer; take it from the stream' : 'Clear: read, take it from the stream'
    done.setAttribute('aria-label', `Clear ${card.name}'s ${item.kind === 'file' ? 'files' : 'post'}`)
    return done
  }
  /**
   * Takes a line out of the stream, across the fleet, and a post that waits
   * stops waiting, with one undo for a few seconds that restores both; the
   * line after it takes the focus. A refused write brings it back and says so.
   */
  private async clearLine(item: Item, done: HTMLButtonElement): Promise<void> {
    const ctx = this.ctx, board = ctx?.workspace?.board
    if (!ctx) return
    const row = done.closest('.kbn-ch-item'), held = row?.contains(document.activeElement)
    const next = [...this.stream?.querySelectorAll<HTMLElement>(':scope > .kbn-ch-item') ?? []]
    const after = (next[next.indexOf(row as HTMLElement) + 1] ?? next[next.indexOf(row as HTMLElement) - 1])?.querySelector<HTMLElement>('[data-item]')?.dataset.item
    const at = Date.now(), fiber = fiberOf(item.card), waits = item.clears
    const lines = lineIds(item).map(id => ({ id, key: clearLineKey(id, at) }))
    this.pending.push(...lines.map(line => line.key))
    this.draw()
    // The line after it may be drawn anew (ungrouped, it takes a head): it is found again by its id.
    if (held && after) this.stream?.querySelector<HTMLElement>(`[data-item="${CSS.escape(after)}"]`)?.focus({ preventScroll: true })
    const write = (key: string, failure: string): Promise<boolean> =>
      postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber }, failure).then(() => true, () => {
        this.pending = this.pending.filter(each => each !== key)
        return false
      })
    // The clear first: a line write refused after it leaves a post that no longer waits, still in the stream with its ✓.
    let cleared: number | undefined
    try {
      if (waits && board) cleared = await board.clear(waits)
    } catch {
      this.pending = this.pending.filter(each => !lines.some(line => line.key === each))
      this.draw()
      this.status(`${item.card.name}'s line could not be cleared; it is as it was.`)
      return
    }
    // Each line its own record: a clear names every line it took.
    const written = await Promise.all(lines.map(line => write(line.key, 'Clear failed'))), taken = lines.filter((_, index) => written[index])
    if (taken.length < lines.length) {
      this.draw()
      this.status(cleared !== undefined ? `${item.card.name}'s line could not be taken from the stream; it no longer waits.`
        : taken.length ? `Some of ${item.card.name}'s files could not be taken from the stream.` : `${item.card.name}'s line could not be cleared; it is as it was.`)
    }
    if (!taken.length && cleared === undefined) return
    // The undo takes back what was written.
    clearToast(`Cleared ${slug(item.card)}'s ${taken.length ? 'line' : 'post'}.`, () => {
      if (waits && board && cleared !== undefined) void board.unclear(waits, cleared).catch(() => this.status(`${item.card.name}'s post could not be brought back; it stays cleared.`))
      if (!taken.length) return
      const backAt = Date.now(), backs = taken.map(line => unclearLineKey(line.id, backAt))
      this.pending.push(...backs)
      this.draw()
      void Promise.all(backs.map(back => write(back, 'Undo failed'))).then(done => {
        if (done.every(Boolean)) return
        this.draw()
        this.status(`${item.card.name}'s line could not be brought back; it stays cleared.`)
      })
    })
  }
  /**
   * An item's files below its words, each at its density's box in a row that
   * wraps (elements/filePreview.ts); a click unfolds one
   * in place under a bar pinned as it scrolls, ← and → step through them and
   * Escape folds it. A close leads with its tapestry, found as the read says.
   */
  private previews(item: Item, id: string): HTMLElement {
    const { card } = item
    const made = this.unfolds.get(id) ?? this.unfolds.set(id, {
      unfold: new Unfold({
        shuttleBase: this.ctx?.shuttleBase ?? '', awake: () => !this.ctx?.workspace?.isActive && !!this.stream?.isConnected,
        // Full screen opens the file in the reader; its way back returns to this item, the file still unfolded.
        full: key => this.openPage(id, card, key),
      }), files: [],
    }).get(id)!
    const files = item.files.map((file): UnfoldFile => {
      const key = docKey(file.host ?? card.originId, file.fullPath, card.originId, card.fiberDir)
      return { key, name: declaredTitle(key)?.title ?? file.basename, at: file.timestamp }
    })
    made.files = files
    this.showPreviews(made)
    made.unfold.el.classList.add('kbn-ch-previews')
    return made.unfold.el
  }
  private showPreviews(made: { unfold: Unfold; lead?: UnfoldFile; files: UnfoldFile[] }): void {
    made.unfold.update([...made.lead ? [made.lead] : [], ...made.files.filter(file => file.key !== made.lead?.key)])
  }
  /**
   * A fiber's newest close's tapestry, read again on every draw of the stream:
   * a tapestry written since takes its place at the head of its previews, and
   * the stream is laid out again with it.
   */
  private lead(item: Item): void {
    const id = `item:${item.id}`, made = this.unfolds.get(id)
    if (!made) return
    void this.ctx?.workspace?.globeHost.feeds.lead(item.card).then(lead => {
      if (!lead || made.lead?.key === lead.key || this.unfolds.get(id) !== made) return
      made.lead = { key: lead.key, name: lead.name }
      this.showPreviews(made)
      this.draw()
    })
  }
  /** Lets go of the previews the stream no longer draws. */
  private sweep(wanted: ReadonlySet<string>): void {
    for (const [id, { unfold }] of this.unfolds) if (!wanted.has(id)) { unfold.dispose(); this.unfolds.delete(id) }
  }

  /** Writes a channel's unpin, hide or show, counting at once here; a write that fails is taken back and said. */
  private async dismiss(channel: Channel, key: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    if (key.startsWith('pin:')) this.pinned.delete(channel.key)
    this.pending.push(key)
    this.draw()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber: fiberOf(channel.seat) })
    } catch {
      this.pending = this.pending.filter(item => item !== key)
      this.draw()
      const done = ({ pin: 'unpinned', hide: 'hidden', show: 'brought back' } as Record<string, string>)[key.split(':')[0]]
      this.status(`${channel.name} could not be ${done}; it is as it was.`)
    }
  }
  /** A rail entry's menu: hide or bring back, pin or unpin, move to the bottom. */
  private railMenu(key: string, pick: HTMLElement, point?: { x: number; y: number }): void {
    const channel = this.channels.find(each => each.key === key)
    if (!channel) return
    const now = Date.now()
    openActionMenu(pick, [
      channel.hidden
        ? { label: 'Unhide', run: () => { void this.dismiss(channel, showKey(key, now)) } }
        : { label: 'Hide', run: () => { void this.dismiss(channel, hideKey(key, now)); announce(`${channel.name} hidden; Jump to finds it.`) } },
      channel.pinned
        ? { label: 'Unpin', run: () => { void this.dismiss(channel, unpinKey(key, now)) } }
        : { label: 'Pin', run: () => { void this.pin(channel); this.draw() } },
      { label: 'Move to bottom', run: () => { void this.writeOrder([...this.arrangement().filter(each => each !== key), key]) } },
    ], channel.name, point)
  }
  /** Every channel's key in the human's order. */
  private arrangement(): string[] { return arranged(this.channels, this.order).map(channel => channel.key) }
  /** A move landed in the rail: the channels it shows that do not wait take the order they were dropped in. */
  private reorder(keys: string[]): void {
    const waiting = new Set(this.channels.filter(channel => channel.waiting).map(channel => channel.key))
    void this.writeOrder(reordered(this.arrangement(), keys.filter(key => !waiting.has(key))))
  }
  /** Keeps the human's order here at once and across the fleet once the daemon has it. */
  private async writeOrder(keys: string[]): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    this.order = keys
    this.orderAt = Date.now()
    this.drawRail()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/order', { keys }, 'Order failed')
    } catch (error) {
      this.status(`The channels' order is kept here only: ${error instanceof Error ? error.message : String(error)}`)
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

  /** Whether the rail is a drawer: the view is narrow, not a phone's. */
  private get drawn(): boolean { return !!this.layout?.hasAttribute('data-drawer') }
  /** The rail is drawn in over the stream. */
  private overDrawer(): boolean { return this.drawn && this.drawer }
  private railShown(): boolean { return isMobileViewport() ? this.phoneRail : this.drawn ? this.drawer : !this.railHidden }
  /**
   * Hides or shows the rail: remembered on this device where it is a column;
   * a drawer in a narrow view, put away by default; on a phone, the rail is the
   * screen before a channel.
   */
  private setRail(hidden: boolean): void {
    if (isMobileViewport()) {
      this.phoneRail = !hidden
      // The rail is the phone's screen: the channel left is read up to now, and none stands behind the rail, unseen.
      if (!hidden && this.current) { this.open(null, false); this.drawRail(); this.drawChannel() }
    } else if (this.drawn) this.drawer = !hidden
    else {
      if (hidden === this.railHidden) return
      this.railHidden = hidden
      store(RAIL, hidden ? '1' : '0')
    }
    this.showRail()
  }
  private showRail(): void {
    const shown = this.railShown()
    this.layout?.toggleAttribute('data-rail-hidden', !shown)
    if (!this.railToggle) return
    this.railToggle.name(shown ? 'Hide channels' : 'Show channels')
    this.railToggle.button.setAttribute('aria-expanded', String(shown))
  }
  /**
   * Sideways gestures while Channels is the surface shown: drawn rightward
   * across a channel they bring the rail, leftward they put it away. A
   * two-finger trackpad swipe does the same. Content that scrolls sideways keeps it.
   */
  private gestures(root: HTMLElement): () => void {
    const onSurface = (target: EventTarget | null): boolean => !this.ctx?.workspace?.isActive && !!(target as Element | null)?.closest?.('.kbn-ch, .kbn-ch-rail')
    // Leftward over a phone's rail goes back to the channel last read there.
    const swipe = (rightward: boolean): void => {
      if (rightward) this.setRail(false)
      else if (this.channel) this.setRail(true)
      else if (isMobileViewport() && this.channels.some(channel => channel.key === stored(LAST))) this.open(stored(LAST), true, false)
    }
    let start: { x: number; y: number } | null = null
    let travel = 0, last = 0
    const down = (event: TouchEvent): void => {
      start = event.touches.length === 1 && onSurface(event.target) ? { x: event.touches[0].clientX, y: event.touches[0].clientY } : null
    }
    const up = (event: TouchEvent): void => {
      const end = event.changedTouches[0], from = start
      start = null
      if (!from || !end) return
      const dx = end.clientX - from.x, dy = end.clientY - from.y
      if (Math.abs(dx) < SWIPE_PX || Math.abs(dy) > Math.abs(dx) || scrollsSideways(event.target as Element, root, -dx)) return
      swipe(dx > 0)
    }
    const wheel = (event: WheelEvent): void => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !onSurface(event.target) || scrollsSideways(event.target as Element, root, event.deltaX)) return
      // Taking the gesture keeps the browser from going back a page.
      event.preventDefault()
      // One swipe is a burst of wheel events: it acts once, and a pause starts the next.
      if (event.timeStamp - last > 300) travel = 0
      last = event.timeStamp
      if (Number.isNaN(travel)) return
      travel += event.deltaX
      if (Math.abs(travel) < SWIPE_PX) return
      swipe(travel < 0)
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

  /** Opens a fiber's page, or one of its documents, from the item named `from`. */
  private openPage(from: string, card: KanbanCard, key?: string): void {
    this.leaveFor(from, () => this.ctx?.workspace?.openPage(card, key))
  }
  /** j / k page through the rail's channels, looking at nothing. */
  private step(by: number): void {
    const listed = this.listed
    if (!listed.length) return
    const at = listed.findIndex(channel => channel.key === this.current)
    this.open(listed[Math.max(0, Math.min(listed.length - 1, at + by))].key, true, false)
  }

  keydown(event: KeyboardEvent): boolean {
    // An entry picked up in the rail owns the keys until it lands.
    if (this.rail?.moving) return true
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const active = document.activeElement as HTMLElement | null
    const replying = !!active?.closest('.ws-dock')
    if (event.key === 'Escape' && (replying || active === this.jump)) { this.channelEl?.focus({ preventScroll: true }); return true }
    // Enter in the bar's Find opens what it found first.
    if (event.key === 'Enter' && this.query && isTypingTarget(active) && !replying && active !== this.jump) { this.openFirst(); return true }
    if (keystrokeIsSpokenFor()) return false
    // An unfolded file keeps the keys typed in it; its own are ←, →, ↑, ↓ and Escape.
    if (active?.closest('.uf[data-unfolded]')) return false
    if (event.key === 'Escape' && this.overDrawer()) { this.setRail(true); return true }
    if (event.key === '/' && this.jump) { this.setRail(false); this.jump.focus({ preventScroll: true }); return true }
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.setRail(this.railShown()); return true }
    if (event.key === 'Enter' && !active?.closest('button, a, input') && this.channel) { this.dock?.focus(); return true }
    // e clears the line in focus, as its ✓ does.
    const check = event.key === 'e' ? active?.closest('.kbn-ch-item')?.querySelector<HTMLButtonElement>('.kbn-ch-clear:not(:disabled)') : null
    if (check) { check.click(); return true }
    return false
  }
  unmount(): void {
    // A document still being read from its owner does not open once Channels is left.
    this.ctx?.workspace?.library.cancelOpen()
    if (this.dock && this.drafted) this.drafts.set(this.drafted, this.dock.draft)
    if (this.current) store(SEEN + this.current, String(Date.now()))
    this.query = ''
    this.sweep(new Set())
    this.rows.clear()
    this.generation++
    for (const stop of this.unsubscribe) stop()
    this.unsubscribe = []
    this.stopGestures?.(); this.stopGestures = undefined
    this.width?.disconnect(); this.width = null
    this.consoleSize?.disconnect(); this.consoleSize = null
    for (const unbind of this.railBindings) unbind()
    this.railBindings = []
    this.rail?.destroy(); this.rail = null
    this.reading = false
    this.ctx = null
    this.layout = this.channelEl = this.head = this.note = null
    this.list = null; this.found = null; this.jump = null; this.stream = null; this.railToggle = null
    this.dock?.reset(); this.dock = null
    this.drafted = null
    this.sigs = { rail: '', head: '', stream: '' }
  }
}

registerView(new ChannelsView())
