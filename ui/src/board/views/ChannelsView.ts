import { announce } from '@ui-sdk/core'
import '@ui-sdk/web/tooltip'
import { relative, retime } from '../elements/time.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import {
  arranged, clearLineKey, clearedLines, lineIds, composeChannels, composeStream, fiberOf, runningIn, hideKey, railOrder, reordered, showKey, unclearLineKey, unpinKey,
  type Channel, type Entry, type Item, type Station,
} from '../channels.js'
import { layTube, rowHeight, runsOf, tautness, type Tube, type TubeLine } from '../tube.js'
import { drawMargin, tautAlong, type MarginRow } from '../margin.js'
import { random, ribbon } from '../ink.js'
import { lineHue } from '../lineHue.js'
import { createRailReorder, type RailReorder } from '../channelRail.js'
import { openActionMenu } from '../conversationMenu.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { clearToast, fewAtATime } from '../utils.js'
import { ATTENTION_ORDER, attentionOf, lastActive, type Waits } from '../attention.js'
import { turnOf } from '../turn.js'
import { docKey } from '../workspace/documents.js'
import { headerIcon, type HeaderIcon } from '../workspace/headerIcon.js'
import { declaredTitle, watchDocumentTitles } from '../workspace/DocumentTitles.js'
import { docButtons, type DocButtons } from '../workspace/docButtons.js'
import { foldPx, previewsHeight, Unfold, type UnfoldFile } from '../elements/filePreview.js'
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
/** How many of a clear's records are written at once: each write is a process in the daemon. */
const CLEAR_WRITES = 4
/** A stream within this many pixels of its foot follows what arrives. */
const FOLLOW_PX = 24
/** Jump to lists at most this many documents beneath the channels it matches. */
const FOUND_DOCUMENTS = 12
/** Narrower than this, the rail is a drawer drawn in over the stream. */
const DRAWER_PX = 1100
/** The margin's width: wide on a desktop, where the fibres can wander; narrower where the stream's width is scarce. */
const MARGIN = { wide: 56, narrow: 40, below: 560 } as const
/** The strand's count: how far below the top of what is in sight its swelling's middle stands, how far down it looks for the strand, and where it stands with none. */
const COUNT = { at: 24, reach: 160, alone: 9 } as const
/** The count's swelling: a short spindle of the strand's ink, a little off true, as a varicosity on a fibre. */
const SWELLING = { width: 8, height: 18 } as const
function swelling(): SVGSVGElement {
  const { width, height } = SWELLING, box = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  box.setAttribute('class', 'kbn-ch-count-swelling')
  box.setAttribute('width', String(width)); box.setAttribute('height', String(height))
  box.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  const spine = Array.from({ length: 13 }, (_, i): [number, number] => [width / 2 + 0.35 * Math.sin(i / 2.2), (i / 12) * height])
  path.setAttribute('d', ribbon(spine, u => 0.9 + 3.3 * Math.sin(Math.PI * Math.min(1, u * 1.08)) ** 2.2))
  box.append(path)
  return box
}
/** How freely the fibres wander and how heavy their ink is, at each width. */
const INK = { wide: { chaos: 1.6, weight: 1.15 }, narrow: { chaos: 1, weight: 1.05 } } as const
/** What stops a worker's run, among a thread's records. */
const STOPS = new Set(['handed_off', 'closed', 'rested', 'asked'])
const hue = lineHue
/** The threads a stretch of the strand gathers, one per thread. */
const gatheredCards = (lines: readonly TubeLine[]): KanbanCard[] => [...new Map(lines.map(line => [fiberOf(line.card), line.card])).values()]

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
 * question, post, close or sent files as one compact item, beside a margin
 * of its threads' lives drawn in fine ink (`layTube`, `drawMargin`), each a
 * fibre where it speaks, its posts hanging from it on drops. Choosing an item
 * or a fibre opens that constitution's view; its files unfold in place.
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
  /** The chair's pages in the head. */
  private pages?: DocButtons
  /** The channel the head was last drawn for. */
  private headKey?: string
  private stream: HTMLOListElement | null = null
  private note: HTMLElement | null = null
  /** The console, to the channel's chair. */
  private dock: Dock | null = null
  /** Whose draft the console holds: the channel it was last opened on. */
  private drafted: string | null = null
  /** What was typed to each channel's chair, by channel, kept while the reader is elsewhere. */
  private readonly drafts = new Map<string, string>()
  /** Each item's files as previews that unfold in place, by item, kept across redraws with the close's tapestry it found. */
  private readonly unfolds = new Map<string, { unfold: Unfold; lead?: UnfoldFile; files: UnfoldFile[]; asked?: boolean }>()
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
   * each with a live worker ({@link runningIn}), what waits on the human first, then what
   * works, each by its latest activity. The strand's count numbers them, and it and
   * the strand list them.
   */
  private running: KanbanCard[] = []
  /** The stream follows what arrives while the reader is at its foot. */
  private following = true
  /** Where the stream stood at its last scroll or when it was last put at its foot: a scroll event that finds it there was not the reader moving. */
  private lastTop = 0
  /** The worker Rex last brought this channel to, whose latest line is marked. */
  private marked: string | null = null
  /** The marked line is still to be brought into sight, its records not yet drawn. */
  private bring = false
  private railHidden = false
  /** A phone shows the rail until a channel is chosen. */
  private phoneRail = true
  /** Where the view is narrow, the rail is a drawer drawn in over the stream, put away once a channel is chosen. */
  private drawer = false
  private dismissed: string[] = []
  private pending: string[] = []
  /** Each line's clear still being written, by the line's id: the wait it cleared, and its writes (the clear's, and its undo's once asked) settling. */
  private readonly lineClears = new Map<string, { clears?: string; settled: Promise<unknown> }>()
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
      // Only the reader's own scroll leaves the foot: rows that grow before a scroll's event arrives leave the stream following.
      const moved = Math.abs(this.stream!.scrollTop - this.lastTop) > 1
      this.lastTop = this.stream!.scrollTop
      if (this.atFoot()) this.following = true
      else if (moved) this.following = false
      this.placeCount()
      if (!this.painting && this.leavingBand()) this.painting = requestAnimationFrame(() => { this.painting = 0; this.paint() })
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
  private streamOf(channel: Channel, ctx = this.ctx!): Entry[] {
    const workspace = ctx.workspace!
    return composeStream({
      channel, records: workspace.board.records(channel.families), files: ctx.sends?.files ?? [], waits: workspace.board.waiting,
      launches: card => workspace.globeHost.feeds.marks(card)?.launches ?? [], cleared: clearedLines([...this.dismissed, ...this.pending]),
      now: Date.now(), reachMs: workspace.board.reachMs,
    })
  }
  /** How many things addressed to the human arrived in the channel since this device last read it. */
  private unread(channel: Channel): number {
    const seen = lastSeen(channel.key)
    return this.streamOf(channel).filter(entry => entry.kind !== 'station' && entry.arrived > seen).length
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
      this.marked = null
      this.renew(key)
      const channel = this.channels.find(each => each.key === key)
      if (channel?.hidden) void this.dismiss(channel, showKey(key, Date.now()))
    }
    if (isMobileViewport() || this.drawn) this.setRail(true)
    this.drawRail(); this.drawChannel(); this.mark()
    this.channelEl?.focus({ preventScroll: true })
  }
  /**
   * The board follows Rex to a worker: its channel opens, scrolled to that
   * worker's latest post (else the latest station on its line), which is
   * marked; false when no channel holds it. A uid names one fiber on every
   * host, and a channel keeps one copy of each, so a uid matches any host's.
   * Following looks at nothing and renews no pin; while the human types it
   * moves nothing.
   */
  followRex(id: string, origin: string): boolean {
    this.marked = null
    if (!this.loaded) { this.mark(); return false }
    let card: KanbanCard | undefined
    const channel = this.channels.find(each => (card = each.everyone.find(one => one.uid === id || (one.id === id && one.originId === origin))))
    if (!channel || !card) { this.mark(); return false }
    // While the human types, in the console or a field, Channels stays where it is.
    if (isTypingTarget(document.activeElement as HTMLElement | null)) { this.mark(); return true }
    this.open(channel.key, true, false)
    this.marked = fiberOf(card)
    this.bring = true
    this.mark()
    return true
  }
  /**
   * Marks the latest line of the worker Rex followed to, if the channel shows
   * one. Brought to it, the first draw that holds the line scrolls it into
   * sight and gives it the keys, even when its records arrive after.
   */
  private mark(): void {
    for (const row of this.stream?.querySelectorAll('[data-marked]') ?? []) row.removeAttribute('data-marked')
    // Its latest post, else the latest station on its line.
    const own = this.marked ? [...this.stream?.querySelectorAll<HTMLElement>(`:scope > [data-fiber="${CSS.escape(this.marked)}"]`) ?? []] : []
    const row = own.filter(each => each.matches('.kbn-ch-item')).at(-1) ?? own.at(-1)
    if (!row) return
    row.setAttribute('data-marked', '')
    if (!this.bring) return
    this.bring = false
    if (isTypingTarget(document.activeElement as HTMLElement | null)) return
    row.scrollIntoView({ block: 'center' })
    // Brought to the stream's newest line, the stream still follows; brought to any other, it stays on that line.
    this.lastTop = this.stream!.scrollTop
    this.following = row === this.stream!.lastElementChild && this.atFoot()
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
    const unread = new Map(listed.map(channel => [channel.key, channel.key !== this.current && !channel.waiting ? this.unread(channel) : 0]))
    const waits = this.ctx!.workspace!.board.waiting
    const owed = new Map(listed.map(channel => [channel.key, channel.members.filter(card => attentionOf(card, waits) === 'waiting').length]))
    // A poll that changed nothing in the rail leaves it be.
    const sig = JSON.stringify([this.query, this.current, listed.map(channel => [channel.key, channel.name, channel.title, channel.chaired, channel.waiting, !!channel.hidden, unread.get(channel.key), owed.get(channel.key)])])
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
      pick.toggleAttribute('data-unread', !!unread.get(channel.key))
      pick.toggleAttribute('data-waiting', channel.waiting)
      pick.append(el('span', 'kbn-ch-pick-hash', channel.chaired ? '#' : '·'), el('span', 'kbn-ch-pick-name', channel.name))
      if (channel.hidden) pick.append(el('span', 'kbn-ch-pick-hidden', 'hidden'))
      // A ringed count means one of two things: in gold, how many wait on the human; in the ink, how many are new since this device last read it.
      if (channel.waiting || unread.get(channel.key)) {
        const count = channel.waiting ? Math.max(1, owed.get(channel.key)!) : unread.get(channel.key)!
        const mark = el('span', channel.waiting ? 'kbn-ch-pick-mark' : 'kbn-ch-pick-unread', String(count))
        mark.title = channel.waiting ? `${count} waiting on you` : `${count} new since you read it`
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
    const now = Date.now(), entries = this.streamOf(channel), failed = channel.families.some(uid => this.ctx!.workspace!.board.failed(uid))
    const seat = channel.seat
    // The head and the stream are drawn apart, so what arrives leaves a focused page or an open menu in the head be;
    // the head waits while a list hangs from its pages, whose count follows the chair's files in place, unless the channel changed: then the list closes.
    const head = JSON.stringify([channel.key, channel.name, channel.title, fiberOf(seat), seat.modifiedAt])
    const listing = this.headKey === channel.key && !!this.pages?.el.querySelector('[aria-expanded="true"]')
    if (head !== this.sigs.head && !listing) {
      this.pages?.close()
      this.sigs.head = head
      this.headKey = channel.key
      const back = iconButton('kbn-ch-back', 'back', 'Channels', () => this.setRail(false))
      const name = el('h3', 'kbn-ch-name')
      name.append(channel.chaired ? el('span', 'kbn-ch-handle', channel.name) : channel.name)
      name.toggleAttribute('data-lone', !channel.chaired)
      name.title = channel.title
      // The chair's pages: opening one is a deliberate look at the chair.
      this.pages = docButtons(seat, { ...this.ctx!.workspace!.globeHost.feeds, open: (card, doc) => this.leaveFor(null, () => this.ctx?.workspace?.openPage(card, doc)) })
      this.pages.el.classList.add('kbn-ch-pages')
      const menu: IconButton = iconButton('kbn-ch-menu', 'actions', 'Channel menu', () => this.railMenu(channel.key, menu.button))
      menu.button.setAttribute('aria-haspopup', 'menu')
      this.head.replaceChildren(this.railToggle!.root, back.root, name, this.pages.el, menu.root)
    } else this.pages?.refresh()
    const waits = this.ctx!.workspace!.board.waiting, running = ranked(runningIn(channel), waits)
    // A row draws an entry; the thread's state, which moves while its worker runs, is painted on it in place.
    // A line follows the one before it in its group: the row above, of the same thread, moments before.
    const grouped = entries.map((entry, row) => { const before = entries[row - 1]; return entry.kind !== 'station' && before?.kind !== 'station' && groups(before, entry) })
    // What the elements draw of its card: its name, slug and office.
    const said = entries.map((entry, row) => [entry.id, entry.kind, entry.at, entry.card.name, slug(entry.card), entry.card.shuttleRole, entry.line, entry.kind === 'station' ? [entry.what, entry.end] : [entry.text, entry.waiting, entry.clears, kindWord(entry), grouped[row], entry.files.map(file => [file.host, file.fullPath, file.timestamp]), lineIds(entry)]])
    // Each fiber's newest close leads its previews with its tapestry; an older close lets its go.
    const newest = new Map<string, Item>()
    for (const entry of entries) if (entry.kind === 'close') newest.set(fiberOf(entry.card), entry)
    const leading = new Set(newest.values())
    for (const entry of entries) {
      const made = entry.kind === 'close' && !leading.has(entry) ? this.unfolds.get(`item:${entry.id}`) : undefined
      if (made?.lead && !made.asked) { made.lead = undefined; this.showPreviews(made) }
    }
    const leads = entries.map(entry => this.unfolds.get(`item:${entry.id}`)?.lead?.key)
    // The margin's width, and how tall a folded preview stands.
    const margin = this.stream.clientWidth && this.stream.clientWidth < MARGIN.below ? MARGIN.narrow : MARGIN.wide
    const fold = foldPx()
    // A fibre's tension follows its runs, which can move with no row moving (a relaunch inside a life).
    const runs = this.runs(channel, now, waits)
    const ran = [...new Set(entries.map(entry => entry.card))].map(card => runs(card).map(([from, to]) => [from, to === now ? 'now' : to]))
    // The count and its title name the threads running, what waits first, which can change with no entry changing.
    const stream = JSON.stringify([channel.key, failed, said, entries.map(entry => [attentionOf(entry.card, waits), turnOf(entry.card).turn]), leads, fold, margin, ran, running.map(card => [fiberOf(card), attentionOf(card, waits)])])
    if (stream !== this.sigs.stream) {
      this.sigs.stream = stream
      // Each row reckoned by its parts' sizes, a post's by its previews (a tapestry it shows leading them), before anything in it loads.
      const heights = entries.map((entry, row) => entry.kind === 'station' ? rowHeight(entry) : POST_PX + previewsHeight([...leads[row] ? ['tapestry.html'] : [], ...entry.files.map(file => file.fullPath)], fold))
      const index = threadIndexFor(this.ctx!.response)
      // Every thread in a channel is its chair's: a parent reaches to a sub-thread only below the chair.
      const parentOf = (card: KanbanCard): KanbanCard | undefined => { const parent = index.parentOf(card); return parent && fiberOf(parent) !== fiberOf(seat) ? parent : undefined }
      const tube = layTube(entries, heights, { parentOf, grouped, active: line => attentionOf(line.card, waits) === 'working' })
      this.tube = { tube, grouped, margin, taut: tautAlong(tube, entries.map(entry => entry.at), line => runs(line.card), tautness) }
      this.stream.style.setProperty('--kbn-ch-tube', `${margin}px`)
      this.running = running
      const count = el('li', 'kbn-ch-count'), label = button('kbn-ch-count-label', '', () => this.bundleMenu())
      label.hidden = !this.running.length
      label.title = this.runningTitle()
      label.setAttribute('aria-label', label.title)
      label.setAttribute('aria-haspopup', 'menu')
      label.append(swelling(), el('span', 'kbn-ch-count-n', String(this.running.length)))
      count.append(label)
      // The margin's ink, one drawing over the whole stream, laid over the rows once they stand.
      const ink = el('li', 'kbn-ch-margin')
      ink.setAttribute('aria-hidden', 'true')
      ink.addEventListener('click', event => this.marginClick(event))
      this.entriesDrawn = entries
      this.titles.clear()
      const kept = new Set<string>()
      this.rebuild(this.stream, [count, ink, ...entries.map((entry, row) => {
        // A lead asked onto a post with no previews gives it a row of them; elsewhere the previews take it in place.
        const grows = entry.kind !== 'station' && entry.kind !== 'close' && !entry.files.length && !!leads[row]
        const sig = JSON.stringify([said[row], grows]), was = this.rows.get(entry.id)
        const node = was?.sig === sig ? was.node : entry.kind === 'station' ? this.stationRow(entry, now) : this.itemRow(entry, now, grouped[row])
        this.rows.set(entry.id, { sig, node })
        kept.add(entry.id)
        if (was?.node === node && entry.kind !== 'station') node.querySelector(':scope > .constitution-state-dot')?.replaceWith(this.dot(entry))
        node.dataset.row = String(row)
        const line = entry.line ? tube.lines.find(each => each.id === entry.line) : undefined
        node.dataset.state = line ? this.lineState(line, waits) : ''
        if (line) node.dataset.hue = hue(line.card)
        return node
      })])
      for (const id of this.rows.keys()) if (!kept.has(id)) this.rows.delete(id)
      for (const close of leading) this.lead(close)
      this.sweep(new Set(entries.flatMap(entry => entry.kind === 'station' ? [] : [`item:${entry.id}`])))
      if (!entries.length) this.stream.append(el('li', 'kbn-ch-hush', failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing addressed to you here yet.'))
      if (this.following) this.toFoot()
      this.mark()
      this.watchRows()
      this.paint()
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
    const title = `${line.card.name} — ${[...line.from < 0 ? ['running before this stretch'] : [], ...said].join(', ')}`
    this.titles.set(line.id, title)
    return title
  }
  /** The entries the stream last drew, row by row. */
  private entriesDrawn: Entry[] = []
  private readonly titles = new Map<string, string>()
  /** The stream's layout as last drawn, which the margin is painted from whenever a row's height moves. */
  private tube: { tube: Tube; grouped: boolean[]; margin: number; taut: (line: TubeLine, s: number) => number; painted?: string } | null = null
  /** Watches the stream's rows, so a preview that loads or a window that narrows repaints the margin. */
  private rowSizes: ResizeObserver | null = null
  private painting = 0
  /** Where the strand runs at each height of the last painting, so its count can sit on it. */
  private strandAt: (y: number) => number | undefined = () => undefined
  private watchRows(): void {
    this.rowSizes ??= new ResizeObserver(() => {
      // A row that grows late (a tapestry found, a figure's proportions read) or a stream that shortens (the console growing, the window) keeps a stream that follows at its foot, unless a file unfolded there is being read.
      if (this.following && !this.stream?.querySelector('[data-unfolded]')) this.toFoot()
      if (this.painting) return
      this.painting = requestAnimationFrame(() => { this.painting = 0; this.paint() })
    })
    this.rowSizes.disconnect()
    if (this.stream) this.rowSizes.observe(this.stream)
    for (const row of this.stream?.children ?? []) this.rowSizes.observe(row)
  }
  private atFoot(): boolean {
    const list = this.stream
    return !!list && list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_PX
  }
  private toFoot(): void {
    const list = this.stream
    if (!list) return
    list.scrollTop = list.scrollHeight
    this.lastTop = list.scrollTop
  }
  /**
   * Paints the margin over the rows as they stand: one SVG of fine ink
   * (`margin.ts`), its lengths mapped from the layout's reckoning onto the
   * rows' measured tops, so nothing is re-phased when a row grows.
   */
  private paint(): void {
    const stream = this.stream, laid = this.tube, holder = stream?.querySelector(':scope > .kbn-ch-margin')
    if (!stream || !laid || !holder) return
    const began = performance.now()
    const nodes = this.entriesDrawn.map(entry => this.rows.get(entry.id)?.node)
    if (nodes.some(node => !node)) return
    const rows: MarginRow[] = this.entriesDrawn.map((entry, row) => ({ entry, grouped: laid.grouped[row], top: nodes[row]!.offsetTop, height: nodes[row]!.offsetHeight }))
    const heavier = Number(getComputedStyle(stream).getPropertyValue('--kbn-ink-weight')) || 1
    // A band of three screens about what is in sight is drawn; rows standing where they stood, in the same ink and band, are already painted.
    const top = stream.scrollTop, screen = stream.clientHeight || 900, band = [top - screen, top + 2 * screen] as const
    const sig = `${heavier}:${rows.map(row => `${row.top},${row.height}`).join(';')}`
    if (laid.painted === sig && holder.firstChild && !this.leavingBand(top)) return
    laid.painted = sig
    const inked = performance.now(), now = Date.now(), ink = INK[laid.margin === MARGIN.wide ? 'wide' : 'narrow'], last = rows.at(-1)
    const drawn = drawMargin(laid.tube, rows, last ? last.top + last.height : 0, {
      width: laid.margin, chaos: ink.chaos, weight: ink.weight * heavier, hue: line => hue(line.card), taut: laid.taut,
      title: line => this.lineTitle(line, now), band,
      gatheredTitle: lines => { const cards = gatheredCards(lines); return `${cards.length} gathered here: ${cards.map(card => slug(card)).join(', ')}` },
      markTitle: entry => entry.kind === 'station' ? `${entry.card.name} — ${{ start: 'started', tick: 'handed off', end: entry.end ?? 'closed' }[entry.what]} ${relative(entry.at, now)}` : entry.card.name,
    })
    performance.measure('kbn-ch-ink', { start: inked })
    holder.replaceChildren(drawn.svg)
    this.strandAt = drawn.strandAt
    this.band = drawn.band
    this.placeCount(top)
    // What a painting costs, whole and in its ink alone, for the performance probes to read.
    performance.measure('kbn-ch-margin', { start: began })
  }
  /** The measured band the margin was last drawn over. */
  private band: readonly [number, number] = [0, 0]
  /** What is in sight has come within half a screen of an edge of the drawn band that is not the stream's own. */
  private leavingBand(top = this.stream?.scrollTop ?? 0): boolean {
    const stream = this.stream
    if (!stream) return false
    const screen = stream.clientHeight, [from, to] = this.band
    return (from > 0 && top < from + screen / 2) || (to < stream.scrollHeight - 8 && top + screen > to - screen / 2)
  }
  /**
   * The count's swelling sits on the strand, at the top of what is in sight;
   * where the strand begins lower, at its first inked point; with no strand
   * near, at the margin's edge.
   */
  private placeCount(top = this.stream?.scrollTop ?? 0): void {
    const label = this.stream?.querySelector<HTMLElement>(':scope > .kbn-ch-count > .kbn-ch-count-label')
    if (!label) return
    let x: number | undefined, y = top + COUNT.at
    for (; y <= top + COUNT.at + COUNT.reach; y += 4) if ((x = this.strandAt(y)) !== undefined) break
    label.style.left = `${(x ?? COUNT.alone) - SWELLING.width / 2}px`
    label.style.top = `${(x === undefined ? 0 : y - top - COUNT.at)}px`
  }
  /** A fibre or a mark opens its line's constitution; the strand lists the threads it gathers. */
  private marginClick(event: MouseEvent): void {
    const target = event.target as Element
    // A finger cannot hover: the first tap on a mark, a fibre or the strand names it, a second on the same thing opens it.
    if ((event as Partial<PointerEvent>).pointerType === 'touch') {
      const named = target.closest('.kbn-ch-mark, .kbn-ch-fibre, .kbn-ch-gathered'), title = named?.querySelector(':scope > title')?.textContent
      if (named && title && this.named?.of !== named) { event.stopPropagation(); this.name(named, title, event); return }
    }
    this.named?.label.remove(); this.named = null
    const gathered = target.closest<SVGGElement>('.kbn-ch-gathered')?.dataset.gathered
    if (gathered !== undefined) {
      event.stopPropagation()
      this.bundleMenu({ x: event.clientX, y: event.clientY }, gatheredCards(this.tube?.tube.gathered[Number(gathered)]?.lines ?? []))
      return
    }
    const id = target.closest<SVGGElement>('.kbn-ch-fibre')?.dataset.line
    const line = id ? this.tube?.tube.lines.find(each => each.id === id) : undefined
    if (line) { event.stopPropagation(); this.openLine(line.card) }
  }
  /** What a first tap on the margin named, and the label that names it. */
  private named: { of: Element; label: HTMLElement } | null = null
  private name(of: Element, title: string, event: MouseEvent): void {
    const stream = this.stream
    if (!stream) return
    this.named?.label.remove()
    const label = el('span', 'kbn-ch-named', title), box = stream.getBoundingClientRect()
    label.style.left = `${event.clientX - box.left + 10}px`
    label.style.top = `${event.clientY - box.top + stream.scrollTop - 26}px`
    stream.querySelector(':scope > .kbn-ch-margin')?.append(label)
    this.named = { of, label }
  }
  /** Each thread's runs ({@link runsOf}): its launches, stopped by its handoffs, closes, rests and questions. */
  private runs(channel: Channel, now: number, waits: Waits): (card: KanbanCard) => Array<[number, number]> {
    const workspace = this.ctx!.workspace!, records = workspace.board.records(channel.families), memo = new Map<KanbanCard, Array<[number, number]>>()
    return card => memo.get(card) ?? memo.set(card, runsOf(
      workspace.globeHost.feeds.marks(card)?.launches ?? [],
      records.filter(record => STOPS.has(record.kind) && (record.fiber === card.uid || record.fiber === card.id)).map(record => record.timestamp),
      { now, working: attentionOf(card, waits) === 'working', last: lastActive(card) },
    )).get(card)!
  }
  private runningTitle(): string {
    return `${this.running.length} running: ${this.running.map(card => slug(card)).join(', ')}`
  }
  /** The threads running now, listed as thread rows: each opens its constitution's view. */
  private bundleMenu(point?: { x: number; y: number }, gathered?: KanbanCard[]): void {
    // The count is the list's anchor, wherever on the strand it was asked for: focus returns to it.
    const anchor = this.stream?.querySelector<HTMLElement>(':scope > .kbn-ch-count > .kbn-ch-count-label')
    const workspace = this.ctx?.workspace, cards = gathered ?? this.running
    if (!cards.length || !anchor || !workspace) return
    // The threads as they stand now, not as the stream last drew them.
    const now = Date.now(), waits = workspace.board.waiting, current = new Map(this.channel?.everyone.map(card => [fiberOf(card), card]))
    openActionMenu(anchor, ranked(cards.map(card => current.get(fiberOf(card)) ?? card), waits).map(card => ({
      label: `${slug(card)}: ${doing(card, waits, workspace.said(card)).text}`,
      content: threadRow(card, { waits, now, said: workspace.said(card), hue: hue(card) }),
      run: () => this.openLine(card),
    })), gathered ? `${cards.length} gathered here` : `${cards.length} running`, point)
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
      previews: item.kind === 'close' || item.files.length || this.unfolds.get(id)?.lead ? this.previews(item, id) : undefined,
    })
  }
  /** An item's state dot, which opens its worker's view. */
  private dot(item: Item): HTMLButtonElement {
    const dot = stateDot(item.card, this.ctx!.workspace!.board.waiting, () => this.leaveFor(`item:${item.id}`, () => this.ctx?.workspace?.openFromDesk(item.card)))
    // Each drop a little different, and the same each time it is drawn.
    const shape = random(`drop:${item.id}`)
    dot.style.setProperty('--drop-w', `${(6.6 + shape() * 1.4).toFixed(2)}px`)
    dot.style.setProperty('--drop-h', `${(5.4 + shape() * 1.2).toFixed(2)}px`)
    dot.style.setProperty('--drop-turn', `${Math.round((shape() - 0.5) * 50)}deg`)
    dot.title = `${item.card.name} — ${dot.title}`
    return dot
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
   * stops waiting; the line after it takes the focus. One undo is offered as
   * soon as the line leaves, for a few seconds, and restores both: what was
   * written is written back, and what was not yet written never is. The
   * line's records are written a few at a time ({@link CLEAR_WRITES}). A
   * refused write brings back what it would have taken and says so. A line
   * cleared again before its last clear's writes (and their undo's) land
   * waits for them, so it clears what waits then.
   */
  private async clearLine(item: Item, done: HTMLButtonElement): Promise<void> {
    const ctx = this.ctx, board = ctx?.workspace?.board
    if (!ctx) return
    const row = done.closest('.kbn-ch-item'), held = row?.contains(document.activeElement)
    const next = [...this.stream?.querySelectorAll<HTMLElement>(':scope > .kbn-ch-item') ?? []]
    const after = (next[next.indexOf(row as HTMLElement) + 1] ?? next[next.indexOf(row as HTMLElement) - 1])?.querySelector<HTMLElement>('[data-item]')?.dataset.item
    const at = Date.now(), fiber = fiberOf(item.card)
    const lines = lineIds(item).map(id => ({ id, key: clearLineKey(id, at) }))
    this.pending.push(...lines.map(line => line.key))
    this.draw()
    // The line after it may be drawn anew (ungrouped, it takes a head): it is found again by its id.
    if (held && after) this.stream?.querySelector<HTMLElement>(`[data-item="${CSS.escape(after)}"]`)?.focus({ preventScroll: true })
    const drop = (keys: readonly string[]): void => { this.pending = this.pending.filter(each => !keys.includes(each)) }
    const write = (key: string, failure: string): Promise<boolean> =>
      postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber }, failure).then(() => true, () => { drop([key]); return false })
    // The clear first: a line write refused after it leaves a post that no longer waits, still in the stream with its ✓.
    // A line cleared again while its earlier clear, or that clear's undo, is still being written waits for it, so it sees whether the post waits.
    const before = this.lineClears.get(item.id), waits = item.clears ?? before?.clears
    const clearing = (async () => {
      if (before) await before.settled
      return waits && board ? board.clear(waits) : undefined
    })()
    // Held while its writes are in flight, and let go once they land, so a later clear goes by what waits then.
    const hold = (settled: Promise<unknown>): void => {
      const entry = { clears: waits, settled }
      this.lineClears.set(item.id, entry)
      void settled.then(() => { if (this.lineClears.get(item.id) === entry) this.lineClears.delete(item.id) })
    }
    hold(clearing.catch(() => {}))
    // Each line's write once it starts, true when it was written.
    const sent = new Map<(typeof lines)[number], Promise<boolean>>()
    let undone = false
    clearToast(`Cleared ${slug(item.card)}'s line.`, () => {
      undone = true
      // A line not yet written is never written; one written, or on its way, is brought back once it lands.
      drop(lines.filter(line => !sent.has(line)).map(line => line.key))
      const backAt = Date.now(), backs = [...sent.keys()].map(line => ({ line, key: unclearLineKey(line.id, backAt) }))
      this.pending.push(...backs.map(back => back.key))
      this.draw()
      hold(clearing.then(cleared => {
        if (waits && board && cleared !== undefined) return board.unclear(waits, cleared).catch(() => this.status(`${item.card.name}'s post could not be brought back; it stays cleared.`))
      }, () => {}))
      void fewAtATime(backs, CLEAR_WRITES, async back => await sent.get(back.line) ? write(back.key, 'Undo failed') : (drop([back.key]), true)).then(done => {
        if (done.every(Boolean)) return
        this.draw()
        this.status(`${item.card.name}'s line could not be brought back; it stays cleared.`)
      })
    })
    let cleared: number | undefined
    try {
      cleared = await clearing
    } catch {
      drop(lines.map(line => line.key))
      this.draw()
      this.status(`${item.card.name}'s line could not be cleared; it is as it was.`)
      return
    }
    // Each line its own record: a clear names every line it took.
    const written = await fewAtATime(lines, CLEAR_WRITES, line => {
      if (undone) return Promise.resolve(undefined)
      const sending = write(line.key, 'Clear failed')
      sent.set(line, sending)
      return sending
    })
    const refused = written.filter(each => each === false).length
    if (!refused) return
    this.draw()
    this.status(cleared !== undefined ? `${item.card.name}'s line could not be taken from the stream; it no longer waits.`
      : refused < lines.length ? `Some of ${item.card.name}'s files could not be taken from the stream.` : `${item.card.name}'s line could not be cleared; it is as it was.`)
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
        // A link that goes somewhere leaves as full screen does; one that goes nowhere leaves the page as it is.
        link: (key, href) => { if (this.ctx?.workspace?.openLink(card, key, href)) { this.returnTo = id; this.depart() } },
        opening: () => this.foldOthers(id),
      }), files: [],
    }).get(id)!
    const files = item.files.map((file): UnfoldFile => {
      const key = docKey(file.host ?? card.originId, file.fullPath, card.originId, card.fiberDir)
      return { key, name: declaredTitle(key)?.title ?? file.basename, at: file.timestamp, caption: file.caption }
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
      made.lead = { key: lead.key, name: lead.name, at: lead.at }
      this.showPreviews(made)
      this.draw()
    })
  }
  /**
   * `t` on a post: its worker's tapestry unfolds in the post's previews, at
   * their head as a close's leads them, or folds if it is the one unfolded;
   * a worker with no tapestry says so.
   */
  private async unfoldTapestry(id: string): Promise<void> {
    const item = this.entriesDrawn.find((entry): entry is Item => entry.kind !== 'station' && `item:${entry.id}` === id)
    const lead = item && await this.ctx?.workspace?.globeHost.feeds.lead(item.card)
    if (!item || !this.entriesDrawn.includes(item)) return
    if (!lead) { announce(`${slug(item.card)} has no tapestry`); return }
    const held = this.unfolds.get(id)
    if (held?.unfold.unfolded === lead.key) { held.unfold.fold(); return }
    if (held?.lead?.key !== lead.key) {
      const made = held ?? (this.previews(item, id), this.unfolds.get(id)!)
      made.lead = { key: lead.key, name: lead.name, at: lead.at }
      made.asked = true
      this.showPreviews(made)
      this.sigs.stream = ''
      this.drawChannel()
    }
    const made = this.unfolds.get(id)
    made?.unfold.unfold(lead.key)
    made?.unfold.el.scrollIntoView({ block: 'start' })
  }
  /**
   * One file unfolded in the stream at a time: an unfolded file is a live
   * page, polled while it shows. The others fold without moving what the
   * human is looking at, whatever a fold above it takes out of the stream.
   */
  private foldOthers(id: string): void {
    const others = [...this.unfolds].filter(([other, { unfold }]) => other !== id && unfold.unfolded)
    if (!others.length) return
    const here = this.unfolds.get(id)?.unfold.el, top = here?.getBoundingClientRect().top
    for (const [, { unfold }] of others) unfold.fold(false)
    if (here && top !== undefined && this.stream) this.stream.scrollTop += here.getBoundingClientRect().top - top
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
    // t unfolds the tapestry of the post in focus beneath it, and from inside it folds it.
    const post = event.key === 't' ? active?.closest<HTMLElement>('.kbn-ch-item')?.querySelector<HTMLElement>('[data-item]')?.dataset.item : undefined
    if (post) { void this.unfoldTapestry(post); return true }
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
    this.rowSizes?.disconnect(); this.rowSizes = null
    cancelAnimationFrame(this.painting); this.painting = 0
    this.tube = null
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
