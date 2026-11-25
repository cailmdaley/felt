import { announce } from '@ui-sdk/core'
import { ATTENTION_ORDER, attentionOf, lastActive, type Waits } from '../attention.js'
import type { BoardRecord } from '../boardFeed.js'
import { fiberOf, lineIds, type Entry, type Item, type Station } from '../channels.js'
import { openActionMenu } from '../conversationMenu.js'
import { CARD_PX, foldPx, PageCard, PREVIEW_GAP, previewsHeight, Unfold, type UnfoldFile } from '../elements/filePreview.js'
import { groups, kindWord, post } from '../elements/post.js'
import { doing, threadRow } from '../elements/threadRow.js'
import { relative, retime } from '../elements/time.js'
import type { MapFile } from '../family/model.js'
import { random } from '../ink.js'
import type { KanbanCard } from '../KanbanTypes.js'
import { lineHue } from '../lineHue.js'
import { drawMargin, GUTTER, tautAlong, type MarginRow } from '../margin.js'
import { highlight, unhighlight } from '../search/highlight.js'
import { foldStream, matchedRows, needleOf } from '../search/match.js'
import { stateDot } from '../stateDot.js'
import { slug } from '../threadOutline.js'
import { layTube, rowHeight, runsOf, tautness, type Tube, type TubeLine } from '../tube.js'
import { turnOf } from '../turn.js'
import { docKey, type DocKey } from '../workspace/documents.js'
import { declaredTitle } from '../workspace/DocumentTitles.js'
import './ChannelsView.css'

const isTypingTarget = (el: HTMLElement | null): boolean =>
  !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)

/** About how tall a post stands without its files: its head and two lines of words. */
const POST_PX = 64
/** A constitution, as whether it has a tapestry is remembered. */
const tapestryKey = (card: KanbanCard): string => `${card.originId}:${fiberOf(card)}`
/** A channel opens on this many of its newest lines to the human, or back to the oldest it holds unread or waiting; Earlier shows as many again. */
const OPENS_ON = 8
/** A stream within this many pixels of its foot follows what arrives. */
const FOLLOW_PX = 24
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
/** Threads in the order a list of them reads: what waits on the human first, then what works, each by its latest activity. */
const ranked = (cards: KanbanCard[], waits: Waits): KanbanCard[] =>
  cards.sort((a, b) => ATTENTION_ORDER.indexOf(attentionOf(a, waits)) - ATTENTION_ORDER.indexOf(attentionOf(b, waits)) || lastActive(b) - lastActive(a))

/** A waiting line that is a worker's own open question (`shuttle.ask`), which its ✓ withdraws. */
export const withdraws = (item: Item): boolean => item.waiting && item.kind === 'ask' && item.card.status === 'active' && !!item.card.ask

/** Fills `container` with `children`, leaving in place a child it already holds; the item that had focus in it keeps it. */
export function rebuildChildren(container: HTMLElement, children: Node[]): void {
  const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-item]')
  const item = focused && container.contains(focused) ? focused.dataset.item : undefined
  const keep = new Set(children)
  for (const node of [...container.childNodes]) if (!keep.has(node)) node.remove()
  children.forEach((child, index) => { if (container.childNodes[index] !== child) container.insertBefore(child, container.childNodes[index] ?? null) })
  if (item && !container.contains(document.activeElement)) container.querySelector<HTMLElement>(`[data-item="${CSS.escape(item)}"]`)?.focus({ preventScroll: true })
}

