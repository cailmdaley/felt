import { announce } from '@ui-sdk/core'
import '@ui-sdk/web/tooltip'
import { ago } from '../civilDay.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import {
  arranged, composeChannels, composeStream, fiberOf, handle, hideKey, railOrder, reordered, showKey, unpinKey,
  type Channel, type Entry, type Item,
} from '../channels.js'
import { createRailReorder, type RailReorder } from '../channelRail.js'
import { openActionMenu } from '../conversationMenu.js'
import type { SentFile } from '../sentFiles.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { threadState } from '../threads.js'
import { renderMarkdown } from '../utils.js'
import { docKey, parseDocKey } from '../workspace/documents.js'
import { headerIcon, type HeaderIcon } from '../workspace/headerIcon.js'
import { declaredTitle, watchDocumentTitles } from '../workspace/DocumentTitles.js'
import type { DocKey } from '../workspace/documents.js'
import { docButtons } from '../workspace/docButtons.js'
import { LOAD_POLICY, Thumbnail } from '../workspace/Thumbnail.js'
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
/** A stream within this many pixels of its foot follows what arrives. */
const FOLLOW_PX = 24
/** Jump to lists at most this many documents beneath the channels it matches. */
const FOUND_DOCUMENTS = 12
/** A file drawn as its thumbnail: a page or a figure. */
const DRAWN = /\.(html?|png|jpe?g|gif|svg|webp)$/i
/** Narrower than this, the rail is a drawer drawn in over the stream. */
const DRAWER_PX = 1100

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
/** What an item says before its words. */
const kindWord = (item: Item): string =>
  item.kind === 'close' ? threadState(item.card) === 'to-review' ? 'for review' : 'closed' : { ask: 'asks', post: 'posted', file: 'sent' }[item.kind]

