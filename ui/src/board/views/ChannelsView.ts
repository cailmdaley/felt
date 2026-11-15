import { announce } from '@ui-sdk/core'
import '@ui-sdk/web/tooltip'
import { ago } from '../civilDay.js'
import { HumanMessageIds, repeatNotice } from '../humanMessageId.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import { head, RESOURCE_PRIORITY, text } from '../documentResources.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import {
  arranged, BOARD_LINE, channelLines, composeChannels, continues, composeMessages, fiberOf, hideKey, liveness, railOrder, reordered, sameFiber, setAsideKey, showKey, threadOf, unpinKey,
  type BoardRecord, type Channel, type Line, type Message, type Tapestry,
} from '../channels.js'
import { createRailReorder, type RailReorder } from '../channelRail.js'
import { openActionMenu } from '../conversationMenu.js'
import type { SentFile } from '../sentFiles.js'
import { stateDot } from '../stateDot.js'
import { cardNamed } from '../threads.js'
import { fileBytesUrl, renderMarkdown } from '../utils.js'
import { COMPANION_NAMES, docKey, type DocKey } from '../workspace/documents.js'
import { headerIcon, type HeaderIcon } from '../workspace/headerIcon.js'
import { declaredTitle } from '../workspace/DocumentTitles.js'
import { charters } from '../workspace/RolePage.js'
import { createViewPage } from './ViewPage.js'
import { isTypingTarget, keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import './ChannelsView.css'

const SEEN = 'shuttle.channels.seen:'
const RAIL = 'shuttle.channels.rail-hidden'
/** A pin is renewed by use at most this often; it lapses with the board's reach. */
const RENEW_MS = 86_400_000
/** The rail's order and its hides are written again once this old, well inside the board's reach. */
const KEEP_MS = 7 * 86_400_000
/** How far a finger or a trackpad must travel sideways to move between the rail, a channel and a thread. */
const SWIPE_PX = 60
/** A list within this many pixels of its newest message counts as following it. */
const FOLLOW_PX = 24
/** Jump to lists at most this many documents beneath the channels it matches. */
const FOUND_DOCUMENTS = 12
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i
/** Narrower than this, the view shows a channel or a thread, not both: a thread opens one level deeper. */
const SIDE_BY_SIDE_PX = 1100
/** A message taller than this many lines folds, with Show more to unfold it in place. */
const FOLD_LINES = 8
type Pane = 'channel' | 'thread'

/** One family's board records, read from its daemon a window at a time; `failed` while its last read did not answer. */
interface Feed { records: Map<string, BoardRecord>; cursor: number; pending: boolean; failed: boolean }
/** A reply the human sent from here, shown until the board carries it. */
interface Sent { fiber: string; text: string; at: number }
/** A reply sent from here stands in for the board's record of it this long at most. */
const ECHO_MS = 2 * 60_000
/** Each read of a family asks again for this much before the newest record it holds, so a record written late is not missed. */
const OVERLAP_MS = 60_000

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
/** A figure at least this many pixels on its shorter side; anything smaller is an icon or a sprite sheet. */
const FIGURE_PX = 64
const SVG = 'http://www.w3.org/2000/svg'
/**
 * A tapestry page, collapsed to its title, its first paragraph and its first
 * figure: an image's path resolved against the page's folder (or its own
 * address when absolute), or an outermost inline SVG as a data URL carrying
 * the page's styles, drawn as an image so nothing in it runs.
 */
export function collapse(html: string, dir = '/'): { title: string; lede: string; figure?: string } {
  const page = new DOMParser().parseFromString(html, 'text/html')
  const text = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const lede = [...page.querySelectorAll('p')].map(text).find(Boolean) ?? ''
  // Its declared size, else its viewBox's; an image without either is taken at its word.
  const side = (node: Element): number => {
    const [width, height] = ['width', 'height'].map(name => parseFloat(node.getAttribute(name) ?? ''))
    if (Number.isFinite(width) && Number.isFinite(height)) return Math.min(width, height)
    const box = node.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
    return box?.length === 4 ? Math.min(box[2], box[3]) : Infinity
  }
  const figure = [...page.body?.querySelectorAll('img[src], svg') ?? []]
    .find(node => !node.parentElement?.closest('svg') && side(node) >= FIGURE_PX)
  let address: string | undefined
  if (figure?.localName === 'svg') {
    const drawn = figure.cloneNode(true) as Element
    const styles = page.createElementNS(SVG, 'style')
    styles.textContent = [...page.querySelectorAll('style')].map(style => style.textContent).join('\n')
    drawn.prepend(styles)
    address = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(drawn))}`
  } else if (figure) {
    const src = figure.getAttribute('src')!
    address = /^(data|https?):/.test(src) ? src : decodeURIComponent(new URL(src, `file://${dir}/`).pathname)
  }
  return { title: text(page.querySelector('h1')) || page.title.trim(), lede, figure: address }
}