export interface ChannelStreamHost {
  shuttleBase: string
  /** Whether previews and embeds should stay awake. */
  awake(): boolean
  /** Open a constitution's view (e.g. reader in ChannelsView, `go` or navigation in ThreadPage). */
  openCard(card: KanbanCard, from: string | null): void
  /** Open a file or tapestry. */
  openFile(from: string, card: KanbanCard, key: DocKey): void
  /** Look up a constitution's lead file (tapestry). */
  lead(card: KanbanCard): Promise<MapFile | undefined | null>
  /** Return the last thing a card said, for the running-threads menu. */
  said?(card: KanbanCard): { text: string; at: number } | undefined
  /** Clear a line from the stream (✓ button); omit to hide clear controls. */
  clearLine?(item: Item, done: HTMLButtonElement): void
  /** Expand file and tapestry previews in place instead of opening them elsewhere. */
  inPlace?: boolean
  /** Called when an async lookup (e.g. tapestry check) changes what should draw. */
  onRedraw(): void
  /** Optional status announcer for Find match counts. */
  onFoundSay?(words: string): void
}

export interface ChannelStreamInput {
  /** Scope key (channel key or family uid). */
  key: string
  /** Display name for empty/folded messages (e.g. `#cmbx` or a family slug). */
  label: string
  /** All entries in this stream, oldest first (`composeStream`). */
  whole: Entry[]
  /** Every card in this scope, for resolving current state in menus. */
  everyone: readonly KanbanCard[]
  /** Live workers running now in this scope. */
  running: KanbanCard[]
  /** Current waits map (`BoardFeed.waiting`). */
  waits: Waits
  /** Board records for computing run tension (`runsOf`). */
  records: readonly BoardRecord[]
  /** Launch timestamps for a card (`marks(card)?.launches ?? []`). */
  launches: (card: KanbanCard) => readonly number[]
  /** Parent lookup for tube branching. */
  parentOf: (card: KanbanCard) => KanbanCard | undefined
  /** Whether the history read failed. */
  failed?: boolean
  now?: number
}

/**
 * Reusable stream renderer: draws posts, asks, closes, sent files, stations,
 * and the fine-ink margin (`layTube`, `drawMargin`) inside `<ol class="kbn-ch-stream">`.
 * Used by both `ChannelsView` (with its rail and Find) and `ThreadPage` (family Posts mode).
 */
export class ChannelStream {
  readonly el: HTMLOListElement
  private readonly host: ChannelStreamHost
  /** Each item's files as previews, by item, kept across redraws. */
  private readonly unfolds = new Map<string, Unfold>()
  /** Each fiber's newest close's tapestry, by item, kept across redraws. */
  private readonly pageCards = new Map<string, PageCard>()
  /** Resolved lead tapestry files for in-place unfolding, by item id. */
  private readonly leadFiles = new Map<string, UnfoldFile>()
  /** Whether a constitution has a tapestry, as its last look said. */
  private readonly tapestries = new Map<string, boolean>()
  /** The stream's rows as last drawn, by entry. */
  private readonly rows = new Map<string, { sig: string; node: HTMLLIElement }>()
  /** The entries the stream last drew, row by row. */
  private entriesDrawn: Entry[] = []
  private readonly titles = new Map<string, string>()
  /** The stream's layout as last drawn, which the margin is painted from whenever a row's height moves. */
  private tube: { tube: Tube; grouped: boolean[]; margin: number; taut: (line: TubeLine, s: number) => number; painted?: string } | null = null
  private rowSizes: ResizeObserver | null = null
  private painting = 0
  private band: readonly [number, number] = [0, 0]
  private named: { of: Element; label: HTMLElement } | null = null
  private running: KanbanCard[] = []
  private lastInput: ChannelStreamInput | null = null
  sig = ''
  /** When the scope was come to, and what this device had read of it then. */
  opened = { at: 0, seen: -Infinity }
  /** Where the stream's window starts once known: only moves back while open. */
  from = Infinity
  /** The stream follows what arrives while the reader is at its foot. */
  following = true
  private lastTop = 0
  /** What Find folds the stream to; '' draws it whole. */
  folding = ''
  private foundAt: string | null = null
  foundRows: string[] = []
  /** The worker Rex last brought this scope to, whose latest line is marked. */
  marked: string | null = null
  /** The line Find brought the scope to, marked, by entry. */
  markedItem: string | null = null
  /** The marked line is still to be brought into sight. */
  bring = false