/**
 * Channels: a rail of the channels (what waits on the human floated to the
 * top, the rest in the human's order, each movable and with a menu to hide,
 * pin or move it; Jump to finds the rest and the fleet's documents), and a
 * channel's stream of what its workers addressed to the human — each worker's
 * question, post, close or sent files as one compact item, with small marks
 * between them for every thread started, closed or handed off. Choosing an
 * item opens that constitution's view; its pages open from its thumbnails.
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
  /** The thumbnails in the stream, by item and file, kept across redraws. */
  private readonly thumbs = new Map<string, Thumbnail>()
  /** Each close's tapestry, by item: the page it opens and its button, kept across redraws. */
  private readonly leads = new Map<string, { doc: DocKey; button: HTMLButtonElement }>()
  /** Which thumbnails are near the view, and so worth a live body. */
  private near: IntersectionObserver | null = null
  private channels: Channel[] = []
  private current: string | null = null
  /** What Jump to is looking for; '' lists the rail. */
  private query = ''
  /** The item a document or view was opened from, which takes focus again when the reader closes. */
  private returnTo: string | null = null
  /** The reader stands over Channels: nothing redraws beneath it. */
  private away = false
  /** The stream follows what arrives while the reader is at its foot. */
  private following = true
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
    this.near = new IntersectionObserver(entries => {
      for (const { target, isIntersecting } of entries) {
        const thumbnail = [...this.thumbs.values()].find(each => each.el === target)
        if (thumbnail) { thumbnail.near = isIntersecting; thumbnail.schedule() }
      }
    }, { rootMargin: LOAD_POLICY.ring })
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
      dismissed: [...this.dismissed, ...this.pending], pinned: this.pinned, waiting: ctx.workspace!.board.waiting, now: Date.now(),
    })
  }
  /** A channel's stream: what its families' records, its sent files and its threads' launches make of it. */
  private entries(channel: Channel, ctx = this.ctx!): Entry[] {
    const workspace = ctx.workspace!
    return composeStream({
      channel, records: workspace.board.records(channel.families), files: ctx.sends?.files ?? [], waiting: workspace.board.waiting,
      launches: card => workspace.globeHost.feeds.marks(card)?.launches ?? [], now: Date.now(), reachMs: workspace.board.reachMs,
    })
  }
  /** Something addressed to the human arrived in the channel since this device last read it. */
  private unread(channel: Channel): boolean {
    const seen = lastSeen(channel.key)
    return this.entries(channel).some(entry => entry.kind !== 'mark' && entry.arrived > seen)
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
    return rail.filter(channel => [channel.title, ...channel.members.flatMap(card => [card.name, card.path])].some(text => text.toLowerCase().includes(query)))
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
    if (ctx.workspace?.isActive) { this.away = true; return }
    const returning = this.away
    this.away = false
    this.channels = this.compose(ctx)
    if (!this.channels.some(channel => channel.key === this.current)) this.resume()
    this.drawRail()
    this.drawChannel()
    if (returning) this.returnFocus()
  }
  /** The item the reader was opened from, else the console. */
  private returnFocus(): void {
    const item = this.returnTo && this.layout?.querySelector<HTMLElement>(`[data-item="${CSS.escape(this.returnTo)}"]`)
    this.returnTo = null
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
      pick.append(el('span', 'kbn-ch-pick-hash', channel.chaired ? '#' : '·'), el('span', 'kbn-ch-pick-name', handle(channel)))
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
      pick.append(el('span', 'kbn-ch-doc-name', declaredTitle(receipt.key)?.title ?? receipt.basename), el('span', 'kbn-ch-doc-meta', `${slug(card)} · ${ago(receipt.timestamp, now)}`))
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
      this.head.replaceChildren(el('p', 'kbn-ch-empty', this.channels.length ? 'Choose a channel.' : 'No channels yet.'), this.railToggle!.root)
      this.stream.replaceChildren()
      this.sweepThumbs(new Set())
      return
    }
    const now = Date.now(), entries = this.entries(channel), failed = channel.families.some(uid => this.ctx!.workspace!.board.failed(uid))
    const seat = channel.seat
    // The head and the stream are drawn apart, so what arrives leaves a focused page or an open menu in the head be.
    const head = JSON.stringify([channel.key, channel.name, channel.title, fiberOf(seat), seat.modifiedAt, this.ctx!.workspace!.globeHost.feeds.files(seat).length])
    if (head !== this.sigs.head) {
      this.sigs.head = head
      const back = iconButton('kbn-ch-back', 'back', 'Channels', () => this.setRail(false))
      const name = el('h3', 'kbn-ch-name')
      name.append(channel.chaired ? el('span', 'kbn-ch-handle', handle(channel)) : channel.name)
      name.toggleAttribute('data-lone', !channel.chaired)
      if (channel.title !== channel.name) name.title = channel.title
      // The chair's pages: opening one is a deliberate look at the chair.
      const pages = docButtons(seat, { ...this.ctx!.workspace!.globeHost.feeds, open: (card, doc) => { this.returnTo = null; this.ctx?.workspace?.openPage(card, doc) } })
      pages.classList.add('kbn-ch-pages')
      const menu: IconButton = iconButton('kbn-ch-menu', 'actions', 'Channel menu', () => this.railMenu(channel.key, menu.button))
      menu.button.setAttribute('aria-haspopup', 'menu')
      this.head.replaceChildren(back.root, name, pages, menu.root, this.railToggle!.root)
    }
    const stream = JSON.stringify([channel.key, failed, entries.map(entry => [entry.id, entry.kind, entry.at, entry.card.name, entry.card.turn, entry.kind === 'mark' ? entry.what : [entry.text, entry.waiting, kindWord(entry), entry.files.map(file => file.fullPath)]])])
    if (stream !== this.sigs.stream) {
      this.sigs.stream = stream
      this.rebuild(this.stream, entries.map(entry => entry.kind === 'mark' ? this.markRow(entry, now) : this.itemRow(entry, now)))
      this.sweepThumbs(new Set(entries.flatMap(entry => entry.kind === 'mark' ? [] : [`item:${entry.id}:lead`, ...entry.files.map(file => `item:${entry.id}:${file.fullPath}`)])))
      if (!entries.length) this.stream.append(el('li', 'kbn-ch-hush', failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing addressed to you here yet.'))
      if (this.following) this.stream.scrollTop = this.stream.scrollHeight
    }
    for (const age of this.layout!.querySelectorAll<HTMLElement>('[data-at]')) age.textContent = ago(Number(age.dataset.at), now)
  }
  /** A thread started, closed or handed off: who, and what, in one small muted line. */
  private markRow(mark: Extract<Entry, { kind: 'mark' }>, now: number): HTMLLIElement {
    const row = el('li', 'kbn-ch-mark')
    const age = el('span', 'kbn-ch-age', ago(mark.at, now))
    age.dataset.at = String(mark.at)
    row.append(el('span', 'kbn-ch-mark-who', slug(mark.card)), el('span', 'kbn-ch-mark-what', mark.what), age)
    row.title = mark.card.name
    return row
  }
  /**
   * One thing a worker addressed to the human: its state dot, who, what kind
   * and when, its one line, and the pages and figures it carries drawn as
   * thumbnails side by side, each opening its page. Choosing the item opens the
   * worker's view.
   */
  private itemRow(item: Item, now: number): HTMLLIElement {
    const { card } = item
    const row = el('li', 'kbn-ch-item')
    row.dataset.kind = item.kind
    row.dataset.fiber = fiberOf(card)
    row.toggleAttribute('data-waiting', item.waiting)
    const id = `item:${item.id}`
    const open = (): void => { this.returnTo = id; this.ctx?.workspace?.openFromDesk(card) }
    const who = button('kbn-ch-who', slug(card), open)
    who.dataset.item = id
    who.title = `Open ${card.name}`
    const age = el('span', 'kbn-ch-age', ago(item.at, now))
    age.dataset.at = String(item.at)
    const head = el('div', 'kbn-ch-item-head')
    head.append(who, el('span', 'kbn-ch-kind', kindWord(item)), age)
    const body = el('div', 'kbn-ch-item-body')
    body.append(head)
    if (item.text) {
      const text = el('div', 'kbn-ch-item-text')
      text.innerHTML = renderMarkdown(item.text)
      body.append(text)
    }
    if (item.kind === 'close') body.append(this.closing(item, id))
    if (item.files.length) body.append(this.files(item, id))
    row.append(stateDot(card, open), body)
    // The whole item opens the view, save its buttons and a selection.
    row.addEventListener('click', event => {
      if ((event.target as Element).closest('button, a') || getSelection()?.toString()) return
      open()
    })
    return row
  }
  /** An item's files side by side: a page or a figure as its thumbnail alone, any other file as a chip named by its file name; each opens in the reader. */
  private files(item: Item, id: string): HTMLElement {
    const box = el('div', 'kbn-ch-files')
    for (const file of item.files) {
      const owner = file.host ?? item.card.originId, key = `${id}:${file.fullPath}`
      const open = button('kbn-ch-file', '', () => { this.returnTo = key; this.openFile(file, item.card) })
      open.dataset.item = key
      open.title = file.fullPath
      if (DRAWN.test(file.basename)) {
        open.classList.add('kbn-ch-thumb')
        open.append(this.thumb(key, file, owner).el)
      } else open.append(el('span', 'kbn-ch-file-name', file.basename))
      box.append(open)
    }
    return box
  }
  /** A close's tapestry as its thumbnail, when it has one: drawn at once from the last redraw's, then as the read says. */
  private closing(item: Item, id: string): HTMLElement {
    const slot = el('div', 'kbn-ch-files'), key = `${id}:lead`
    const kept = this.leads.get(key)
    if (kept) slot.append(kept.button)
    void this.ctx?.workspace?.globeHost.feeds.lead(item.card).then(lead => {
      const file = lead && parseDocKey(lead.key)
      if (!lead || !file || this.leads.get(key)?.doc === lead.key || !slot.isConnected) return
      // A new tapestry takes the place of the one drawn before.
      this.drop(key)
      const open = button('kbn-ch-file kbn-ch-thumb', '', () => { this.returnTo = key; this.ctx?.workspace?.openPage(item.card, lead.key) })
      open.dataset.item = key
      open.title = `Open ${lead.name}`
      open.append(this.thumb(key, { fullPath: file.path, basename: file.path.split('/').pop() ?? file.path, timestamp: lead.at }, file.owner).el)
      this.leads.set(key, { doc: lead.key, button: open })
      slot.replaceChildren(open)
    })
    return slot
  }
  /** A page's or a figure's live face, drawn small: the one already made for it, else a new one. */
  private thumb(key: string, file: SentFile, owner: string): Thumbnail {
    const kept = this.thumbs.get(key)
    if (kept) return kept
    const thumbnail: Thumbnail = new Thumbnail({
      key, shuttleBase: this.ctx?.shuttleBase ?? '', file: { fullPath: file.fullPath, owner, basename: file.basename }, fallback: file.basename,
      className: 'kbn-ch-thumb-face', pageWidth: 1200,
      // Under the reader nothing here is seen, so nothing here is worth a live body.
      priority: () => thumbnail.near && !this.ctx?.workspace?.isActive ? 2 : 0,
      distance: () => Math.abs(thumbnail.el.getBoundingClientRect().top),
    })
    this.thumbs.set(key, thumbnail)
    this.near?.observe(thumbnail.el)
    return thumbnail
  }
  /** Lets go of the thumbnails the stream no longer wants. */
  private sweepThumbs(wanted: ReadonlySet<string>): void {
    for (const key of this.thumbs.keys()) if (!wanted.has(key)) this.drop(key)
  }
  private drop(key: string): void {
    const thumbnail = this.thumbs.get(key)
    if (thumbnail) { this.near?.unobserve(thumbnail.el); thumbnail.dispose() }
    this.thumbs.delete(key)
    this.leads.delete(key)
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
    this.returnTo = from
    this.ctx?.workspace?.openPage(card, key)
  }
  /** Opens a sent file in the reader, under the fiber that sent it. */
  private openFile(file: SentFile, sender: KanbanCard): void {
    this.ctx?.workspace?.openPage(sender, docKey(file.host ?? sender.originId, file.fullPath, sender.originId, sender.fiberDir))
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
    if (event.key === 'Escape' && this.overDrawer()) { this.setRail(true); return true }
    if (event.key === '/' && this.jump) { this.setRail(false); this.jump.focus({ preventScroll: true }); return true }
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.setRail(this.railShown()); return true }
    if (event.key === 'Enter' && !active?.closest('button, a, input') && this.channel) { this.dock?.focus(); return true }
    return false
  }
  unmount(): void {
    // A document still being read from its owner does not open once Channels is left.
    this.ctx?.workspace?.library.cancelOpen()
    if (this.dock && this.drafted) this.drafts.set(this.drafted, this.dock.draft)
    if (this.current) store(SEEN + this.current, String(Date.now()))
    this.query = ''
    this.near?.disconnect(); this.near = null
    for (const thumbnail of this.thumbs.values()) thumbnail.dispose()
    this.thumbs.clear()
    this.leads.clear()
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
