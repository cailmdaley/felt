import { announce } from '@ui-sdk/core'
import '@ui-sdk/web/tooltip'
import { relative, retime } from '../elements/time.js'
import { getDaemonJson, postDaemonJson } from '../daemonApi.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { boardCards, threadIndexFor } from '../KanbanSurfaces.js'
import { isMobileViewport } from '../mobile.js'
import {
  MISC, arranged, bygone, clearLineKey, clearedLines, lineIds, composeChannels, composeStream, fiberOf, runningIn, hideKey, railOrder, reordered, showKey, unclearLineKey, unpinKey,
  type Channel, type Entry, type Item, type Station,
} from '../channels.js'
import { layTube, rowHeight, runsOf, tautness, type Tube, type TubeLine } from '../tube.js'
import { GUTTER, drawMargin, tautAlong, type MarginRow } from '../margin.js'
import { random } from '../ink.js'
import { lineHue } from '../lineHue.js'
import { createRailReorder, type RailReorder } from '../channelRail.js'
import { RailMotion, SLOP_PX, SpentSwipe, WHEEL_IDLE_MS, WheelAxis } from './railMotion.js'
import type { SwipeSignal } from '../workspace/PhoneGestures.js'
import { openActionMenu } from '../conversationMenu.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { CLEAR_UNDO_MS, clearToast, fewAtATime, showToast } from '../utils.js'
import { channelPicker } from '../channelPicker.js'
import { ATTENTION_ORDER, attentionOf, lastActive, type Waits } from '../attention.js'
import { turnOf } from '../turn.js'
import { docKey } from '../workspace/documents.js'
import { headerIcon, type HeaderIcon } from '../workspace/headerIcon.js'
import { declaredTitle } from '../workspace/DocumentTitles.js'
import { docButtons, type DocButtons } from '../workspace/docButtons.js'
import { CARD_PX, foldPx, PageCard, PREVIEW_GAP, previewsHeight, Unfold, type UnfoldFile } from '../elements/filePreview.js'
import { groups, kindWord, post } from '../elements/post.js'
import { doing, threadRow } from '../elements/threadRow.js'
import { onDesk } from '../workspace/fiberPageState.js'
import type { Dock } from '../workspace/Dock.js'
import { createViewPage } from './ViewPage.js'
import { isTypingTarget, keystrokeIsSpokenFor, registerView, type TemporalView, type ViewContext } from './ViewRegistry.js'
import { channelMatches, foldStream, matchedRows, needleOf } from '../search/match.js'
import { takeSidewaysWheel } from '../workspace/DocumentBridge.js'
import { highlight, unhighlight } from '../search/highlight.js'
import type { FindScope } from '../search/scope.js'
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
/** How far an overlaid rail's shadow reaches past its edge: put away, it stands this much further out. */
const SHADOW_PX = 24
/** About how tall a post stands without its files: its head and two lines of words. */
const POST_PX = 64
/** A constitution, as whether it has a tapestry is remembered. */
const tapestryKey = (card: KanbanCard): string => `${card.originId}:${fiberOf(card)}`
/** How many of a clear's records are written at once: each write is a process in the daemon. */
const CLEAR_WRITES = 4
/** A channel written here is shown so this long at most before the feed's word stands, whatever it says. */
const MOVED_MS = 60_000
/** A channel opens on this many of its newest lines to the human, or back to the oldest it holds unread or waiting; Earlier shows as many again. */
const OPENS_ON = 8
/** A stream within this many pixels of its foot follows what arrives. */
const FOLLOW_PX = 24
/** Narrower than this, the rail is a drawer drawn in over the stream. */
const DRAWER_PX = 1100
/** The margin's width: wide on a desktop, where the fibres can wander; narrower where the stream's width is scarce. */
const MARGIN = { wide: 56, narrow: 50, below: 560 } as const
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
const forget = (key: string): void => { try { localStorage.removeItem(key) } catch { /* A convenience only. */ } }
/** This device's seen marks and last channel for keys no channel has ({@link bygone}) go. */
function forgetBygone(): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '')
    for (const key of keys) if ((key.startsWith(SEEN) && bygone(key.slice(SEEN.length))) || (key === LAST && bygone(stored(LAST) ?? ''))) forget(key)
  } catch { /* A convenience only. */ }
}
/** A waiting line that is a worker's own open question (`shuttle.ask`), which its ✓ withdraws. */
const withdraws = (item: Item): boolean => item.waiting && item.kind === 'ask' && item.card.status === 'active' && !!item.card.ask
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
 * or a fibre opens that constitution's view; a file opens in the reader.
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
  private railToggle: IconButton | null = null
  private channelEl: HTMLElement | null = null
  private head: HTMLElement | null = null
  /** The chair's pages in the head. */
  private pages?: DocButtons
  /** The channel the head was last drawn for. */
  private headKey?: string
  private stream: HTMLOListElement | null = null
  /** Says, politely, how many matches a fold found and which is in hand. */
  private foundSay: HTMLElement | null = null
  private note: HTMLElement | null = null
  /** The console, to the channel's chair. */
  private dock: Dock | null = null
  /** Whose draft the console holds: the channel it was last opened on. */
  private drafted: string | null = null
  /** What was typed to each channel's chair, by channel, kept while the reader is elsewhere. */
  private readonly drafts = new Map<string, string>()
  /** Each item's files as previews, each opening its file in the reader, by item, kept across redraws. */
  private readonly unfolds = new Map<string, Unfold>()
  /** Each fiber's newest close's tapestry, by item, kept across redraws and looked for again on each. */
  private readonly pageCards = new Map<string, PageCard>()
  /** Whether a constitution has a tapestry, as its last look said; a look that could not tell leaves it be. */
  private readonly tapestries = new Map<string, boolean>()
  /** The stream's rows as last drawn, by entry, each with what it drew: a row that would draw the same is kept. */
  private readonly rows = new Map<string, { sig: string; node: HTMLLIElement }>()
  private channels: Channel[] = []
  private current: string | null = null
  /** When the channel was come to, and what this device had read of it then: what arrived since stays in its window. */
  private opened = { at: 0, seen: -Infinity }
  /** Where the channel's window starts once it is known: it only ever reaches further back while the channel stays open. */
  private from = Infinity
  /** What Jump to is looking for; '' lists the rail. */
  private query = ''
  /** What the bar's Find folds the open channel's stream to; '' draws it whole. */
  private folding = ''
  /** The match in hand while the stream is folded, by entry, and every match in stream order. */
  private foundAt: string | null = null
  private foundRows: string[] = []
  /** Where Find asked Channels to go, kept until the channels are read. */
  private wanted: { channel: string; item?: string } | null = null
  /** The line Find brought the channel to, marked, by entry. */
  private markedItem: string | null = null
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
  /** Where the stream stood when the reader last moved it or the board last put it somewhere: a scroll event that finds it there was not the reader moving. */
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
  /** Channels written here, by fiber, until the feed carries them or {@link MOVED_MS} passes: a spelling, or null for none. */
  private moved = new Map<string, { to: string | null; at: number }>()
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
  /** The rail's place as it moves: following a gesture, or settling. */
  private readonly motion = new RailMotion({
    begin: () => this.beginMotion(),
    render: p => this.renderMotion(p),
    commit: shown => {
      this.setRail(!shown)
      // A phone's channel bared by a rail that came back was glimpsed, not read: its seen mark stands as it was.
      if (shown && this.peeked) { if (this.peeked.seen === null) forget(SEEN + this.peeked.key); else store(SEEN + this.peeked.key, this.peeked.seen) }
      this.peeked = null
      // A phone that has come to its channel reads it.
      if (!shown && isMobileViewport()) { this.drawRail(); this.channelEl?.focus({ preventScroll: true }) }
      this.renderMotion(this.motion.p)
    },
    end: () => {
      this.peeked = null
      this.layout?.removeAttribute('data-rail-moving')
      for (const name of ['--kbn-ch-rail-x', '--kbn-ch-stream-x']) this.layout?.style.removeProperty(name)
    },
    still: () => !this.layout?.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches,
  }, true)
  /** The rail's width as it moves. */
  private motionWidth = 0
  /** On a phone, the channel a leaving rail bares, and its seen mark before it was bared. */
  private peeked: { key: string; seen: string | null } | null = null

  mount(host: HTMLElement, ctx: ViewContext): void {
    this.ctx = ctx
    // The view outlives its mounts: coming back to the channel it showed is coming to it again, and reading it.
    if (this.current) {
      this.opened = { at: Date.now(), seen: lastSeen(this.current) }
      this.from = Infinity
      store(SEEN + this.current, String(Date.now()))
    }
    const page = createViewPage('Channels')
    page.root.classList.add('kbn-channels')
    // The board's tab bar names the view: the channel's own head is the view's top row, the rail's toggle at its right.
    page.titleRow.remove()
    this.railToggle = iconButton('kbn-ch-rail-toggle', 'rail', '', () => this.moveRail(this.railShown()))
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
      this.motion.rest(this.railShown())
      this.showRail()
    })
    this.width.observe(this.layout)
    // A drawn-in rail ends where the console begins.
    this.consoleSize = new ResizeObserver(() => this.layout?.style.setProperty('--kbn-ch-console', `${this.dock?.el.offsetHeight ?? 0}px`))
    if (this.dock) this.consoleSize.observe(this.dock.el)
    // A press outside the drawn-in rail puts it away.
    this.layout.addEventListener('pointerdown', event => {
      if (this.overDrawer() && !(event.target as Element).closest('.kbn-ch-rail, .kbn-ch-rail-toggle')) this.moveRail(true)
    })
    this.railHidden = stored(RAIL) === '1'
    forgetBygone()
    this.showRail()
    const workspace = ctx.workspace!
    this.unsubscribe = [
      ctx.sends?.subscribe(() => this.draw()) ?? (() => {}),
      workspace.board.subscribe(() => this.draw()),
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
    this.jump.setAttribute('aria-label', 'Jump to a channel')
    this.jump.addEventListener('input', () => this.filter(this.jump!.value))
    this.jump.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.openFirst() }
      if (event.key === 'Escape' && this.jump!.value) { event.stopPropagation(); this.filter('') }
    })
    this.list = el('ol', 'kbn-ch-list')
    // Jump to stands in a band as tall as the channel's head, its rule running on from the head's.
    const head = el('div', 'kbn-ch-rail-head')
    head.append(this.jump)
    rail.append(head, this.list)
    return rail
  }
  private channelPane(): HTMLElement {
    this.channelEl = el('article', 'kbn-ch')
    this.channelEl.tabIndex = -1
    this.head = el('header', 'kbn-ch-head')
    this.stream = el('ol', 'kbn-ch-stream')
    this.stream.addEventListener('scroll', () => {
      // Only the reader's own scroll says whether the stream follows: one that finds it where it was last put changes nothing,
      // so rows that grow before a scroll's event arrives leave it following, and a line Rex brought stays in sight.
      if (Math.abs(this.stream!.scrollTop - this.lastTop) > 1) {
        this.lastTop = this.stream!.scrollTop
        this.following = this.atFoot()
      }
      if (!this.painting && this.leavingBand()) this.painting = requestAnimationFrame(() => { this.painting = 0; this.paint() })
    }, { passive: true })
    // What the human sends from here is answered at the stream's foot: a send returns the stream there, wherever it was being read.
    this.dock = this.ctx!.workspace!.console({ keepPlace: true, onSent: () => { this.following = true; this.toFoot() } })
    this.dock.el.hidden = true
    this.foundSay = el('p', 'ws-sr-only')
    this.foundSay.setAttribute('role', 'status')
    this.channelEl.append(this.head, this.stream, this.foundSay, this.dock.el)
    return this.channelEl
  }
  /** Opens the console on the channel's chair, with the draft kept for that channel; a chair with no worker to run has none. Its pages stand in the channel's head, so the console names none. */
  private seatConsole(channel: Channel | undefined): void {
    const dock = this.dock
    if (!dock) return
    dock.el.hidden = !channel?.seat || !onDesk(channel.seat)
    if (!channel?.seat || dock.el.hidden) return
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
      // A key no channel can have now is dropped, so the next write of the order leaves it out.
      if (order && order.at >= this.orderAt) { this.order = order.keys.filter(key => !bygone(key)); this.orderAt = order.at }
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
    // A channel written here stands until the feed carries it.
    const patched = new Map<string, KanbanCard>()
    const patch = (card: KanbanCard): KanbanCard => {
      const uid = fiberOf(card)
      const move = this.moved.get(uid)
      if (!move) return card
      const want = move.to ?? undefined
      if ((card.shuttleChannel?.trim() || undefined) === want || Date.now() - move.at > MOVED_MS) { this.moved.delete(uid); return card }
      return patched.get(uid) ?? patched.set(uid, { ...card, shuttleChannel: want }).get(uid)!
    }
    return composeChannels({
      cards: boardCards(ctx.response).map(patch), parentOf: card => { const parent = index.parentOf(card); return parent && patch(parent) },
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
    // A channel's key, its name, its title and its members are all searchable.
    const needle = needleOf(this.query)
    return rail.filter(channel => channelMatches(channel, needle))
  }
  /** Filters the rail by what Jump to holds. */
  private filter(query: string): void {
    this.query = query.trim()
    if (this.jump && this.jump.value !== query) this.jump.value = query
    this.drawRail()
  }
  /** Enter in Jump to opens the first channel it found. */
  private openFirst(): void {
    const channel = this.listed[0]
    if (channel) { this.filter(''); this.open(channel.key, true) }
  }

  /** With a channel open, the bar's Find searches it in place, folding its stream to what matches; else it searches the whole board. */
  findScope(): FindScope | undefined {
    const channel = this.channel
    if (!channel || !this.layout?.isConnected) return undefined
    return {
      chip: `in #${channel.name}`,
      inPlace: { input: query => this.fold(query), step: by => this.stepFound(by), keep: () => this.keepFound(), clear: () => this.unfold() },
    }
  }
  /** Find picked a channel, or a line in one: it opens there once the channels are read, a hidden one brought back, the line marked. */
  show(target: { channel: string; item?: string }): void {
    this.wanted = target
    if (this.loaded && this.layout?.isConnected) this.draw()
  }
  private applyWanted(): void {
    const wanted = this.wanted
    if (!wanted || !this.channels.some(channel => channel.key === wanted.channel)) return
    this.wanted = null
    this.filter('')
    this.open(wanted.channel, true)
    if (!wanted.item) return
    this.markedItem = wanted.item
    this.bring = true
    this.mark()
  }
  /** Folds the open channel's stream to what `query` finds; '' draws it whole. */
  private fold(query: string): void {
    const folding = query.trim()
    if (folding === this.folding) return
    if (!folding) { this.unfold(); return }
    if (!this.folding) this.following = false
    this.folding = folding
    this.foundAt = null
    this.drawChannel()
  }
  /** Draws the stream whole again, the match in hand kept in sight. */
  private unfold(): void {
    if (!this.folding) return
    const at = this.foundAt
    this.folding = ''
    this.foundRows = []
    // The match in hand is drawn, its window widened to it, and then let go.
    this.drawChannel()
    this.foundAt = null
    const row = at ? this.rows.get(at)?.node : undefined
    if (row && this.stream) {
      row.scrollIntoView({ block: row.offsetHeight > this.stream.clientHeight ? 'start' : 'center' })
      this.lastTop = this.stream.scrollTop
      this.following = this.atFoot()
    } else this.following = true
    if (this.following) this.toFoot()
  }
  /** ↑ / ↓ in Find: the previous or next match comes into sight. */
  private stepFound(by: 1 | -1): void {
    const at = this.foundRows.indexOf(this.foundAt ?? '')
    const next = this.foundRows[Math.max(0, Math.min(this.foundRows.length - 1, at < 0 ? this.foundRows.length - 1 : at + by))]
    if (next) this.showFound(next)
  }
  /** Enter in Find: the match in hand takes the keys, the stream still folded. */
  private keepFound(): void {
    const row = this.foundAt ? this.rows.get(this.foundAt)?.node : undefined
    const target = row?.querySelector<HTMLElement>('[data-item]') ?? this.channelEl
    target?.focus({ preventScroll: true })
  }
  /** Marks each match's words, and the match in hand: the one it was, else the newest. */
  private markFound(folded: ReturnType<typeof foldStream> | null): void {
    if (!this.stream) return
    unhighlight(this.stream)
    for (const row of this.stream.querySelectorAll('[data-found]')) row.removeAttribute('data-found')
    this.foundRows = folded ? matchedRows(folded).map(entry => entry.id) : []
    if (!folded) { this.sayFound(); return }
    const needle = needleOf(this.folding)
    for (const id of this.foundRows) for (const part of this.rows.get(id)?.node.querySelectorAll('.kbn-ch-item-text, .uf-file-name, .uf-caption, .kbn-ch-slug') ?? []) highlight(part, needle)
    const at = this.foundAt && this.foundRows.includes(this.foundAt) ? this.foundAt : this.foundRows.at(-1)
    // A redraw that keeps the match in hand leaves the stream where the reader has it.
    if (at) this.showFound(at, at !== this.foundAt)
    else this.sayFound()
  }
  /** The fold's count and the match in hand, for a screen reader; written only when it changes, so a redraw is not announced again. */
  private sayFound(): void {
    const count = this.foundRows.length, at = this.foundAt ? this.foundRows.indexOf(this.foundAt) : -1
    const words = !this.folding ? '' : !count ? 'No matches' : `Match ${at + 1} of ${count}`
    if (this.foundSay && this.foundSay.textContent !== words) this.foundSay.textContent = words
  }
  /** Marks the match in hand and, when it is a new one, brings it into sight. */
  private showFound(id: string, bring = true): void {
    this.foundAt = id
    this.sayFound()
    for (const row of this.stream?.querySelectorAll('[data-found]') ?? []) row.removeAttribute('data-found')
    const row = this.rows.get(id)?.node
    if (!row || !this.stream) return
    row.setAttribute('data-found', '')
    if (!bring) return
    row.scrollIntoView({ block: row.offsetHeight > this.stream.clientHeight ? 'start' : 'center' })
    this.lastTop = this.stream.scrollTop
  }
  private draw(): void {
    const ctx = this.ctx
    if (!ctx || !this.list || !this.loaded) return
    // Nothing redraws under the reader; coming back draws once and returns focus where the reader was opened from.
    if (ctx.workspace?.isActive) { this.depart(); return }
    const returning = this.away
    this.away = false
    this.channels = this.compose(ctx)
    this.applyWanted()
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
  /** The reader covers the channel: the return is awaited. */
  private depart(): void {
    this.away = true
  }
  /** The item the reader was opened from, else the console. */
  private returnFocus(): void {
    const from = this.returnTo
    this.returnTo = null
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
      this.opened = { at: Date.now(), seen: key ? lastSeen(key) : -Infinity }
      this.from = Infinity
      this.current = key
      if (key) { store(SEEN + key, String(Date.now())); store(LAST, key) }
      this.following = true
      this.marked = null
      this.markedItem = null
      // Find searched the channel left: it is put away, its fold and its chip with it; an empty Find follows to the channel come to.
      if (this.folding) { this.folding = ''; this.foundAt = null; this.ctx?.workspace?.clearFind() }
      else this.ctx?.workspace?.followFind()
      const channel = this.channel
      if (channel) this.ctx?.workspace?.board.read(channel.families)
    }
    if (!focus) return
    if (key && deliberate) {
      this.marked = null
      this.markedItem = null
      this.renew(key)
      const channel = this.channels.find(each => each.key === key)
      if (channel?.hidden) void this.dismiss(channel, showKey(key, Date.now()))
    }
    if (isMobileViewport() || this.drawn) this.moveRail(true)
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
    this.markedItem = null
    if (!this.loaded) { this.mark(); return false }
    let card: KanbanCard | undefined
    const channel = this.channels.find(each => (card = each.everyone.find(one => one.uid === id || (one.id === id && one.originId === origin))))
    if (!channel || !card) { this.mark(); return false }
    // While the human types, in the console or a field, Channels stays where it is.
    if (isTypingTarget(document.activeElement as HTMLElement | null)) { this.mark(); return true }
    this.open(channel.key, true, false)
    this.marked = fiberOf(card)
    this.bring = true
    // The window widens to the marked line, and the draw marks it.
    this.drawChannel()
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
    // The line Find picked; else the worker's latest post, else the latest station on its line.
    const own = this.marked ? [...this.stream?.querySelectorAll<HTMLElement>(`:scope > [data-fiber="${CSS.escape(this.marked)}"]`) ?? []] : []
    const picked = this.markedItem ? this.rows.get(this.markedItem)?.node : undefined
    const row = picked?.isConnected ? picked : own.filter(each => each.matches('.kbn-ch-item')).at(-1) ?? own.at(-1)
    if (!row) return
    row.setAttribute('data-marked', '')
    if (!this.bring) return
    this.bring = false
    if (isTypingTarget(document.activeElement as HTMLElement | null)) return
    // A line taller than the stream shows from its first words.
    row.scrollIntoView({ block: row.offsetHeight > this.stream!.clientHeight ? 'start' : 'center' })
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
    // A channel this device has never read counts what arrives from when it first sees it, not everything in the board's reach.
    for (const channel of listed) if (stored(SEEN + channel.key) === null) store(SEEN + channel.key, String(Date.now()))
    const unread = new Map(listed.map(channel => [channel.key, channel.key !== this.current && !channel.waiting ? this.unread(channel) : 0]))
    const waits = this.ctx!.workspace!.board.waiting
    const owed = new Map(listed.map(channel => [channel.key, channel.members.filter(card => attentionOf(card, waits) === 'waiting').length]))
    // A poll that changed nothing in the rail leaves it be.
    const sig = JSON.stringify([this.query, this.current, listed.map(channel => [channel.key, channel.name, channel.title, channel.misc, channel.waiting, !!channel.hidden, unread.get(channel.key), owed.get(channel.key)])])
    if (sig === this.sigs.rail) return
    this.sigs.rail = sig
    for (const unbind of this.railBindings) unbind()
    this.railBindings = []
    const items: HTMLLIElement[] = []
    for (const channel of listed) {
      const item = el('li', 'kbn-ch-rail-item')
      item.toggleAttribute('data-waiting', channel.waiting)
      const pick = button('kbn-ch-pick', '', () => { this.filter(''); this.open(channel.key, true) })
      pick.dataset.channel = channel.key
      pick.dataset.item = `channel:${channel.key}`
      pick.toggleAttribute('data-misc', channel.misc)
      pick.toggleAttribute('data-unread', !!unread.get(channel.key))
      pick.toggleAttribute('data-waiting', channel.waiting)
      pick.append(el('span', 'kbn-ch-pick-hash', '#'), el('span', 'kbn-ch-pick-name', channel.name))
      if (channel.hidden) pick.append(el('span', 'kbn-ch-pick-hidden', 'hidden'))
      // One count of two kinds, drawn apart: a gold disc, how many wait on the human; an ink ring, how many lines are new since this device last read it.
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
      this.railBindings.push(rail.attach(pick, channel.key, channel.waiting || channel.misc || !!this.query))
    }
    if (this.query && !items.length) items.push(el('li', 'kbn-ch-hush kbn-ch-none', 'No channel matches.'))
    this.rebuild(list, items)
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
    const now = Date.now(), whole = this.streamOf(channel), failed = channel.families.some(uid => this.ctx!.workspace!.board.failed(uid))
    // Folded by Find, the stream draws what matches across the whole channel, each life a match is on from its start to its end, and marks where the rest folded away; else it draws its window.
    const folded = this.folding ? foldStream(whole, this.folding) : null
    const { entries, hidden } = folded ? { entries: folded.entries, hidden: 0 } : this.window(whole)
    const seat = channel.seat
    // The head and the stream are drawn apart, so what arrives leaves a focused page or an open menu in the head be;
    // the head waits while a list hangs from its pages, whose count follows the chair's files in place, unless the channel changed: then the list closes.
    const head = JSON.stringify([channel.key, channel.name, channel.title, seat && fiberOf(seat), seat?.modifiedAt])
    const listing = this.headKey === channel.key && !!this.pages?.el.querySelector('[aria-expanded="true"]')
    if (head !== this.sigs.head && !listing) {
      this.pages?.close()
      this.sigs.head = head
      this.headKey = channel.key
      const back = iconButton('kbn-ch-back', 'back', 'Channels', () => this.moveRail(false))
      const name = el('h3', 'kbn-ch-name')
      // With a chair, the name opens the chair's view, as a post's slug opens its thread's.
      const handle = seat ? button('kbn-ch-handle', channel.name, () => this.openLine(seat)) : el('span', 'kbn-ch-handle', channel.name)
      if (seat) handle.title = `Open ${seat.name}`
      name.append(handle)
      name.toggleAttribute('data-misc', channel.misc)
      name.title = channel.title
      // The chair's pages: opening one is a deliberate look at the chair.
      this.pages = seat && docButtons(seat, { ...this.ctx!.workspace!.globeHost.feeds, open: (card, doc) => this.leaveFor(null, () => this.ctx?.workspace?.openPage(card, doc)) })
      this.pages?.el.classList.add('kbn-ch-pages')
      const menu: IconButton = iconButton('kbn-ch-menu', 'actions', 'Channel menu', () => this.railMenu(channel.key, menu.button))
      menu.button.setAttribute('aria-haspopup', 'menu')
      this.head.replaceChildren(this.railToggle!.root, back.root, name, ...this.pages ? [this.pages.el] : [], menu.root)
    } else this.pages?.refresh()
    const waits = this.ctx!.workspace!.board.waiting, running = ranked(runningIn(channel), waits)
    // A row draws an entry; the thread's state, which moves while its worker runs, is painted on it in place.
    // A line follows the one before it in its group: the row above, of the same thread, moments before.
    const grouped = entries.map((entry, row) => { const before = entries[row - 1]; return entry.kind !== 'station' && before?.kind !== 'station' && groups(before, entry) })
    // Each fiber's newest close leads its previews with its tapestry, unless a look found it has none: the channel's newest close
    // with the page's top, the others with a card. An older close lets its go.
    const newest = new Map<string, Item>()
    for (const entry of whole) if (entry.kind === 'close') newest.set(fiberOf(entry.card), entry)
    const last = whole.filter(entry => entry.kind === 'close').at(-1)
    const leading = new Map<Entry, 'page' | 'card'>([...newest.values()].filter(close => this.tapestries.get(tapestryKey(close.card)) !== false).map(close => [close, close === last ? 'page' : 'card']))
    // What the elements draw of its card: its name, slug and office.
    const said = entries.map((entry, row) => [entry.id, entry.kind, entry.at, entry.card.name, slug(entry.card), entry.card.shuttleRole, entry.line, entry.kind === 'station' ? [entry.what, entry.end] : [entry.text, entry.waiting, entry.clears, kindWord(entry), grouped[row], leading.get(entry), entry.files.map(file => [file.host, file.fullPath, file.timestamp]), lineIds(entry)]])
    // The margin's width, and how tall a folded preview stands.
    const margin = this.stream.clientWidth && this.stream.clientWidth < MARGIN.below ? MARGIN.narrow : MARGIN.wide
    const fold = foldPx()
    // A fibre's tension follows its runs, which can move with no row moving (a relaunch inside a life).
    const runs = this.runs(channel, now, waits)
    const ran = [...new Set(entries.map(entry => entry.card))].map(card => runs(card).map(([from, to]) => [from, to === now ? 'now' : to]))
    // The count and its title name the threads running, what waits first, which can change with no entry changing.
    const stream = JSON.stringify([channel.key, this.folding, failed, hidden, said, entries.map(entry => [attentionOf(entry.card, waits), turnOf(entry.card).turn]), fold, margin, ran, running.map(card => [fiberOf(card), attentionOf(card, waits)])])
    if (stream !== this.sigs.stream) {
      this.sigs.stream = stream
      // Each row reckoned by its parts' sizes, a post's by its previews (a tapestry leading them), before anything in it loads.
      const heights = entries.map(entry => {
        if (entry.kind === 'station') return rowHeight(entry)
        const lead = leading.get(entry)
        return POST_PX + (lead ? (lead === 'page' ? fold : CARD_PX) + (entry.files.length ? PREVIEW_GAP : 0) : 0) + previewsHeight(entry.files.map(file => file.fullPath), fold)
      })
      const index = threadIndexFor(this.ctx!.response)
      // Every thread in a channel is its chair's: a parent reaches to a sub-thread only below the chair.
      const parentOf = (card: KanbanCard): KanbanCard | undefined => { const parent = index.parentOf(card); return parent && (!seat || fiberOf(parent) !== fiberOf(seat)) ? parent : undefined }
      const tube = layTube(entries, heights, { parentOf, grouped, active: line => attentionOf(line.card, waits) === 'working' })
      this.tube = { tube, grouped, margin, taut: tautAlong(tube, entries.map(entry => entry.at), line => runs(line.card), tautness) }
      this.stream.style.setProperty('--kbn-ch-tube', `${margin}px`)
      this.stream.style.setProperty('--kbn-ch-gutter', `${GUTTER}px`)
      this.running = running
      const count = el('li', 'kbn-ch-count'), label = button('kbn-ch-count-label', '', () => this.bundleMenu())
      label.hidden = !this.running.length
      label.title = this.runningTitle()
      label.setAttribute('aria-label', label.title)
      label.setAttribute('aria-haspopup', 'menu')
      label.append(el('span', 'kbn-ch-count-n', String(this.running.length)))
      count.append(label)
      // The margin's ink, one drawing over the whole stream, laid over the rows once they stand.
      const ink = el('li', 'kbn-ch-margin')
      ink.setAttribute('aria-hidden', 'true')
      ink.addEventListener('click', event => this.marginClick(event))
      this.entriesDrawn = entries
      this.titles.clear()
      const kept = new Set<string>()
      const drawn = entries.map((entry, row) => {
        const sig = JSON.stringify(said[row]), was = this.rows.get(entry.id)
        const node = was?.sig === sig ? was.node : entry.kind === 'station' ? this.stationRow(entry, now) : this.itemRow(entry, now, grouped[row], leading.get(entry))
        this.rows.set(entry.id, { sig, node })
        kept.add(entry.id)
        if (was?.node === node && entry.kind !== 'station') node.querySelector(':scope > .constitution-state-dot')?.replaceWith(this.dot(entry))
        node.dataset.row = String(row)
        const line = entry.line ? tube.lines.find(each => each.id === entry.line) : undefined
        node.dataset.state = line ? this.lineState(line, waits) : ''
        if (line) node.dataset.hue = hue(line.card)
        return node
      })
      const gap = (rows: number): HTMLLIElement[] => rows ? [el('li', 'kbn-ch-folded', `· · · ${rows} ${rows === 1 ? 'row' : 'rows'} folded · · ·`)] : []
      this.rebuild(this.stream, [count, ink, ...hidden ? [this.earlierRow(hidden)] : [], ...folded ? [...drawn.flatMap((node, row) => [...gap(folded.gaps[row]), node]), ...gap(folded.gaps.at(-1)!)] : drawn])
      for (const id of this.rows.keys()) if (!kept.has(id)) this.rows.delete(id)
      // Each close's tapestry is looked for again, the lookup the cached read, new when its fiber changed or its owner could not say.
      // A close gives up its slot only once a look finds none, and has it back once one is found: the stream is drawn again then.
      for (const close of newest.values()) {
        const found = this.ctx!.workspace!.globeHost.feeds.lead(close.card).then(file => {
          if (file === null) return file
          const key = tapestryKey(close.card), had = this.tapestries.get(key) !== false
          this.tapestries.set(key, !!file)
          if (had !== !!file) this.draw()
          return file
        })
        this.pageCards.get(`item:${close.id}`)?.look(found)
      }
      // What a fold hides keeps its previews, so they stand as they were when it unfolds.
      this.sweep(new Set(whole.flatMap(entry => entry.kind === 'station' ? [] : [`item:${entry.id}`])), new Set([...newest.values()].map(close => tapestryKey(close.card))))
      if (!entries.length) this.stream.append(el('li', 'kbn-ch-hush', folded ? `Nothing in #${channel.name} says “${this.folding}”.` : failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing addressed to you here yet.'))
      if (this.following && !folded) this.toFoot()
      this.mark()
      this.markFound(folded)
      this.watchRows()
      this.paint()
    }
    retime(this.layout!, now)
  }
  /**
   * The part of a channel's stream it shows: from its {@link OPENS_ON}th
   * newest line to the human as of when it was come to, or from its oldest
   * line unread then or waiting, or the worker Rex came to (its latest post,
   * else its latest station), or the line Find picked or held as a fold
   * lifts, whichever is older; with how many lines to the
   * human stand before it. The start only moves back while the channel stays
   * open (Earlier, a line that stops waiting leaves it where it was), and what
   * arrives after is always shown.
   */
  private window(all: Entry[]): { entries: Entry[]; hidden: number } {
    const items = all.filter((entry): entry is Item => entry.kind !== 'station')
    const before = items.filter(item => item.arrived <= this.opened.at)
    let start = before.length > OPENS_ON ? before[before.length - OPENS_ON].at : -Infinity
    const held = items.find(item => item.waiting || item.arrived > this.opened.seen)
    const own = this.marked ? all.filter(entry => fiberOf(entry.card) === this.marked) : []
    const marked = own.filter(entry => entry.kind !== 'station').at(-1) ?? own.at(-1)
    // The line Find picked, and the match in hand as a fold lifts, are drawn wherever they stand.
    const found = all.filter(entry => entry.id === this.markedItem || entry.id === this.foundAt)
    for (const entry of [held, marked, ...found]) if (entry) start = Math.min(start, entry.at)
    // A start reckoned before the channel's lines have all been read is not kept: it would show the whole channel for good.
    const from = Math.min(this.from, start)
    if (Number.isFinite(start)) this.from = from
    return { entries: all.filter(entry => entry.at >= from), hidden: items.filter(item => item.at < from).length }
  }
  /** The row above a channel's window: Earlier shows as many lines again, the stream staying where it was read. */
  private earlierRow(hidden: number): HTMLLIElement {
    const row = el('li', 'kbn-ch-earlier')
    const more = button('kbn-ch-earlier-more', `Earlier · ${hidden} more`, () => {
      const stream = this.stream!, height = stream.scrollHeight, channel = this.channel
      // As many lines again before where the window starts now.
      const items = channel ? this.streamOf(channel).filter(entry => entry.kind !== 'station' && entry.at < this.from) : []
      this.from = items.at(-OPENS_ON)?.at ?? -Infinity
      this.drawChannel()
      stream.scrollTop += stream.scrollHeight - height
      this.lastTop = stream.scrollTop
    })
    more.dataset.item = 'earlier'
    more.title = `${hidden} earlier ${hidden === 1 ? 'line' : 'lines'} to you in this channel`
    row.append(more)
    return row
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
  private watchRows(): void {
    this.rowSizes ??= new ResizeObserver(() => {
      // A row that grows late (a tapestry found, a figure's proportions read) or a stream that shortens (the console growing, the window) keeps a stream that follows at its foot.
      if (this.following) this.toFoot()
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
    this.band = drawn.band
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
  private itemRow(item: Item, now: number, grouped: boolean, lead?: 'page' | 'card'): HTMLLIElement {
    const id = `item:${item.id}`
    const open = (): void => this.leaveFor(id, () => this.ctx?.workspace?.openFromDesk(item.card))
    return post(item, {
      now, dot: this.dot(item), open, grouped, clear: this.check(item),
      previews: lead || item.files.length ? this.previews(item, id, lead) : undefined,
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
   * A line's ✓, on every post, question and file line: the line leaves the
   * stream; a waiting post stops waiting, and a worker's waiting question is
   * withdrawn, read with nothing to answer ({@link withdraw}). A close that waits is given its
   * verdict, and a blocked turn its fix, not a ✓.
   */
  private check(item: Item): HTMLButtonElement | undefined {
    if (item.waiting ? !item.clears && !withdraws(item) : item.kind !== 'post' && item.kind !== 'file' && item.kind !== 'ask') return undefined
    const { card } = item
    const done = button('kbn-ch-clear', '✓', () => {
      done.disabled = true
      void this.clearLine(item, done)
    })
    done.title = item.clears || withdraws(item) ? 'Clear: read, nothing to answer; take it from the stream' : 'Clear: read, take it from the stream'
    done.setAttribute('aria-label', `Clear ${card.name}'s ${item.kind === 'file' ? 'files' : item.kind === 'ask' ? 'question' : 'post'}`)
    return done
  }
  /**
   * Takes a line out of the stream, across the fleet, and a post that waits
   * stops waiting; the line after it takes the focus. One undo is offered as
   * soon as the line leaves, for a few seconds, and restores both: what was
   * written is written back, and what was not yet written never is. The
   * line's records are written a few at a time ({@link CLEAR_WRITES}). A
   * worker's waiting question is withdrawn instead ({@link withdraw}). A
   * refused write brings back what it would have taken and says so. A line
   * cleared again before its last clear's writes (and their undo's) land
   * waits for them, so it clears what waits then.
   */
  private async clearLine(item: Item, done: HTMLButtonElement): Promise<void> {
    const ctx = this.ctx, board = ctx?.workspace?.board
    if (!ctx) return
    if (withdraws(item)) return this.withdraw(item, ctx)
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
    const undo = (): void => {
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
    }
    clearToast(`Cleared ${slug(item.card)}'s line.`, undo)
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
   * A worker's waiting question, read with nothing to answer: it is withdrawn
   * on its owner (`/lifecycle` ask-clear), and once that lands its line leaves
   * the stream. It has no undo, since nothing writes a question back; while
   * the withdrawal is in flight its line is out of sight here, and a refused
   * one brings it back and says so.
   */
  private async withdraw(item: Item, ctx: ViewContext): Promise<void> {
    const at = Date.now(), fiber = fiberOf(item.card), keys = lineIds(item).map(id => clearLineKey(id, at))
    this.pending.push(...keys)
    this.draw()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/lifecycle', { action: 'ask-clear', fiber: item.card.id, origin: item.card.originId }, 'Clear failed')
    } catch {
      this.pending = this.pending.filter(key => !keys.includes(key))
      this.draw()
      this.status(`${item.card.name}'s question could not be withdrawn; it still waits.`)
      return
    }
    showToast(`Withdrew ${slug(item.card)}'s question.`)
    ctx.requestRefresh()
    const written = await fewAtATime(keys, CLEAR_WRITES, key => postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, fiber }, 'Clear failed').then(() => true, () => false))
    if (written.every(Boolean)) return
    this.pending = this.pending.filter(key => !keys.includes(key))
    this.draw()
    this.status(`${item.card.name}'s question no longer waits, but its line could not be taken from the stream.`)
  }
  /**
   * An item's files below its words, each on a line of its own as wide as the
   * item (elements/filePreview.ts); a press opens that file in the reader,
   * whose way back returns to this item. A fiber's newest close leads with
   * its tapestry, drawn in its slot before the tapestry is looked for: the
   * page's top for the channel's newest close, a card for the others.
   */
  private previews(item: Item, id: string, lead?: 'page' | 'card'): HTMLElement {
    const { card } = item
    const shown = { shuttleBase: this.ctx?.shuttleBase ?? '', awake: () => !this.ctx?.workspace?.isActive && !!this.stream?.isConnected }
    const unfold = this.unfolds.get(id) ?? this.unfolds.set(id, new Unfold({ ...shown, open: key => this.openPage(id, card, key) })).get(id)!
    unfold.update(item.files.map((file): UnfoldFile => {
      const key = docKey(file.host ?? card.originId, file.fullPath, card.originId, card.fiberDir)
      return { key, name: declaredTitle(key)?.title ?? file.basename, at: file.timestamp, caption: file.caption }
    }))
    const previews = el('div', 'kbn-ch-previews')
    if (lead) {
      let page = this.pageCards.get(id)
      if (page?.previews !== (lead === 'page')) {
        page?.dispose()
        page = new PageCard(() => void this.openTapestry(id), lead === 'page' ? shown : undefined)
        this.pageCards.set(id, page)
      }
      previews.append(page.el)
    }
    previews.append(unfold.el)
    return previews
  }
  /** `t` on a post: its worker's tapestry opens in the reader; a worker with no tapestry says so. */
  private async openTapestry(id: string): Promise<void> {
    const item = this.entriesDrawn.find((entry): entry is Item => entry.kind !== 'station' && `item:${entry.id}` === id)
    const lead = item && await this.ctx?.workspace?.globeHost.feeds.lead(item.card)
    if (!item || !this.entriesDrawn.includes(item)) return
    if (!lead) { announce(`${slug(item.card)} has no tapestry`); return }
    this.openPage(id, item.card, lead.key)
  }
  /** Lets go of the previews the stream no longer draws, and of what it knew of tapestries of closes no longer in it. */
  private sweep(wanted: ReadonlySet<string>, fibers: ReadonlySet<string> = new Set()): void {
    for (const [id, unfold] of this.unfolds) if (!wanted.has(id)) { unfold.dispose(); this.unfolds.delete(id) }
    for (const [id, page] of this.pageCards) if (!wanted.has(id)) { page.dispose(); this.pageCards.delete(id) }
    for (const key of this.tapestries.keys()) if (!fibers.has(key)) this.tapestries.delete(key)
  }

  /** Writes a channel's unpin, hide or show, counting at once here; a write that fails is taken back and said. */
  private async dismiss(channel: Channel, key: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    if (key.startsWith('pin:')) this.pinned.delete(channel.key)
    this.pending.push(key)
    this.draw()
    try {
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/dismiss', { key, ...channel.seat ? { fiber: fiberOf(channel.seat) } : {} })
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
      ...channel.misc ? [] : [
        channel.pinned
          ? { label: 'Unpin', run: () => { void this.dismiss(channel, unpinKey(key, now)) } }
          : { label: 'Pin', run: () => { void this.pin(channel); this.draw() } },
        { label: 'Move to bottom', run: () => { void this.writeOrder([...this.arrangement().filter(each => each !== key), key]) } },
      ],
      ...channel.families.length ? [{ label: 'Move a thread to another channel…', run: () => { this.familyMenu(channel, pick, point) } }] : [],
      ...channel.misc ? [] : [{ label: `Archive #${channel.name}: its threads go to #misc`, run: () => { void this.archive(channel) } }],
    ], channel.name, point)
  }
  /** The heads a channel holds (each member whose orchestrator speaks elsewhere), each as its row, to choose one to move. */
  private familyMenu(channel: Channel, anchor: HTMLElement, point?: { x: number; y: number }): void {
    const waits = this.ctx!.workspace!.board.waiting, now = Date.now()
    openActionMenu(anchor, ranked([...channel.heads], waits).map(card => ({
      label: card.name, content: threadRow(card, { waits, now }), run: () => { this.moveFamily(card, channel) },
    })), `Move a thread from #${channel.name}`, point)
  }
  /** A card's channel as this view shows it: what it declares, with what was written here and not yet carried by the feed. */
  private declared(card: KanbanCard): string | null {
    const move = this.moved.get(fiberOf(card))
    return move ? move.to : card.shuttleChannel?.trim() || null
  }
  /**
   * Asks where a head and the threads under it go, and writes its channel
   * there. To #misc it clears its own channel, or writes `misc` when the
   * constitution above it (its orchestrator, else what it is filed under)
   * would still give it one.
   */
  private moveFamily(head: KanbanCard, here: Channel): void {
    const choices = this.channels.filter(channel => !channel.misc).map(channel => ({ name: channel.name, spelling: channel.spelling }))
    const cards = boardCards(this.ctx!.response), index = threadIndexFor(this.ctx!.response)
    const filed = (id: string): KanbanCard | undefined => id.includes('/') ? cards.find(card => card.id === id.slice(0, id.lastIndexOf('/'))) ?? filed(id.slice(0, id.lastIndexOf('/'))) : undefined
    const above = index.parentOf(head) ?? filed(head.id)
    const inherits = !!above && !this.channels.find(channel => channel.everyone.some(each => fiberOf(each) === fiberOf(above)))?.misc
    channelPicker(`${slug(head)} and its threads`, here.name, choices, spelling => {
      const to = spelling ?? (inherits ? MISC : null)
      void this.writeChannels([{ card: head, to, was: this.declared(head) }], `${slug(head)} moved to #${spelling === null ? MISC : spelling.trim().toLowerCase().replace(/ /g, '-')}.`)
    })
  }
  /** Archives a channel: every constitution that names it, closed ones too, names none; nothing is tempered. */
  private async archive(channel: Channel): Promise<void> {
    await this.writeChannels(channel.declarers.map(card => ({ card, to: null, was: this.declared(card) })),
      `#${channel.name} archived: its threads speak in #misc, or in a channel above them.`)
  }
  /**
   * Writes each card's channel through its owner (`/lifecycle` channel), all
   * shown here at once, with an undo for a few seconds that writes back what
   * each had. A refused write takes back what it would have changed and says so.
   */
  private async writeChannels(moves: ReadonlyArray<{ card: KanbanCard; to: string | null; was: string | null }>, said: string): Promise<void> {
    const ctx = this.ctx
    if (!ctx || !moves.length) return
    const run = async (to: (each: (typeof moves)[number]) => string | null, failed: string): Promise<void> => {
      const entries = moves.map(each => { const entry = { to: to(each), at: Date.now() }; this.moved.set(fiberOf(each.card), entry); return entry })
      this.draw()
      const done = await fewAtATime(moves, CLEAR_WRITES, async each => {
        const entry = entries[moves.indexOf(each)]
        try {
          await postDaemonJson(ctx.shuttleBase, '/api/v1/lifecycle', { action: 'channel', fiber: each.card.id, origin: each.card.originId, channel: entry.to }, 'Move failed')
          return true
        } catch {
          // A later write of the same card stands.
          if (this.moved.get(fiberOf(each.card)) === entry) this.moved.delete(fiberOf(each.card))
          return false
        }
      })
      this.draw()
      ctx.requestRefresh()
      if (!done.every(Boolean)) this.status(failed)
    }
    const doing = run(each => each.to, `Some channels could not be written; those stay as they were.`)
    showToast(said, 'success', CLEAR_UNDO_MS, () => { void doing.then(() => run(each => each.was, `Some channels could not be written back.`)) })
    await doing
  }
  /** Every channel's key in the human's order. */
  private arrangement(): string[] { return arranged(this.channels.filter(channel => !channel.misc), this.order).map(channel => channel.key) }
  /** A move landed in the rail: the channels it shows that do not wait take the order they were dropped in. */
  private reorder(keys: string[]): void {
    const waiting = new Set(this.channels.filter(channel => channel.waiting || channel.misc).map(channel => channel.key))
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
      await postDaemonJson(ctx.shuttleBase, '/api/v1/channels/pin', { key: channel.key, ...channel.seat ? { fiber: fiberOf(channel.seat) } : {} }, 'Pin failed')
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
  private overDrawer(): boolean { return this.drawn && (this.drawer || this.motion.active) }
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
    if (!this.motion.active) this.motion.p = shown ? 1 : 0
    this.layout?.toggleAttribute('data-rail-hidden', !shown)
    if (!this.railToggle) return
    this.railToggle.name(shown ? 'Hide channels' : 'Show channels')
    this.railToggle.button.setAttribute('aria-expanded', String(shown))
  }
  /** Carries the rail in or away, from wherever it stands. */
  private moveRail(hidden: boolean): void {
    if (!this.motion.active && this.railShown() === !hidden) return
    this.motion.go(!hidden)
  }
  /** Whether the rail could be put away: a channel stands behind it, or on a phone, the one last read. */
  private canLeaveRail(): boolean {
    return !!this.channel || (isMobileViewport() && this.channels.some(channel => channel.key === stored(LAST)))
  }
  /** The rail is laid out to move over the stream, or with it; a phone's rail leaving bares the channel last read. */
  private beginMotion(): number {
    const layout = this.layout!
    layout.setAttribute('data-rail-moving', '')
    if (isMobileViewport() && this.phoneRail && !this.current) {
      const last = stored(LAST)
      if (last && this.channels.some(channel => channel.key === last)) {
        this.peeked = { key: last, seen: stored(SEEN + last) }
        this.open(last, false); this.drawChannel()
      }
    }
    this.motionWidth = layout.querySelector('.kbn-ch-rail')?.getBoundingClientRect().width ?? 0
    return this.motionWidth
  }
  /** Draws the rail `p` of the way in: over the stream where it is a drawer or a phone's screen, else pushing the stream aside. */
  private renderMotion(p: number): void {
    const layout = this.layout, width = this.motionWidth
    if (!layout) return
    const over = isMobileViewport() || this.drawn
    layout.style.setProperty('--kbn-ch-rail-x', `${(p - 1) * (width + (over ? SHADOW_PX : 0))}px`)
    layout.style.setProperty('--kbn-ch-stream-x', `${over ? 0 : (p - (this.railShown() ? 1 : 0)) * width}px`)
  }
  /**
   * Sideways gestures anywhere in Channels, the reader over it included: on
   * the stream the rail follows a finger or a two-finger trackpad swipe,
   * rightward in, leftward away, and settles by where it stands and how fast
   * it went when let go. Over the reader a rightward swipe leaves it, however
   * deep, for the channel's stream, and that is all it does: the next swipe
   * brings the rail. Content that scrolls sideways keeps its gesture; travel
   * along the stream is the stream's.
   */
  private gestures(root: HTMLElement): () => void {
    const reading = (): boolean => !!this.ctx?.workspace?.isActive
    const onSurface = (target: EventTarget | null): boolean => !reading() && !!(target as Element | null)?.closest?.('.kbn-ch, .kbn-ch-rail')
    // The reader recognises touches itself, in its frames too, and offers them here; a trackpad's are read here.
    const onReader = (target: EventTarget | null): boolean => reading() && !!(target as Element | null)?.closest?.('.ws-reader')
    const motion = this.motion, axis = new WheelAxis()
    // A gesture is taken only toward somewhere the rail can go, unless it is already moving.
    const toward = (px: number): boolean => !this.rail?.moving && (motion.active || (px > 0 ? !this.railShown() : this.railShown() && this.canLeaveRail()))
    let touch: { x: number; y: number; taken: boolean | null; on: EventTarget } | null = null
    // A touch is followed on the node it began on: a redraw that takes that node out of the page (the rail's entries, as a peek bares
    // a channel) would otherwise strand its moves and its lift, which no longer reach the page.
    const follow = (on: EventTarget, listen: boolean): void => {
      for (const [type, handle] of [['touchmove', move], ['touchend', up], ['touchcancel', up]] as const) {
        if (listen) on.addEventListener(type, handle as EventListener, { passive: true })
        else on.removeEventListener(type, handle as EventListener)
      }
    }
    const down = (event: TouchEvent): void => {
      // A second finger ends the drag where it stands.
      if (touch?.taken) motion.release()
      if (touch) follow(touch.on, false)
      const point = event.touches[0]
      touch = event.touches.length === 1 && point && event.target && onSurface(event.target) ? { x: point.clientX, y: point.clientY, taken: null, on: event.target } : null
      if (touch) follow(touch.on, true)
    }
    function move(event: TouchEvent): void {
      const point = event.touches[0]
      if (!touch || !point || touch.taken === false) return
      const dx = point.clientX - touch.x, dy = point.clientY - touch.y
      if (touch.taken === null) {
        if (Math.hypot(dx, dy) < 1.5 * SLOP_PX) return
        touch.taken = Math.abs(dx) > Math.abs(dy) && !scrollsSideways(event.target as Element, root, -dx) && toward(dx)
        if (!touch.taken) return
      }
      touch.x = point.clientX; touch.y = point.clientY
      motion.drag(dx, event.timeStamp)
    }
    function up(): void {
      if (touch?.taken) motion.release()
      if (touch) follow(touch.on, false)
      touch = null
    }
    // A trackpad swipe that left the reader is spent: the rest of it moves nothing (railMotion.ts).
    let idle = 0
    const spent = new SpentSwipe()
    const wheel = (event: WheelEvent): void => {
      const over = onReader(event.target)
      if (!over && !onSurface(event.target)) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientWidth : 1
      const dx = event.deltaX * unit, dy = event.deltaY * unit, sideways = Math.abs(dx) > Math.abs(dy)
      if (sideways && !axis.holding && scrollsSideways(event.target as Element, document.body, dx)) return
      const px = axis.feed(dx, dy, event.timeStamp)
      // Taking the gesture keeps the browser from going back a page.
      if (sideways || px !== null) event.preventDefault()
      if (px === null) return
      if (spent.feed(Math.abs(px), event.timeStamp)) return
      if (over) {
        if (px < 0) { this.ctx?.workspace?.returnToOrigin(); spent.begin(event.timeStamp) }
        return
      }
      if (!toward(-px)) return
      motion.drag(-px, event.timeStamp)
      clearTimeout(idle)
      // A trackpad says nothing when the fingers lift; the rail lets go once its events pause.
      idle = window.setTimeout(() => motion.release(), WHEEL_IDLE_MS)
    }
    // A touch the reader recognised, moving rightward, leaves it for the channel's stream; the rest of that finger moves nothing.
    const readerSwipe = (signal: SwipeSignal): boolean => {
      if (signal.phase !== 'move' || signal.dx <= 0 || this.rail?.moving) return false
      this.ctx?.workspace?.returnToOrigin()
      return true
    }
    if (this.ctx?.workspace) this.ctx.workspace.swipeBeneath = readerSwipe
    // A framed page's wheel, which the browser would take as back, comes to the wheel handler here as the reader's.
    takeSidewaysWheel(true)
    // Touch events, not pointer events: the browser cancels a pointer it starts panning, but a touch still ends.
    root.addEventListener('touchstart', down, { passive: true })
    document.addEventListener('wheel', wheel, { passive: false })
    return () => {
      clearTimeout(idle)
      motion.rest(this.railShown())
      root.removeEventListener('touchstart', down)
      if (touch) follow(touch.on, false)
      document.removeEventListener('wheel', wheel)
      if (this.ctx?.workspace?.swipeBeneath === readerSwipe) this.ctx.workspace.swipeBeneath = null
      takeSidewaysWheel(false)
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
    if (keystrokeIsSpokenFor()) return false
    // Escape in a folded stream puts Find away, which draws the stream whole about the match in hand.
    if (event.key === 'Escape' && this.folding) { this.ctx?.workspace?.clearFind(); return true }
    // t opens the tapestry of the post in focus in the reader.
    const post = event.key === 't' ? active?.closest<HTMLElement>('.kbn-ch-item')?.querySelector<HTMLElement>('[data-item]')?.dataset.item : undefined
    if (post) { void this.openTapestry(post); return true }
    // c opens the conversation of the channel's chair, as c does in its view; misc has no chair to speak to.
    if (event.key === 'c' && this.channel?.seat) { this.ctx?.workspace?.dock.openConversation(this.channel.seat); return true }
    if (event.key === 'Escape' && this.overDrawer()) { this.moveRail(true); return true }
    if (event.key === 'j') { this.step(1); return true }
    if (event.key === 'k') { this.step(-1); return true }
    if (event.key === '[') { this.moveRail(this.railShown()); return true }
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
    this.folding = ''
    this.foundAt = null
    this.foundRows = []
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
    this.list = null; this.jump = null; this.stream = null; this.foundSay = null; this.railToggle = null
    this.dock?.reset(); this.dock = null
    this.drafted = null
    this.sigs = { rail: '', head: '', stream: '' }
  }
}

registerView(new ChannelsView())