  constructor(host: ChannelStreamHost) {
    this.host = host
    this.el = el('ol', 'kbn-ch-stream')
    this.el.addEventListener('scroll', () => {
      // Only the reader's own scroll says whether the stream follows.
      if (Math.abs(this.el.scrollTop - this.lastTop) > 1) {
        this.lastTop = this.el.scrollTop
        this.following = this.atFoot()
      }
      if (!this.painting && this.leavingBand()) this.painting = requestAnimationFrame(() => { this.painting = 0; this.paint() })
    }, { passive: true })
  }

  /** Resets windowing, scroll-follow, mark and fold state when switching scope. */
  reset(seen = -Infinity): void {
    this.opened = { at: Date.now(), seen }
    this.from = Infinity
    this.following = true
    this.marked = null
    this.markedItem = null
    this.bring = false
    this.folding = ''
    this.foundAt = null
    this.foundRows = []
    this.sig = ''
  }

  /** Clears the rendered DOM and previews (e.g. when no channel is selected). */
  clear(): void {
    this.sig = ''
    this.lastInput = null
    this.el.replaceChildren()
    this.sweep(new Set())
    this.rows.clear()
  }

  /** Renders `input` into the stream, diffing rows and painting the margin ink. */
  render(input: ChannelStreamInput): void {
    this.lastInput = input
    const now = input.now ?? Date.now()
    const { whole, waits, failed = false } = input
    const folded = this.folding ? foldStream(whole, this.folding) : null
    const { entries, hidden } = folded ? { entries: folded.entries, hidden: 0 } : this.window(whole)
    const running = ranked([...input.running], waits)
    const grouped = entries.map((entry, row) => { const before = entries[row - 1]; return entry.kind !== 'station' && before?.kind !== 'station' && groups(before, entry) })
    const newest = new Map<string, Item>()
    for (const entry of whole) if (entry.kind === 'close') newest.set(fiberOf(entry.card), entry)
    const last = whole.filter(entry => entry.kind === 'close').at(-1)
    const leading = new Map<Entry, 'page' | 'card'>([...newest.values()].filter(close => this.tapestries.get(tapestryKey(close.card)) !== false).map(close => [close, close === last ? 'page' : 'card']))
    const said = entries.map((entry, row) => [entry.id, entry.kind, entry.at, entry.card.name, slug(entry.card), entry.card.shuttleRole, entry.line, entry.kind === 'station' ? [entry.what, entry.end] : [entry.text, entry.waiting, entry.clears, kindWord(entry), grouped[row], leading.get(entry), entry.files.map(file => [file.host, file.fullPath, file.timestamp]), lineIds(entry)]])
    const margin = this.el.clientWidth && this.el.clientWidth < MARGIN.below ? MARGIN.narrow : MARGIN.wide
    const fold = foldPx()
    const runs = this.runs(input, now)
    const ran = [...new Set(entries.map(entry => entry.card))].map(card => runs(card).map(([from, to]) => [from, to === now ? 'now' : to]))
    const sig = JSON.stringify([input.key, this.folding, failed, hidden, said, entries.map(entry => [attentionOf(entry.card, waits), turnOf(entry.card).turn]), fold, margin, ran, running.map(card => [fiberOf(card), attentionOf(card, waits)])])
    if (sig !== this.sig) {
      this.sig = sig
      const heights = entries.map(entry => {
        if (entry.kind === 'station') return rowHeight(entry)
        const lead = leading.get(entry)
        return POST_PX + (lead ? (lead === 'page' ? fold : CARD_PX) + (entry.files.length ? PREVIEW_GAP : 0) : 0) + previewsHeight(entry.files.map(file => file.fullPath), fold)
      })
      const tube = layTube(entries, heights, { parentOf: input.parentOf, grouped, active: line => attentionOf(line.card, waits) === 'working' })
      this.tube = { tube, grouped, margin, taut: tautAlong(tube, entries.map(entry => entry.at), line => runs(line.card), tautness) }
      this.el.style.setProperty('--kbn-ch-tube', `${margin}px`)
      this.el.style.setProperty('--kbn-ch-gutter', `${GUTTER}px`)
      this.running = running
      const count = el('li', 'kbn-ch-count'), label = button('kbn-ch-count-label', '', () => this.bundleMenu())
      label.hidden = !this.running.length
      label.title = this.runningTitle()
      label.setAttribute('aria-label', label.title)
      label.setAttribute('aria-haspopup', 'menu')
      label.append(el('span', 'kbn-ch-count-n', String(this.running.length)))
      count.append(label)
      const ink = el('li', 'kbn-ch-margin')
      ink.setAttribute('aria-hidden', 'true')
      ink.addEventListener('click', event => this.marginClick(event))
      this.entriesDrawn = entries
      this.titles.clear()
      const kept = new Set<string>()
      const drawn = entries.map((entry, row) => {
        const rowSig = JSON.stringify(said[row]), was = this.rows.get(entry.id)
        const node = was?.sig === rowSig ? was.node : entry.kind === 'station' ? this.stationRow(entry, now, waits) : this.itemRow(entry, now, waits, grouped[row], leading.get(entry))
        this.rows.set(entry.id, { sig: rowSig, node })
        kept.add(entry.id)
        if (was?.node === node && entry.kind !== 'station') node.querySelector(':scope > .constitution-state-dot')?.replaceWith(this.dot(entry, waits))
        node.dataset.row = String(row)
        const line = entry.line ? tube.lines.find(each => each.id === entry.line) : undefined
        node.dataset.state = line ? this.lineState(line, waits) : ''
        if (line) node.dataset.hue = hue(line.card)
        return node
      })
      const gap = (rows: number): HTMLLIElement[] => rows ? [el('li', 'kbn-ch-folded', `· · · ${rows} ${rows === 1 ? 'row' : 'rows'} folded · · ·`)] : []
      rebuildChildren(this.el, [count, ink, ...hidden ? [this.earlierRow(hidden)] : [], ...folded ? [...drawn.flatMap((node, row) => [...gap(folded.gaps[row]), node]), ...gap(folded.gaps.at(-1)!)] : drawn])
      for (const id of this.rows.keys()) if (!kept.has(id)) this.rows.delete(id)
      for (const close of newest.values()) {
        const itemId = `item:${close.id}`
        const found = this.host.lead(close.card).then(file => {
          if (file === null) return file
          const key = tapestryKey(close.card), had = this.tapestries.get(key) !== false
          this.tapestries.set(key, !!file)
          let changed = had !== !!file
          if (this.host.inPlace) {
            const prev = this.leadFiles.get(itemId)
            if (file) {
              if (!prev || prev.key !== file.key) {
                this.leadFiles.set(itemId, { key: file.key, name: file.name, at: file.at })
                changed = true
              }
            } else if (prev) {
              this.leadFiles.delete(itemId)
              changed = true
            }
          }
          if (changed) this.host.onRedraw()
          return file
        })
        this.pageCards.get(itemId)?.look(found)
      }
      this.sweep(new Set(whole.flatMap(entry => entry.kind === 'station' ? [] : [`item:${entry.id}`])), new Set([...newest.values()].map(close => tapestryKey(close.card))))
      if (!entries.length) this.el.append(el('li', 'kbn-ch-hush', folded ? `Nothing in ${input.label} says “${this.folding}”.` : failed ? 'This channel\'s history could not be read; trying again.' : 'Nothing addressed to you here yet.'))
      if (this.following && !folded) this.toFoot()
      this.mark()
      this.markFound(folded)
      this.watchRows()
      this.paint()
    }
    retime(this.el, now)
  }