/**
 * Channels, as Slack: a rail of the channels read lately, waiting on the human
 * or pinned, what waits floated to the top and the rest in the human's order,
 * each movable and with a menu to hide, pin or move it (Jump to finds the rest,
 * hidden ones too, and the fleet's documents); a channel's
 * stream, oldest first, kept short — every message of its chair, its tapestry
 * among them, and each other worker once, its wait or its latest message
 * whole with its files and a link to its thread; and beside it that thread,
 * the worker's whole history under its name, liveness, open ask or, once
 * closed, its conclusion. A reply in the channel goes to its chair, a reply in
 * a thread to that worker. On a phone the rail is the first screen, and a
 * channel and a thread each fill it.
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
  private channelReply: Reply | null = null
  private threadEl: HTMLElement | null = null
  private threadHead: HTMLElement | null = null
  private threadList: HTMLOListElement | null = null
  private threadReply: Reply | null = null
  private note: HTMLElement | null = null
  private channels: Channel[] = []
  private current: string | null = null
  /** The worker whose thread is open beside the channel. */
  private thread: KanbanCard | null = null
  /** What Jump to is looking for; '' lists the rail. */
  private query = ''
  /** The item a document or card was opened from, which takes focus again when the reader closes. */
  private returnTo: string | null = null
  /** The reader stands over Channels: nothing redraws beneath it. */
  private away = false
  /** A channel or thread just came into view: it opens on its newest message. */
  private landing: Record<Pane, boolean> = { channel: true, thread: true }
  /** What was typed in each reply box, by whom it goes to, kept while the reader is elsewhere. */
  private readonly drafts = new Map<string, string>()
  private railHidden = false
  /** A phone shows the rail until a channel is chosen. */
  private phoneRail = true
  private dismissed: string[] = []
  private pending: string[] = []
  private pinned = new Map<string, number>()
  /** The human's order of the channels, and when it was written. */
  private order: string[] = []
  private orderAt = 0
  private rail: RailReorder | null = null
  /** The rail's entries, each made movable, undone when they are drawn again. */
  private railBindings: Array<() => void> = []
  /** A poll arrived while an item was picked up: the rail is drawn once it lands. */
  private railStale = false
  private names = new Map<string, string>()
  /** The charters' names were read, or a read is under way. */
  private namesRead = false
  private reachMs = 14 * 86_400_000
  private readonly feeds = new Map<string, Feed>()
  private sent: Sent[] = []
  /** Each chair's tapestry, by fiber and the card's last write; null when it has none. */
  private readonly tapestries = new Map<string, { modified?: string; tapestry: Tapestry | null }>()
  /** Tapestries read in full in the stream, by message id, with their viewers. */
  private readonly expanded = new Map<string, HTMLElement>()
  /** Long messages unfolded, by message id. */
  private readonly unfolded = new Set<string>()
  /** Typed-input ids: a retried reply keeps its message's id. */
  private readonly messageIds = new HumanMessageIds()
  private readonly tempering = new Set<string>()
  /** When each channel was last read before this visit to it, for the marks of what is new. */
  private readonly before = new Map<string, number>()
  private sigs: Record<Pane | 'rail', string> = { channel: '', thread: '', rail: '' }
  /** Each list follows its newest message while the reader is at its foot; a message that grows (an image arriving) keeps it there. */
  private readonly following: Record<Pane, boolean> = { channel: true, thread: true }
  /** Where each list was last scrolled to its foot, so growth beneath the reader is not taken for scrolling up. */
  private readonly footTop: Record<Pane, number> = { channel: 0, thread: 0 }
  private sizes: ResizeObserver | null = null
  /** Follows the view's own width, for whether a thread opens beside the channel or in its place. */
  private width: ResizeObserver | null = null
  private loaded = false
  private reading = false
  private generation = 0
  private unsubscribe?: () => void
  private unsubscribeLibrary?: () => void
  private stopGestures?: () => void

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    this.landing = { channel: true, thread: true }
    // The view outlives its mounts: coming back to the channel it showed is reading it again.
    if (this.current) this.visit(this.current)
    const page = createViewPage('Channels')
    page.root.classList.add('kbn-channels')
    this.railToggle = iconButton('kbn-ch-rail-toggle', 'rail', '', () => this.setRail(this.railShown()))
    page.titleRow.append(this.railToggle.root)
    this.layout = el('div', 'kbn-ch-layout')
    this.layout.append(this.railEl(), this.channelPane(), this.threadPane())
    this.note = el('p', 'kbn-ch-note', 'Reading the channels…')
    this.note.setAttribute('role', 'status')
    page.body.append(this.note, this.layout)
    host.append(page.root)
    this.stopGestures = this.gestures(page.root)
    this.sizes = new ResizeObserver(() => {
      for (const [pane, list] of [['channel', this.stream], ['thread', this.threadList]] as const) if (list && this.following[pane]) this.toFoot(list, pane)
    })
    this.rail = createRailReorder({
      onOrder: keys => this.reorder(keys),
      onMenu: (key, pick, point) => this.railMenu(key, pick, point),
      onSettled: () => { if (this.railStale) this.drawRail() },
    })
    this.width = new ResizeObserver(([entry]) => {
      const narrow = entry.contentRect.width < SIDE_BY_SIDE_PX
      if (narrow === this.layout?.hasAttribute('data-narrow')) return
      this.layout?.toggleAttribute('data-narrow', narrow)
      this.drawThread()
    })
    this.width.observe(this.layout)
    this.railHidden = stored(RAIL) === '1'
    this.showRail()
    this.unsubscribe = ctx.sends?.subscribe(() => this.draw())
    this.unsubscribeLibrary = ctx.workspace?.library.subscribe(() => { if (this.query) this.drawRail() })
    this.refresh(ctx)
  }
  /** Reads the charters' names once, and again on the next refresh after a read that failed. */
  private readNames(): void {
    const ctx = this.ctx
    if (!ctx || this.namesRead) return
    this.namesRead = true
    const generation = this.generation
    void charters(ctx.shuttleBase).then(list => {
      if (generation !== this.generation) return
      this.names = new Map(list.flatMap(charter => charter.name ? [[charter.slug, charter.name] as [string, string]] : []))
      this.draw()
    }).catch(() => { this.namesRead = false })
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
    this.channelReply = new Reply(text => this.send(this.channel?.seat, text, 'channel'))
    this.follow(this.stream, 'channel')
    this.channelEl.append(this.head, this.stream, this.channelReply.form)
    return this.channelEl
  }
  private threadPane(): HTMLElement {
    this.threadEl = el('aside', 'kbn-ch-thread')
    this.threadEl.tabIndex = -1
    this.threadEl.setAttribute('aria-label', 'Thread')
    this.threadHead = el('header', 'kbn-ch-thread-head')
    this.threadList = el('ol', 'kbn-ch-stream kbn-ch-thread-list')
    this.threadReply = new Reply(text => this.send(this.threadCard, text, 'thread'))
    this.follow(this.threadList, 'thread')
    this.threadEl.append(this.threadHead, this.threadList, this.threadReply.form)
    return this.threadEl
  }
  /** Keeps a list's following in step with the reader's scrolling. */
  private follow(list: HTMLOListElement, pane: Pane): void {
    list.addEventListener('scroll', () => {
      this.following[pane] = list.scrollHeight - list.scrollTop - list.clientHeight <= FOLLOW_PX || (this.following[pane] && list.scrollTop >= this.footTop[pane] - 1)
    }, { passive: true })
  }
  /** Scrolls a list to its newest message. */
  private toFoot(list: HTMLOListElement, pane: Pane): void {
    list.scrollTop = list.scrollHeight
    this.footTop[pane] = list.scrollTop
  }
  refresh(ctx: ViewContext): void {
    this.ctx = ctx
    this.readNames()
    this.draw()
    void ctx.sends?.refresh().catch(() => {})
    void this.read()
  }
  private async read(): Promise<void> {
    if (this.reading || !this.ctx) return
    this.reading = true
    const generation = this.generation, base = this.ctx.shuttleBase
    const records = await getDaemonJson<{ dismissed: string[]; pinned?: Record<string, number>; order?: { keys: string[]; at: number } | null; reach_ms: number }>(`${base}/api/v1/channels/dismissed`)
      .then(value => ({ ok: true as const, value }), () => ({ ok: false as const }))
    if (generation !== this.generation) return
    this.reading = false
    this.loaded = true
    if (records.ok) {
      this.dismissed = records.value.dismissed
      this.reachMs = records.value.reach_ms
      this.pending = this.pending.filter(key => !this.dismissed.includes(key))
      // A pin made here stands until the feed carries one as new.
      for (const [key, at] of Object.entries(records.value.pinned ?? {})) this.pinned.set(key, Math.max(at, this.pinned.get(key) ?? 0))
      for (const [key, at] of this.pinned) if (Date.now() - at > this.reachMs) this.pinned.delete(key)
      // An order written here stands until the feed carries one as new.
      const order = records.value.order
      if (order && order.at >= this.orderAt) { this.order = order.keys; this.orderAt = order.at }
    }
    this.status(records.ok ? '' : 'Some channel sources are unavailable — showing the last read.')
    this.draw()
    if (records.ok) this.keep()
    // Every channel in the rail reads its families, for what is new in it.
    this.readFamilies(this.channels.filter(channel => channel.listed || channel.key === this.current))
  }
  private status(text: string): void { if (this.note) this.note.textContent = text }
  /** The order and the hides lapse with the board's reach, so while they stand they are written again. */
  private keep(): void {
    const now = Date.now()
    if (this.order.length && now - this.orderAt > KEEP_MS) void this.writeOrder(this.order)
    for (const channel of this.channels) if (channel.hidden && now - channel.hidden > KEEP_MS) void this.setAside(channel, hideKey(channel.key, now))
  }

  /**
   * Reads each family's board records since the newest it holds (the board's
   * reach the first time), and redraws when any arrived. A remote record is
   * placed by its arrival here, so a late host is never behind the cursor.
   */
  private readFamilies(channels: Channel[]): void {
    const ctx = this.ctx
    if (!ctx) return
    const generation = this.generation
    for (const uid of new Set(channels.flatMap(channel => channel.families))) {
      const feed = this.feeds.get(uid) ?? this.feeds.set(uid, { records: new Map(), cursor: Date.now() - this.reachMs + OVERLAP_MS, pending: false, failed: false }).get(uid)!
      if (feed.pending) continue
      feed.pending = true
      void getDaemonJson<{ records?: BoardRecord[] }>(`${ctx.shuttleBase}/api/v1/board/family?fiber=${encodeURIComponent(uid)}&since_ms=${feed.cursor - OVERLAP_MS}`).then(body => {
        if (generation !== this.generation) return
        const known = feed.records.size, failed = feed.failed, reach = Date.now() - this.reachMs
        feed.failed = false
        for (const record of body.records ?? []) {
          feed.records.set(record.id, record)
          feed.cursor = Math.max(feed.cursor, record.received_at ?? record.timestamp)
        }
        // What fell out of the board's reach leaves with it.
        for (const [id, record] of feed.records) if ((record.received_at ?? record.timestamp) < reach) feed.records.delete(id)
        if (feed.records.size !== known || failed) this.draw()
      }, () => {
        if (generation !== this.generation || feed.failed) return
        feed.failed = true
        this.draw()
      }).finally(() => { feed.pending = false })
    }
  }
  /**
   * A channel's messages: its families' records (a record two of its families
   * share, once), the replies sent from here, its files and its chair's tapestry.
   */
  private messages(channel: Channel): Message[] {
    const records = new Map(channel.families.flatMap(uid => [...this.feeds.get(uid)?.records.values() ?? []]).map(record => [record.id, record]))
    // A reply sent from here stands in for the board's record of it until that arrives, for two minutes at most.
    const now = Date.now()
    const said = (record: BoardRecord): string | undefined =>
      record.kind === 'human' ? record.text : record.kind === 'answered' ? /\s—\sA:\s([\s\S]*)$/.exec(record.text ?? '')?.[1] : undefined
    const recorded = (sent: Sent): boolean => [...records.values()].some(record => record.fiber === sent.fiber && said(record)?.trim() === sent.text)
    const standing = this.sent.filter(sent => now - sent.at < ECHO_MS && !recorded(sent))
    if (standing.length !== this.sent.length) this.sent = standing
    const replies = standing.map<BoardRecord>(sent => ({ id: `${BOARD_LINE}sent:${sent.fiber}:${sent.at}`, kind: 'human', timestamp: sent.at, fiber: sent.fiber, by: { label: 'human' }, text: sent.text }))
    return composeMessages({
      channel, records: [...records.values(), ...replies], files: this.ctx?.sends?.files ?? [], cards: this.ctx ? boardCards(this.ctx.response) : undefined,
      tapestry: this.tapestries.get(fiberOf(channel.seat))?.tapestry, now, reachMs: this.reachMs,
    })
  }
  /** One of the channel's families could not be read on its last try. */
  private historyFailed(channel: Channel): boolean { return channel.families.some(uid => this.feeds.get(uid)?.failed) }
  /** Reads a constitution's tapestry (or artifact, or report) once, and again when its card's file changes. */
  private readTapestry(card: KanbanCard): void {
    const id = fiberOf(card), known = this.tapestries.get(id), ctx = this.ctx
    if (!ctx || !card.fiberDir || (known && known.modified === card.modifiedAt)) return
    this.tapestries.set(id, { modified: card.modifiedAt, tapestry: known?.tapestry ?? null })
    const generation = this.generation
    void (async () => {
      for (const name of COMPANION_NAMES) {
        const path = `${card.fiberDir}/${name}`, src = fileBytesUrl(ctx.shuttleBase, path, card.originId)
        const found = await head(src, RESOURCE_PRIORITY.neighbour, { fresh: !!known })
        if (!found?.exists) continue
        // The whole page, the reader's cached copy: a plot is often embedded whole and lies past any first read.
        const body = await text(src, RESOURCE_PRIORITY.neighbour, { fresh: !!known })
        if (generation !== this.generation) return
        const { title, lede, figure } = collapse(body?.text ?? '', card.fiberDir)
        const at = Date.parse(found.modifiedAt ?? '') || Date.parse(card.modifiedAt ?? '') || Date.now()
        const shown = figure?.startsWith('/') ? fileBytesUrl(ctx.shuttleBase, figure, card.originId) : figure
        this.tapestries.set(id, { modified: card.modifiedAt, tapestry: { path, at, title: title || card.name, lede, figure: shown } })
        this.draw()
        return
      }
    })().catch(() => {})
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
    if (channel) { this.open(channel.key, true); return }
    this.found?.querySelector<HTMLButtonElement>('button')?.click()
  }
  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.list || !this.loaded) return
    // Nothing redraws under the reader; coming back draws once and returns focus where the reader was opened from.
    if (ctx.workspace?.isActive) { this.away = true; return }
    const returning = this.away
    this.away = false
    const index = threadIndexFor(ctx.response)
    this.channels = composeChannels({
      cards: boardCards(ctx.response), parentOf: card => index.parentOf(card), names: this.names,
      dismissed: [...this.dismissed, ...this.pending], pinned: this.pinned, opened: lastSeen, now: Date.now(),
    })
    if (!this.channels.some(channel => channel.key === this.current)) this.open(isMobileViewport() ? null : this.listed[0]?.key ?? null, false)
    this.drawRail()
    this.drawChannel()
    this.drawThread()
    if (returning) this.returnFocus()
  }
  /** The item the reader was opened from, else the reply box in view. */
  private returnFocus(): void {
    const item = this.returnTo && this.layout?.querySelector<HTMLElement>(`[data-item="${CSS.escape(this.returnTo)}"]`)
    this.returnTo = null
    if (item) item.focus({ preventScroll: true })
    else (this.thread ? this.threadReply : this.channelReply)?.text.focus({ preventScroll: true })
  }
  /** Fills `container` anew; the item that had focus in it keeps it. */
  private rebuild(container: HTMLElement, children: Node[]): void {
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-item]')
    const item = focused && container.contains(focused) ? focused.dataset.item : undefined
    container.replaceChildren(...children)
    if (item) container.querySelector<HTMLElement>(`[data-item="${CSS.escape(item)}"]`)?.focus({ preventScroll: true })
  }
  /**
   * Comes to a channel, with its own draft and no thread open; what it held
   * when last read is kept for this visit's marks, and its families are read.
   * Choosing it deliberately (not stepping through with j / k) renews its pin.
   */
  private open(key: string | null, focus: boolean, deliberate = focus): void {
    if (key !== this.current) {
      this.keepDrafts()
      // Leaving a channel is having read it to now.
      if (this.current) store(SEEN + this.current, String(Date.now()))
      this.current = key
      this.thread = null
      this.restoreDrafts()
      if (key) this.visit(key)
      this.landing.channel = true
      const channel = this.channel
      if (channel) this.readFamilies([channel])
    }
    if (!focus) return
    if (key && deliberate) {
      this.renew(key)
      // Opening a hidden channel brings it back to the rail.
      const channel = this.channels.find(each => each.key === key)
      if (channel?.hidden) void this.setAside(channel, showKey(key, Date.now()))
    }
    if (isMobileViewport()) this.setRail(true)
    this.drawRail(); this.drawChannel(); this.drawThread()
    this.channelEl?.focus({ preventScroll: true })
  }
  /** Opens a worker's thread beside the channel; null closes it. */
  private openThread(card: KanbanCard | null): void {
    this.keepDrafts()
    this.thread = card
    this.restoreDrafts()
    this.landing.thread = true
    this.drawChannel(); this.drawThread()
    if (card) this.threadEl?.focus({ preventScroll: true })
    else this.channelEl?.focus({ preventScroll: true })
  }
  private draftKey(pane: Pane): string | null {
    return pane === 'channel' ? this.current && `channel:${this.current}` : this.thread && `thread:${fiberOf(this.thread)}`
  }
  private replies(): Array<[Pane, Reply | null]> { return [['channel', this.channelReply], ['thread', this.threadReply]] }
  private keepDrafts(): void {
    for (const [pane, reply] of this.replies()) {
      const key = this.draftKey(pane)
      if (key && reply) this.drafts.set(key, reply.text.value)
    }
  }
  private restoreDrafts(): void {
    for (const [pane, reply] of this.replies()) {
      const key = this.draftKey(pane)
      if (reply) reply.text.value = (key && this.drafts.get(key)) || ''
    }
  }
  private visit(key: string): void {
    this.before.set(key, lastSeen(key))
    store(SEEN + key, String(Date.now()))
  }
  private get channel(): Channel | undefined { return this.channels.find(channel => channel.key === this.current) }
  /** The open thread's worker, at its freshest copy. */
  private get threadCard(): KanbanCard | undefined {
    const thread = this.thread
    return thread ? this.channel?.everyone.find(card => sameFiber(card, thread)) ?? thread : undefined
  }

  private drawRail(): void {
    const list = this.list!, rail = this.rail!, listed = this.listed
    rail.set(listed.map(channel => channel.key))
    // Nothing is rebuilt under an entry pressed or picked up; it is drawn once it lands.
    this.railStale = rail.moving
    if (rail.moving) return
    const unread = (channel: Channel): boolean => channel.key !== this.current && this.newestSaid(channel) > lastSeen(channel.key)
    // A poll that changed nothing in the rail leaves it be.
    const sig = JSON.stringify([this.query, this.current, listed.map(channel => [channel.key, channel.name, channel.title, channel.chaired, channel.waiting, !!channel.hidden, unread(channel)])])
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
      pick.toggleAttribute('data-unread', unread(channel))
      pick.toggleAttribute('data-waiting', channel.waiting)
      pick.append(el('span', 'kbn-ch-pick-hash', channel.chaired ? '#' : '·'), el('span', 'kbn-ch-pick-name', channel.name))
      if (channel.hidden) pick.append(el('span', 'kbn-ch-pick-hidden', 'hidden'))
      if (channel.waiting) {
        const mark = el('span', 'kbn-ch-pick-mark')
        mark.title = 'Waiting on you'
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
    // A poll redraws the rail: the channel that had focus keeps it.
    this.rebuild(list, items)
    this.drawFound()
  }
  /** When the newest thing a channel said, or began waiting on, arrived. */
  private newestSaid(channel: Channel): number {
    const said = this.messages(channel).filter(message => !message.quiet && !message.human)
    return Math.max(channel.newest, ...said.map(message => message.arrived))
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
      const meta = el('span', 'kbn-ch-doc-meta', `${card.name} · ${ago(receipt.timestamp, now)}`)
      pick.append(el('span', 'kbn-ch-doc-name', declaredTitle(receipt.key)?.title ?? receipt.basename), meta)
      item.append(pick)
      return item
    }))
    this.rebuild(found, [el('h4', 'kbn-ch-shelf', 'Files'), list])
  }

  private drawChannel(): void {
    if (!this.head || !this.stream || !this.channelReply) return
    const channel = this.channel
    if (!this.ctx?.workspace?.isActive) this.ctx?.see?.(this.threadCard ?? channel?.seat ?? null)
    this.channelReply.form.hidden = !channel
    this.layout?.toggleAttribute('data-channel', !!channel)
    if (!channel) {
      this.sigs.channel = ''
      this.head.replaceChildren(el('p', 'kbn-ch-empty', this.channels.length ? 'Choose a channel.' : 'No channels yet.'))
      this.stream.replaceChildren()
      return
    }
    this.readTapestry(channel.seat)
    const now = Date.now(), lines = channelLines(this.messages(channel), channel), failed = this.historyFailed(channel)
    for (const { message } of lines) this.readTapestry(message.card)
    const sig = JSON.stringify([channel.key, channel.name, failed, this.thread && fiberOf(this.thread), [...this.tempering], [...this.expanded.keys()], [...this.unfolded],
      lines.map(({ message, replies, last, waiting }) => [message.id, message.kind, message.text, waiting, message.card.name, message.card.turn, message.files.map(file => file.fullPath), replies, last, this.embedded(message.card, 'channel')])])
    if (this.changed('channel', sig)) {
      const back = iconButton('kbn-ch-back', 'back', 'Channels', () => this.setRail(false))
      const name = el('h3', 'kbn-ch-name', channel.name)
      if (channel.title !== channel.name) name.title = channel.title
      const menu: IconButton = iconButton('kbn-ch-menu', 'actions', 'Channel menu', () => this.railMenu(channel.key, menu.button))
      menu.button.setAttribute('aria-haspopup', 'menu')
      this.head.replaceChildren(back.root, name, menu.root)
      this.fill(this.stream, lines, 'channel', channel, now)
      if (!lines.length) this.stream.append(el('li', 'kbn-ch-hush', failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing said here yet.'))
    }
    this.tick()
    this.channelReply.to.textContent = channel.seat.name
  }
  /** Whether a pane's signature changed, keeping the new one. */
  private changed(pane: Pane, sig: string): boolean {
    const old = this.sigs[pane]
    this.sigs[pane] = sig
    return old !== sig
  }
  /** Fills a list with messages, following its newest unless the reader has scrolled up. */
  private fill(list: HTMLOListElement, lines: Line[], pane: Pane, channel: Channel, now: number): void {
    // Following is the reader's choice, kept by their scrolling: growth beneath them is not a choice.
    const follow = this.following[pane] = this.landing[pane] || this.following[pane]
    const before = this.before.get(channel.key) ?? -Infinity
    // Like Slack, a rule marks where what arrived since the last visit begins, and a run of one sender's messages names it once.
    const fresh = Number.isFinite(before) ? lines.findIndex(({ message }) => !message.human && message.arrived > before) : -1
    const rows: HTMLLIElement[] = lines.map((line, index) => this.messageRow(line, pane, before, now, index === fresh ? undefined : lines[index - 1]?.message))
    if (fresh >= 0) {
      const rule = el('li', 'kbn-ch-new')
      rule.setAttribute('role', 'separator')
      rule.append(el('span', '', 'New'))
      rows.splice(fresh, 0, rule)
    }
    this.rebuild(list, rows)
    this.fold(list)
    for (const row of rows) this.sizes?.observe(row)
    if (follow) this.toFoot(list, pane)
    this.landing[pane] = false
  }
  /** Folds each message taller than {@link FOLD_LINES} lines, unless the reader unfolded it. */
  private fold(list: HTMLElement): void {
    for (const text of list.querySelectorAll<HTMLElement>('.kbn-ch-msg-text[data-id]')) {
      const id = text.dataset.id!
      if (this.unfolded.has(id)) continue
      const line = parseFloat(getComputedStyle(text).lineHeight) || 0
      if (!line || text.scrollHeight <= line * (FOLD_LINES + 0.5)) continue
      text.toggleAttribute('data-folded', true)
      const more = button('kbn-ch-act kbn-ch-more', 'Show more', () => { this.unfolded.add(id); text.removeAttribute('data-folded'); more.remove() })
      text.after(more)
    }
  }
  /** Ages tick in place, so nothing is rebuilt under the reader. */
  private tick(): void {
    const now = Date.now()
    for (const age of this.layout!.querySelectorAll<HTMLElement>('[data-at]')) age.textContent = ago(Number(age.dataset.at), now)
  }

  /**
   * One message: who said it, when, and what, whole, with its files. A message
   * continuing its sender's run names no one; in a thread, its worker is who
   * speaks unless another is named. In the channel, choosing it opens its
   * worker's thread; a close, a hand-off or another lifecycle line is one quiet line.
   */
  private messageRow({ message, replies, last, waiting }: Line, pane: Pane, before: number, now: number, previous?: Message): HTMLLIElement {
    const card = message.card
    const row = el('li', 'kbn-ch-msg')
    row.dataset.kind = message.kind
    row.toggleAttribute('data-waiting', waiting)
    row.toggleAttribute('data-human', message.human)
    row.toggleAttribute('data-chosen', pane === 'channel' && !!this.thread && sameFiber(card, this.thread))
    row.toggleAttribute('data-new', !message.human && message.arrived > before)
    const opens = pane === 'channel'
    const id = `${pane}:${message.id}`
    const owner = pane === 'thread' ? this.threadCard : undefined
    // The thread's own worker speaks unnamed, and names whom it wrote to.
    const own = !!owner && !message.human && !message.label && sameFiber(message.from ?? card, owner)
    const continued = continues(previous, message), named = !own && !continued
    row.toggleAttribute('data-continued', continued)
    const byline = el('div', 'kbn-ch-msg-head')
    if (named) {
      const who = message.human ? 'You' : message.from?.name ?? message.label ?? card.name
      const name = opens ? button('kbn-ch-msg-name', who, () => this.openThread(card)) : el('span', 'kbn-ch-msg-name', who)
      name.dataset.item = id
      if (opens) name.title = `Open ${card.name}'s thread`
      byline.append(name)
    }
    if (own && message.from && !sameFiber(card, owner!)) byline.append(el('span', 'kbn-ch-msg-to', `to ${card.name}`))
    const words = ({ closed: message.text ? `closed (${message.text})` : 'closed', handed_off: 'handed off', event: message.text } as Partial<Record<Message['kind'], string>>)[message.kind]
    if (words !== undefined) {
      row.classList.add('kbn-ch-line')
      byline.append(el('span', 'kbn-ch-line-text', words))
    }
    if (message.at > 1) {
      const age = el('span', 'kbn-ch-age', ago(message.at, now))
      age.dataset.at = String(message.at)
      byline.append(age)
    }
    const body = el('div', 'kbn-ch-msg-body')
    body.append(byline)
    if (message.kind === 'tapestry') body.append(this.tapestryCard(message))
    else if (words === undefined) {
      const said = message.text || (message.kind === 'review' ? 'Closed for your review.' : '')
      if (said) {
        const text = el('div', 'kbn-ch-msg-text')
        const label = ({ ask: 'Asks', review: 'For review', turn: 'Stopped' } as Partial<Record<Message['kind'], string>>)[message.kind]
        if (label && message.waiting) text.dataset.label = label
        text.dataset.id = message.id
        text.innerHTML = renderMarkdown(said)
        body.append(text)
      }
    }
    if (message.files.length) body.append(this.attachments(message, id))
    // A worker's line in the channel carries its own tapestry; the chair's is a message of its own.
    const tapestry = pane === 'channel' ? this.embedded(card, pane) : null
    if (tapestry) body.append(this.embed(tapestry, card, `embed:${id}`))
    if (replies > 0) {
      const link = button('kbn-ch-replies', `${replies} ${replies === 1 ? 'reply' : 'replies'}`, () => this.openThread(card))
      link.dataset.item = `replies:${fiberOf(card)}`
      const age = el('span', 'kbn-ch-age', ago(last, now))
      age.dataset.at = String(last)
      link.append(el('span', 'kbn-ch-replies-last', ' · last '), age)
      body.append(link)
    }
    if (message.kind === 'review' && message.waiting) {
      const key = `${fiberOf(card)}:${message.at}`
      const temper = button('kbn-ch-act', this.tempering.has(key) ? 'Tempering…' : 'Temper', () => { void this.temper(card, key) })
      temper.disabled = this.tempering.has(key)
      temper.title = 'Accept the work as done'
      const acts = el('div', 'kbn-ch-acts')
      acts.append(temper)
      body.append(acts)
    }
    const gutter = !named || message.human ? el('span', 'kbn-ch-you') : stateDot(message.from ?? card, worker => this.openThread(worker))
    if (opens) {
      // The whole message opens its thread, save its links, its buttons and a selection.
      row.addEventListener('click', event => {
        if ((event.target as Element).closest('a, button, input, .kbn-ch-tapestry-page') || getSelection()?.toString()) return
        this.openThread(card)
      })
    }
    row.append(gutter, body)
    return row
  }
  /** A message's files: images drawn small inline, every other file a chip; each opens in the reader. */
  private attachments(message: Message, id: string): HTMLElement {
    const box = el('div', 'kbn-ch-attached'), base = this.ctx?.shuttleBase ?? ''
    for (const file of message.files) {
      const item = `${id}:${file.fullPath}`
      const open = (): void => { this.returnTo = item; this.openFile(file, message.card) }
      const chip = (gone: boolean): HTMLButtonElement => {
        const node = button('kbn-ch-file', file.basename, open)
        node.dataset.item = item
        node.title = gone ? `${file.fullPath} could not be read` : file.fullPath
        node.toggleAttribute('data-gone', gone)
        return node
      }
      if (IMAGE.test(file.basename)) {
        const figure = button('kbn-ch-image', '', open)
        figure.dataset.item = item
        figure.title = file.fullPath
        const img = el('img', '')
        img.alt = file.basename
        img.loading = 'lazy'
        img.src = fileBytesUrl(base, file.fullPath, file.host ?? message.card.originId)
        // An image its host no longer holds (a removed worktree, a cleared scratch folder) is named, not drawn as an empty frame.
        img.addEventListener('error', () => figure.replaceWith(chip(true)))
        figure.append(img, el('span', 'kbn-ch-image-name', file.basename))
        box.append(figure)
        continue
      }
      box.append(chip(false))
    }
    return box
  }
  /** The chair's tapestry: its title and lede, read whole in place or opened in the reader. */
  private tapestryCard(message: Message): HTMLElement {
    const box = el('div', 'kbn-ch-tapestry')
    const viewer = this.expanded.get(message.id)
    box.append(el('p', 'kbn-ch-tapestry-kicker', 'Tapestry'), el('p', 'kbn-ch-tapestry-title', message.title ?? ''))
    if (message.text) box.append(el('p', 'kbn-ch-tapestry-lede', message.text))
    const acts = el('div', 'kbn-ch-acts')
    const toggle = button('kbn-ch-act', viewer ? 'Fold it' : 'Read it here', () => this.toggleTapestry(message))
    toggle.setAttribute('aria-expanded', String(!!viewer))
    toggle.dataset.item = `tapestry:${message.id}`
    const open = button('kbn-ch-act', 'Open', () => {
      this.returnTo = `tapestry-open:${message.id}`
      this.openFile({ fullPath: message.path!, basename: message.path!.split('/').pop()!, timestamp: message.at }, message.card)
    })
    open.dataset.item = `tapestry-open:${message.id}`
    acts.append(toggle, open)
    if (viewer) {
      const page = el('div', 'kbn-ch-tapestry-page')
      page.append(viewer)
      box.append(page)
    }
    box.append(acts)
    return box
  }
  /** The tapestry a worker's line in the channel, or a thread's head, shows: its own, unless it chairs the channel. */
  private embedded(card: KanbanCard, pane: Pane): Tapestry | null {
    if (pane === 'channel' && this.channel && sameFiber(card, this.channel.seat)) return null
    return this.tapestries.get(fiberOf(card))?.tapestry ?? null
  }
  /** A tapestry drawn small: its first figure, title and lede; choosing it opens the page in the reader. */
  private embed(tapestry: Tapestry, card: KanbanCard, item: string): HTMLElement {
    const box = button('kbn-ch-embed', '', () => {
      this.returnTo = item
      this.openFile({ fullPath: tapestry.path, basename: tapestry.path.split('/').pop()!, timestamp: tapestry.at }, card)
    })
    box.dataset.item = item
    box.title = `Open ${tapestry.title}`
    if (tapestry.figure) {
      const figure = el('img', 'kbn-ch-embed-figure')
      figure.alt = ''
      figure.loading = 'lazy'
      figure.src = tapestry.figure
      figure.addEventListener('error', () => figure.remove())
      box.append(figure)
    }
    const words = el('span', 'kbn-ch-embed-words')
    words.append(el('span', 'kbn-ch-tapestry-kicker', 'Tapestry'), el('span', 'kbn-ch-embed-title', tapestry.title))
    if (tapestry.lede) words.append(el('span', 'kbn-ch-embed-lede', tapestry.lede))
    box.append(words)
    return box
  }
  private toggleTapestry(message: Message): void {
    const viewer = this.expanded.get(message.id)
    if (viewer) { disposeFileViewer(viewer); this.expanded.delete(message.id) }
    else this.expanded.set(message.id, buildFileViewer(this.ctx!.shuttleBase, message.path!, message.card.originId, undefined, undefined, { active: true }))
    this.drawChannel()
  }

  /** The open thread: its worker's name and liveness, its open ask or a closed fiber's conclusion, what it said and what was said to it. */
  private drawThread(): void {
    if (!this.threadEl || !this.threadHead || !this.threadList || !this.threadReply) return
    const channel = this.channel, card = channel && this.threadCard
    this.layout?.toggleAttribute('data-thread', !!card)
    this.threadEl.hidden = !card
    if (!channel || !card) { this.sigs.thread = ''; this.threadList.replaceChildren(); return }
    // The open ask stands in the thread's head, so its history does not say it again.
    const now = Date.now(), messages = threadOf(this.messages(channel), card).filter(message => !(message.kind === 'ask' && message.waiting && sameFiber(message.card, card)))
    const state = liveness(card)
    const deeper = this.drillsDown()
    this.readTapestry(card)
    const tapestry = this.embedded(card, 'thread')
    const sig = JSON.stringify([fiberOf(card), card.name, card.outcome, card.ask?.text, card.status, card.turn, state, deeper, tapestry, [...this.tempering], [...this.unfolded],
      messages.map(message => [message.id, message.kind, message.text, message.waiting, message.files.map(file => file.fullPath)])])
    if (this.changed('thread', sig)) {
      const close = deeper
        ? iconButton('kbn-ch-thread-close', 'back', `Back to # ${channel.name}`, () => this.openThread(null))
        : iconButton('kbn-ch-thread-close', 'leave', 'Close the thread', () => this.openThread(null))
      const who = el('div', 'kbn-ch-thread-who')
      const id = `thread-name:${fiberOf(card)}`
      const name = button('kbn-ch-thread-name', card.name, () => this.openPage(id, card))
      name.dataset.item = id
      name.title = 'Open its page'
      const word = el('span', 'kbn-ch-liveness', state)
      word.dataset.state = state
      who.append(stateDot(card, worker => this.openCard(worker)), name, word)
      const standing: HTMLElement[] = []
      if (card.ask && card.status === 'active') {
        const ask = el('div', 'kbn-ch-status kbn-ch-thread-ask')
        ask.innerHTML = renderMarkdown(card.ask.text)
        standing.push(ask)
      }
      // The outcome is a closed fiber's conclusion; an open one shows only what it waits on.
      if (card.status === 'closed' && card.outcome) {
        const conclusion = el('div', 'kbn-ch-status kbn-ch-conclusion')
        conclusion.innerHTML = renderMarkdown(card.outcome)
        standing.push(conclusion)
      }
      if (tapestry) standing.push(this.embed(tapestry, card, `thread-embed:${fiberOf(card)}`))
      // A closed fiber has no worker to hear a reply: reopening it from its page brings one back.
      if (state === 'closed') standing.push(el('p', 'kbn-ch-hush kbn-ch-reopen', 'Closed. Reopen it from its page to reply.'))
      this.threadHead.replaceChildren(close.root, who, ...standing)
      this.fill(this.threadList, messages.map(message => ({ message, replies: 0, last: message.at, waiting: message.waiting })), 'thread', channel, now)
      if (!messages.length) this.threadList.append(el('li', 'kbn-ch-hush', 'Nothing said yet.'))
    }
    this.tick()
    this.threadReply.form.hidden = state === 'closed'
    this.threadReply.to.textContent = card.name
  }

  /** Sends to a worker; the reply stands in the stream until the board carries it. */
  private async send(card: KanbanCard | undefined, text: string, pane: Pane): Promise<boolean> {
    const ctx = this.ctx, channel = this.current
    if (!card || !ctx) return false
    try {
      const answer = await postDaemonJson<{ delivered?: boolean | null; error?: string; duplicate?: boolean; disposition?: string }>(ctx.shuttleBase, '/api/v1/deliver',
        { fiber_id: card.id, origin: card.originId, text, from: 'human', message_id: this.messageIds.for([card.originId, card.id, text].join('\0')) }, 'Reply failed')
      if (answer?.delivered === false) throw new Error(answer.error ?? `${card.name} did not receive it`)
      this.messageIds.sent()
      const notice = repeatNotice(answer)
      if (notice) { this.status(notice); return false }
      this.sent.push({ fiber: fiberOf(card), text, at: Date.now() })
      this.drafts.delete(pane === 'channel' ? `channel:${channel}` : `thread:${fiberOf(card)}`)
      if (channel) this.renew(channel)
      this.landing[pane] = true
      this.status(answer?.delivered === null ? `Sent to ${card.name}; its arrival is not yet confirmed.` : '')
      announce(`Sent to ${card.name}.`)
      this.drawChannel(); this.drawThread()
      ctx.requestRefresh()
      return true
    } catch (error) {
      this.status(`Not sent: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }
  /** Writes a channel's set-aside (the waiting mark clears), unpin, hide or show, and restores it when the write fails. */
  private async setAside(channel: Channel, key: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    this.pending.push(key)
    if (key.startsWith('pin:')) this.pinned.delete(channel.key)
    this.draw()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber: fiberOf(channel.seat) })
    } catch {
      this.pending = this.pending.filter(item => item !== key)
      this.draw()
      const done = ({ pin: 'unpinned', hide: 'hidden', show: 'brought back' } as Record<string, string>)[key.split(':')[0]] ?? 'set aside'
      this.status(`${channel.name} could not be ${done}; it is as it was.`)
    }
  }
  /** A rail entry's menu: hide or bring back, pin or unpin, move to the bottom. */
  private railMenu(key: string, pick: HTMLElement, point?: { x: number; y: number }): void {
    const channel = this.channels.find(each => each.key === key)
    if (!channel) return
    const now = Date.now()
    openActionMenu(pick, [
      ...channel.waiting ? [{ label: 'Not now', run: () => { void this.setAside(channel, setAsideKey(channel)) } }] : [],
      channel.hidden
        ? { label: 'Unhide', run: () => { void this.setAside(channel, showKey(key, now)) } }
        : { label: 'Hide', run: () => { void this.setAside(channel, hideKey(key, now)); announce(`${channel.name} hidden; Jump to finds it.`) } },
      channel.pinned
        ? { label: 'Unpin', run: () => { void this.setAside(channel, unpinKey(key, now)) } }
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
  private async temper(card: KanbanCard, key: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    this.tempering.add(key)
    this.drawChannel(); this.drawThread()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/transition', { fiber_id: card.id, target: 'tempered', origin: card.originId }, 'Temper failed')
      // It stays disabled until the refreshed board takes the review away.
      ctx.requestRefresh()
    } catch (error) {
      this.tempering.delete(key)
      this.status(`${card.name} was not tempered: ${error instanceof Error ? error.message : String(error)}`)
      this.drawChannel(); this.drawThread()
    }
  }

  /** Whether a thread takes the channel's place rather than standing beside it: on a phone, or in a view too narrow for both. */
  private drillsDown(): boolean { return isMobileViewport() || !!this.layout?.hasAttribute('data-narrow') }
  private railShown(): boolean { return isMobileViewport() ? this.phoneRail : !this.railHidden }
  /** Hides or shows the rail: remembered in this browser on a desktop; on a phone, the rail is the screen before a channel. */
  private setRail(hidden: boolean): void {
    if (isMobileViewport()) this.phoneRail = !hidden
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
   * across a thread it closes the thread, across a channel it brings the rail;
   * drawn leftward it puts the rail away. A two-finger trackpad swipe does the
   * same. Content that scrolls sideways, and a tapestry read in place, keep it.
   */
  private gestures(root: HTMLElement): () => void {
    const surface = (target: EventTarget | null): Element | null => {
      const node = target as Element | null
      if (this.ctx?.workspace?.isActive || node?.closest?.('.kbn-ch-tapestry-page')) return null
      return node?.closest?.('.kbn-ch-thread, .kbn-ch, .kbn-ch-rail') ?? null
    }
    const back = (on: Element): void => {
      if (on.classList.contains('kbn-ch-thread')) this.openThread(null)
      else if (on.classList.contains('kbn-ch')) this.setRail(false)
    }
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
      // Leftward puts the rail away only for a channel to show.
      if (dx < 0) { if (this.channel) this.setRail(true) }
      else back(from.on)
    }
    const wheel = (event: WheelEvent): void => {
      const on = surface(event.target)
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY) || !on || scrollsSideways(event.target as Element, root, event.deltaX)) return
      // Taking the gesture keeps the browser from going back a page.
      event.preventDefault()
      // One swipe is a burst of wheel events: it acts once, and a pause starts the next.
      if (event.timeStamp - last > 300) travel = 0
      last = event.timeStamp
      if (Number.isNaN(travel)) return
      travel += event.deltaX
      if (Math.abs(travel) < SWIPE_PX) return
      if (travel > 0) { if (this.channel) this.setRail(true) }
      else back(on)
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
  private openPage(from: string, card: KanbanCard, key?: DocKey): void {
    this.returnTo = from
    this.ctx?.workspace?.openPage(card, key)
  }
  /** openFromDesk reaches the card as the Desk does, so voice's in-view target releases its held lines. */
  private openCard(card: KanbanCard): void {
    if (this.ctx?.workspace) this.ctx.workspace.openFromDesk(card)
    else this.ctx?.openCard(card.id)
  }
  /** Opens a sent file in the reader, under the fiber that sent it. */
  private openFile(file: SentFile, sender: KanbanCard): void {
    const card = (file.uid && this.ctx ? cardNamed(boardCards(this.ctx.response), file.uid, file.host ?? '') : undefined) ?? sender
    if (this.ctx?.workspace) this.ctx.workspace.openPage(card, docKey(file.host ?? card.originId, file.fullPath, card.originId, card.fiberDir))
    else this.openCard(card)
  }
  private step(by: number): void {
    const listed = this.listed
    if (!listed.length) return
    const at = listed.findIndex(channel => channel.key === this.current)
    this.open(listed[Math.max(0, Math.min(listed.length - 1, at + by))].key, true, false)
  }

  keydown(event: KeyboardEvent): boolean {
    // An item picked up in the rail owns the keys until it lands.
    if (this.rail?.moving) return true
    if (event.metaKey || event.ctrlKey || event.altKey) return false
    const active = document.activeElement as HTMLElement | null
    const replying = active === this.channelReply?.text || active === this.threadReply?.text
    if (event.key === 'Escape' && (replying || active === this.jump)) { (this.thread ? this.threadEl : this.channelEl)?.focus({ preventScroll: true }); return true }
    // Enter in the bar's Find opens what it found first.
    if (event.key === 'Enter' && this.query && isTypingTarget(active) && !replying && active !== this.jump) { this.openFirst(); return true }
    if (keystrokeIsSpokenFor()) return false
    if (event.key === 'Escape' && this.thread) { this.openThread(null); return true }
    if (event.key === '/' && this.jump) { this.setRail(false); this.jump.focus({ preventScroll: true }); return true }
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.setRail(this.railShown()); return true }
    if (event.key === 'Enter' && !active?.closest('button, a, input') && this.channel) {
      (this.thread ? this.threadReply : this.channelReply)?.text.focus()
      return true
    }
    return false
  }
  unmount(): void {
    // A document still being read from its owner does not open once Channels is left.
    this.ctx?.workspace?.library.cancelOpen()
    this.keepDrafts()
    if (this.current) store(SEEN + this.current, String(Date.now()))
    this.query = ''
    for (const viewer of this.expanded.values()) disposeFileViewer(viewer)
    this.expanded.clear()
    this.generation++
    for (const feed of this.feeds.values()) feed.pending = false
    this.unsubscribe?.(); this.unsubscribe = undefined
    this.unsubscribeLibrary?.(); this.unsubscribeLibrary = undefined
    this.stopGestures?.(); this.stopGestures = undefined
    this.sizes?.disconnect(); this.sizes = null
    this.width?.disconnect(); this.width = null
    for (const unbind of this.railBindings) unbind()
    this.railBindings = []
    this.rail?.destroy(); this.rail = null
    this.reading = false
    this.ctx = null
    this.layout = this.channelEl = this.head = this.note = this.threadEl = this.threadHead = null
    this.list = null; this.found = null; this.jump = null; this.stream = null; this.threadList = null; this.railToggle = null
    this.channelReply = this.threadReply = null
    this.sigs = { channel: '', thread: '', rail: '' }
  }
}

/** A reply box: who it goes to, the words, and Send; Enter sends and Shift+Enter breaks the line. */
class Reply {
  readonly form = el('form', 'kbn-ch-reply')
  readonly text = el('textarea', 'kbn-ch-reply-text')
  readonly to = el('span', 'kbn-ch-reply-to')
  constructor(send: (text: string) => Promise<boolean>) {
    const label = el('label', 'kbn-ch-reply-label', 'To ')
    label.append(this.to)
    this.text.rows = 1
    label.htmlFor = this.text.id = `kbn-ch-reply-${Math.random().toString(36).slice(2)}`
    this.text.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.form.requestSubmit() }
    })
    const submit = el('button', 'kbn-ch-send', 'Send')
    submit.type = 'submit'
    const row = el('div', 'kbn-ch-reply-row')
    row.append(this.text, submit)
    this.form.append(label, row)
    this.form.addEventListener('submit', event => {
      event.preventDefault()
      const words = this.text.value.trim()
      if (!words) return
      this.text.disabled = true
      void send(words).then(sent => { if (sent) this.text.value = '' }).finally(() => { this.text.disabled = false })
    })
  }
}
registerView(new ChannelsView())