  /** Folds the stream to what `query` finds; '' draws it whole. */
  fold(query: string): void {
    const folding = query.trim()
    if (folding === this.folding) return
    if (!folding) { this.unfold(); return }
    if (!this.folding) this.following = false
    this.folding = folding
    this.foundAt = null
    if (this.lastInput) this.render(this.lastInput)
  }

  /** Draws the stream whole again, keeping the match in hand in sight. */
  unfold(): void {
    if (!this.folding) return
    const at = this.foundAt
    this.folding = ''
    this.foundRows = []
    if (this.lastInput) this.render(this.lastInput)
    this.foundAt = null
    const row = at ? this.rows.get(at)?.node : undefined
    if (row) {
      row.scrollIntoView({ block: row.offsetHeight > this.el.clientHeight ? 'start' : 'center' })
      this.lastTop = this.el.scrollTop
      this.following = this.atFoot()
    } else this.following = true
    if (this.following) this.toFoot()
  }

  /** ↑ / ↓ in Find: the previous or next match comes into sight. */
  stepFound(by: 1 | -1): void {
    const at = this.foundRows.indexOf(this.foundAt ?? '')
    const next = this.foundRows[Math.max(0, Math.min(this.foundRows.length - 1, at < 0 ? this.foundRows.length - 1 : at + by))]
    if (next) this.showFound(next)
  }

  /** Enter in Find: the match in hand takes focus, the stream still folded. */
  keepFound(fallback?: HTMLElement | null): void {
    const row = this.foundAt ? this.rows.get(this.foundAt)?.node : undefined
    const target = row?.querySelector<HTMLElement>('[data-item]') ?? fallback ?? null
    target?.focus({ preventScroll: true })
  }

  /** Marks the latest line of the worker Rex followed to, or the line Find picked. */
  mark(): void {
    for (const row of this.el.querySelectorAll('[data-marked]')) row.removeAttribute('data-marked')
    const own = this.marked ? [...this.el.querySelectorAll<HTMLElement>(`:scope > [data-fiber="${CSS.escape(this.marked)}"]`)] : []
    const picked = this.markedItem ? this.rows.get(this.markedItem)?.node : undefined
    const row = picked?.isConnected ? picked : own.filter(each => each.matches('.kbn-ch-item')).at(-1) ?? own.at(-1)
    if (!row) return
    row.setAttribute('data-marked', '')
    if (!this.bring) return
    this.bring = false
    if (isTypingTarget(document.activeElement as HTMLElement | null)) return
    row.scrollIntoView({ block: row.offsetHeight > this.el.clientHeight ? 'start' : 'center' })
    this.lastTop = this.el.scrollTop
    this.following = row === this.el.lastElementChild && this.atFoot()
    row.querySelector<HTMLElement>('[data-item]')?.focus({ preventScroll: true })
  }

  /** Opens the tapestry of the post with item id `id`. */
  async openTapestry(id: string): Promise<void> {
    const item = this.entriesDrawn.find((entry): entry is Item => entry.kind !== 'station' && `item:${entry.id}` === id)
    const lead = item && await this.host.lead(item.card)
    if (!item || !this.entriesDrawn.includes(item)) return
    if (!lead) { announce(`${slug(item.card)} has no tapestry`); return }
    this.host.openFile(id, item.card, lead.key)
  }

  toFoot(): void {
    this.el.scrollTop = this.el.scrollHeight
    this.lastTop = this.el.scrollTop
  }

  /** Its host is hidden: the files unfolded in it stop running. */
  suspend(): void { for (const unfold of this.unfolds.values()) unfold.suspend() }
  resume(): void { for (const unfold of this.unfolds.values()) unfold.resume() }

  dispose(): void {
    this.sweep(new Set())
    this.rows.clear()
    this.rowSizes?.disconnect(); this.rowSizes = null
    cancelAnimationFrame(this.painting); this.painting = 0
    this.tube = null
    this.lastInput = null
    this.sig = ''
    this.folding = ''
    this.foundAt = null
    this.foundRows = []
  }

  private markFound(folded: ReturnType<typeof foldStream> | null): void {
    unhighlight(this.el)
    for (const row of this.el.querySelectorAll('[data-found]')) row.removeAttribute('data-found')
    this.foundRows = folded ? matchedRows(folded).map(entry => entry.id) : []
    if (!folded) { this.sayFound(); return }
    const needle = needleOf(this.folding)
    for (const id of this.foundRows) for (const part of this.rows.get(id)?.node.querySelectorAll('.kbn-ch-item-text, .uf-file-name, .uf-caption, .kbn-ch-slug') ?? []) highlight(part, needle)
    const at = this.foundAt && this.foundRows.includes(this.foundAt) ? this.foundAt : this.foundRows.at(-1)
    if (at) this.showFound(at, at !== this.foundAt)
    else this.sayFound()
  }

  private sayFound(): void {
    const count = this.foundRows.length, at = this.foundAt ? this.foundRows.indexOf(this.foundAt) : -1
    const words = !this.folding ? '' : !count ? 'No matches' : `Match ${at + 1} of ${count}`
    this.host.onFoundSay?.(words)
  }

  private showFound(id: string, bring = true): void {
    this.foundAt = id
    this.sayFound()
    for (const row of this.el.querySelectorAll('[data-found]')) row.removeAttribute('data-found')
    const row = this.rows.get(id)?.node
    if (!row) return
    row.setAttribute('data-found', '')
    if (!bring) return
    row.scrollIntoView({ block: row.offsetHeight > this.el.clientHeight ? 'start' : 'center' })
    this.lastTop = this.el.scrollTop
  }

  private window(all: Entry[]): { entries: Entry[]; hidden: number } {
    const items = all.filter((entry): entry is Item => entry.kind !== 'station')
    const before = items.filter(item => item.arrived <= this.opened.at)
    let start = before.length > OPENS_ON ? before[before.length - OPENS_ON].at : -Infinity
    const held = items.find(item => item.waiting || item.arrived > this.opened.seen)
    const own = this.marked ? all.filter(entry => fiberOf(entry.card) === this.marked) : []
    const marked = own.filter(entry => entry.kind !== 'station').at(-1) ?? own.at(-1)
    const found = all.filter(entry => entry.id === this.markedItem || entry.id === this.foundAt)
    for (const entry of [held, marked, ...found]) if (entry) start = Math.min(start, entry.at)
    const from = Math.min(this.from, start)
    if (Number.isFinite(start)) this.from = from
    return { entries: all.filter(entry => entry.at >= from), hidden: items.filter(item => item.at < from).length }
  }

  private earlierRow(hidden: number): HTMLLIElement {
    const row = el('li', 'kbn-ch-earlier')
    const more = button('kbn-ch-earlier-more', `Earlier · ${hidden} more`, () => {
      const height = this.el.scrollHeight
      const items = this.lastInput ? this.lastInput.whole.filter(entry => entry.kind !== 'station' && entry.at < this.from) : []
      this.from = items.at(-OPENS_ON)?.at ?? -Infinity
      if (this.lastInput) this.render(this.lastInput)
      this.el.scrollTop += this.el.scrollHeight - height
      this.lastTop = this.el.scrollTop
    })
    more.dataset.item = 'earlier'
    more.title = `${hidden} earlier ${hidden === 1 ? 'line' : 'lines'} to you in this channel`
    row.append(more)
    return row
  }

  private lineState(line: TubeLine, waits: Waits): string {
    return line.to === Infinity ? attentionOf(line.card, waits) : 'ended'
  }

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

  private watchRows(): void {
    this.rowSizes ??= new ResizeObserver(() => {
      if (this.following) this.toFoot()
      if (this.painting) return
      this.painting = requestAnimationFrame(() => { this.painting = 0; this.paint() })
    })
    this.rowSizes.disconnect()
    this.rowSizes.observe(this.el)
    for (const row of this.el.children) this.rowSizes.observe(row)
  }

  private atFoot(): boolean {
    return this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight <= FOLLOW_PX
  }

  private paint(): void {
    const laid = this.tube, holder = this.el.querySelector(':scope > .kbn-ch-margin')
    if (!laid || !holder) return
    const began = performance.now()
    const nodes = this.entriesDrawn.map(entry => this.rows.get(entry.id)?.node)
    if (nodes.some(node => !node)) return
    const rows: MarginRow[] = this.entriesDrawn.map((entry, row) => ({ entry, grouped: laid.grouped[row], top: nodes[row]!.offsetTop, height: nodes[row]!.offsetHeight }))
    const heavier = Number(getComputedStyle(this.el).getPropertyValue('--kbn-ink-weight')) || 1
    const top = this.el.scrollTop, screen = this.el.clientHeight || 900, band = [top - screen, top + 2 * screen] as const
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
    performance.measure('kbn-ch-margin', { start: began })
  }

  private leavingBand(top = this.el.scrollTop): boolean {
    const screen = this.el.clientHeight, [from, to] = this.band
    return (from > 0 && top < from + screen / 2) || (to < this.el.scrollHeight - 8 && top + screen > to - screen / 2)
  }

  private marginClick(event: MouseEvent): void {
    const target = event.target as Element
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
    if (line) { event.stopPropagation(); this.host.openCard(line.card, null) }
  }

  private name(of: Element, title: string, event: MouseEvent): void {
    this.named?.label.remove()
    const label = el('span', 'kbn-ch-named', title), box = this.el.getBoundingClientRect()
    label.style.left = `${event.clientX - box.left + 10}px`
    label.style.top = `${event.clientY - box.top + this.el.scrollTop - 26}px`
    this.el.querySelector(':scope > .kbn-ch-margin')?.append(label)
    this.named = { of, label }
  }

  private runs(input: ChannelStreamInput, now: number): (card: KanbanCard) => Array<[number, number]> {
    const memo = new Map<KanbanCard, Array<[number, number]>>()
    return card => memo.get(card) ?? memo.set(card, runsOf(
      input.launches(card),
      input.records.filter(record => STOPS.has(record.kind) && (record.fiber === card.uid || record.fiber === card.id)).map(record => record.timestamp),
      { now, working: attentionOf(card, input.waits) === 'working', last: lastActive(card) },
    )).get(card)!
  }

  private runningTitle(): string {
    return `${this.running.length} running: ${this.running.map(card => slug(card)).join(', ')}`
  }

  private bundleMenu(point?: { x: number; y: number }, gathered?: KanbanCard[]): void {
    const anchor = this.el.querySelector<HTMLElement>(':scope > .kbn-ch-count > .kbn-ch-count-label')
    const input = this.lastInput, cards = gathered ?? this.running
    if (!cards.length || !anchor || !input) return
    const now = Date.now(), waits = input.waits, current = new Map(input.everyone.map(card => [fiberOf(card), card]))
    openActionMenu(anchor, ranked(cards.map(card => current.get(fiberOf(card)) ?? card), waits).map(card => ({
      label: `${slug(card)}: ${doing(card, waits, this.host.said?.(card)).text}`,
      content: threadRow(card, { waits, now, said: this.host.said?.(card), hue: hue(card) }),
      run: () => this.host.openCard(card, null),
    })), gathered ? `${cards.length} gathered here` : `${cards.length} running`, point)
  }

  private stationRow(station: Station, now: number, waits: Waits): HTMLLIElement {
    const row = el('li', `kbn-ch-station kbn-ch-st-${station.what}`)
    row.dataset.line = station.line
    row.dataset.fiber = fiberOf(station.card)
    row.dataset.slug = slug(station.card)
    row.dataset.what = station.what === 'end' ? `end:${station.end ?? 'closed'}` : station.what
    if (station.what === 'start') {
      const who = button('kbn-ch-slug', '', () => this.host.openCard(station.card, `station:${station.id}`))
      who.append(threadRow(station.card, { waits, now, density: 'chip', hue: hue(station.card) }))
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

  private itemRow(item: Item, now: number, waits: Waits, grouped: boolean, lead?: 'page' | 'card'): HTMLLIElement {
    const id = `item:${item.id}`
    const open = (): void => this.host.openCard(item.card, id)
    return post(item, {
      now, dot: this.dot(item, waits), open, grouped, clear: this.check(item),
      previews: lead || item.files.length ? this.previews(item, id, lead) : undefined,
    })
  }

  private dot(item: Item, waits: Waits): HTMLButtonElement {
    const dot = stateDot(item.card, waits, () => this.host.openCard(item.card, `item:${item.id}`))
    const shape = random(`drop:${item.id}`)
    dot.style.setProperty('--drop-w', `${(6.6 + shape() * 1.4).toFixed(2)}px`)
    dot.style.setProperty('--drop-h', `${(5.4 + shape() * 1.2).toFixed(2)}px`)
    dot.style.setProperty('--drop-turn', `${Math.round((shape() - 0.5) * 50)}deg`)
    dot.title = `${item.card.name} — ${dot.title}`
    return dot
  }

  private check(item: Item): HTMLButtonElement | undefined {
    const clearLine = this.host.clearLine
    if (!clearLine) return undefined
    if (item.waiting ? !item.clears && !withdraws(item) : item.kind !== 'post' && item.kind !== 'file' && item.kind !== 'ask') return undefined
    const { card } = item
    const done = button('kbn-ch-clear', '✓', () => {
      done.disabled = true
      clearLine(item, done)
    })
    done.title = item.clears || withdraws(item) ? 'Clear: read, nothing to answer; take it from the stream' : 'Clear: read, take it from the stream'
    done.setAttribute('aria-label', `Clear ${card.name}'s ${item.kind === 'file' ? 'files' : item.kind === 'ask' ? 'question' : 'post'}`)
    return done
  }

  private previews(item: Item, id: string, lead?: 'page' | 'card'): HTMLElement {
    const { card } = item
    const shown = { shuttleBase: this.host.shuttleBase, awake: () => this.host.awake() && this.el.isConnected }
    const unfoldOpts = this.host.inPlace
      ? { ...shown, full: (key: DocKey) => this.host.openFile(id, card, key), openFigure: (key: DocKey) => this.host.openFile(id, card, key) }
      : { ...shown, open: (key: DocKey) => this.host.openFile(id, card, key) }
    const unfold = this.unfolds.get(id) ?? this.unfolds.set(id, new Unfold(unfoldOpts)).get(id)!
    const files: UnfoldFile[] = item.files.map((file): UnfoldFile => {
      const key = docKey(file.host ?? card.originId, file.fullPath, card.originId, card.fiberDir)
      return { key, name: declaredTitle(key)?.title ?? file.basename, at: file.timestamp, caption: file.caption }
    })
    const previews = el('div', 'kbn-ch-previews')
    if (lead && this.host.inPlace) {
      const leadFile = this.leadFiles.get(id)
      if (leadFile && !files.some(each => each.key === leadFile.key)) files.unshift(leadFile)
    } else if (lead) {
      let page = this.pageCards.get(id)
      if (page?.previews !== (lead === 'page')) {
        page?.dispose()
        page = new PageCard(() => void this.openTapestry(id), lead === 'page' ? shown : undefined)
        this.pageCards.set(id, page)
      }
      previews.append(page.el)
    }
    unfold.update(files)
    previews.append(unfold.el)
    return previews
  }

  private sweep(wanted: ReadonlySet<string>, fibers: ReadonlySet<string> = new Set()): void {
    for (const [id, unfold] of this.unfolds) if (!wanted.has(id)) { unfold.dispose(); this.unfolds.delete(id) }
    for (const [id, page] of this.pageCards) if (!wanted.has(id)) { page.dispose(); this.pageCards.delete(id) }
    for (const id of this.leadFiles.keys()) if (!wanted.has(id)) this.leadFiles.delete(id)
    for (const key of this.tapestries.keys()) if (!fibers.has(key)) this.tapestries.delete(key)
  }
}
