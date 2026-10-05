import type { KanbanCard } from '../KanbanTypes.js'
import { readFiber } from './fiberSource.js'
import { keyIntent, type KeyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import { normalizeShelfFiles, type ShelfFile } from '../views/shelfData.js'
import { LOAD_POLICY } from '../views/shelfLoad.js'
import { Thumbnail, pumpThumbnails } from './Thumbnail.js'
import { docKey, parseDocKey, documentKind, documentLabels, type DocKey } from './documents.js'
import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import './tokens.css'
import './overview.css'
import { ReceiptMotion } from './receiptMotion.js'

export interface OverviewOptions {
  shuttleBase: string
  cards(): KanbanCard[]
  onOpen(card: KanbanCard, doc?: DocKey): void
  /** Full lens order, independent of Find; suitable for reader channel stepping. */
  onOrder?(cards: KanbanCard[]): void
}
export type OverviewLens = 'recent' | 'projects' | 'hosts'
const WINDOW_MS = 30 * 86400000
const RECEIPT_OVERLAP_MS = 60000
const LENS_STORAGE = 'shuttle.workspace.overview.lens'
const VISIT_STORAGE = 'shuttle.workspace.overview.visits'
const SEEN_STORAGE = 'shuttle.workspace.overview.seen'
const DAY_GROUPS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const
const HOST_MARKS = ['○', '■', '▲', '◇', '◐', '□', '△', '◆']
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uidOf = (card: KanbanCard): string => card.uid ?? card.id

/** Merge incremental pages by send identity while bounding the in-memory window. */
export function mergeReceiptFiles(previous: readonly ShelfFile[], incoming: readonly ShelfFile[], since: number): ShelfFile[] {
  const merged = new Map<string, ShelfFile>()
  for (const file of [...previous, ...incoming]) {
    if (!Number.isFinite(file.timestamp) || file.timestamp <= 0 || file.timestamp < since) continue
    const identity = JSON.stringify([file.host ?? '', file.uid ?? '', file.fullPath, file.timestamp, file.sessionId ?? ''])
    merged.set(identity, file)
  }
  return [...merged.values()]
}

/** A composite's slowest temporal origin bounds how far the shared cursor can move. */
function receiptWatermark(origins: unknown, sampledAt: number, previous: number | undefined, since: number): number {
  const hold = previous ?? since
  if (!origins || typeof origins !== 'object' || Array.isArray(origins)) return hold
  const entries = Object.values(origins as Record<string, unknown>)
  if (!entries.length) return hold
  let through = sampledAt
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return hold
    const origin = raw as Record<string, unknown>
    if (origin.kind === 'local') continue
    if (origin.kind !== 'remote' || typeof origin.last_polled_at !== 'string') return hold
    const polledAt = Date.parse(origin.last_polled_at)
    if (!Number.isFinite(polledAt)) return hold
    through = Math.min(through, polledAt)
  }
  return through
}

/** Calendar-day arithmetic in the viewer's zone, including 23/25-hour DST days. */
export function overviewDayGroup(timestamp: number, now: number): string {
  const ordinal = (ms: number): number => {
    const d = new Date(ms)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000
  }
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 'Earlier'
  const days = ordinal(now) - ordinal(timestamp)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days < 7 ? 'This week' : 'Earlier'
}

/** Fleet order assigns shapes; no machine names are built into the UI. */
export function overviewHostMarks(hosts: Iterable<string>): Map<string, string> {
  return new Map([...new Set(hosts)].filter(Boolean).sort(compare).map((host, i) => [host, HOST_MARKS[i % HOST_MARKS.length]]))
}

function projectOf(card: KanbanCard): string {
  let path = card.path
  if (card.feltStore && path.startsWith(`${card.feltStore}/`)) path = path.slice(card.feltStore.length + 1)
  path = path.replace(/^.*?\.felt\//, '').replace(/^\/+/, '')
  const parts = path.replace(/\.md$/, '').split('/').filter(Boolean)
  return parts.slice(0, parts.length > 2 ? 2 : 1).join(' / ') || 'Other'
}
function stored(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null') } catch { return null }
}
function persist(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Storage is optional. */ }
}
function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}
function text(el: HTMLElement, value: string): void { if (el.textContent !== value) el.textContent = value }
function button(className: string): HTMLButtonElement {
  const el = node('button', className)
  el.type = 'button'
  el.addEventListener('mousedown', e => { if (e.button === 0) e.preventDefault() })
  return el
}
/** Patch only changed positions: even re-appending an iframe's ancestor reloads it. */
function place(parent: HTMLElement, children: HTMLElement[]): void {
  let cursor = parent.firstElementChild
  for (const child of children) {
    if (child === cursor) cursor = cursor.nextElementSibling
    else parent.insertBefore(child, cursor)
  }
  const keep = new Set(children)
  for (const child of [...parent.children]) if (!keep.has(child as HTMLElement)) child.remove()
}
function age(timestamp: number): string {
  if (!timestamp) return 'Opened this session'
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
interface Receipt extends ShelfFile { key: DocKey; uid: string; owner: string }
interface Folio {
  uid: string
  card: KanbanCard
  receipts: Receipt[]
  latest: number
  recent: string
  project: string
  host: string
  /** Placed before board metadata named it; its first real card sets the groups. */
  provisional: boolean
  el: HTMLButtonElement
  stack: HTMLElement
  name: HTMLElement
  fresh: HTMLElement
  outcome: HTMLElement
  marks: HTMLElement
  count: HTMLElement
  when: HTMLElement
  thumb?: Thumbnail
}
interface RibbonItem {
  el: HTMLButtonElement
  receipt: Receipt
  label: HTMLElement
  name: HTMLElement
  when: HTMLElement
  host: HTMLElement
  thumb: Thumbnail
}
interface Group { el: HTMLElement; grid: HTMLElement; count: HTMLElement }

/** Persistent contact sheet; receipts are raw, owner-aware, and never path-deduped. */
export class Overview {
  readonly el = node('div', 'ws-overview')
  private readonly opts: OverviewOptions
  private readonly stopTitles: () => void
  private readonly receiptMotion = new ReceiptMotion()
  private readonly inner = node('div', 'ws-overview-inner')
  private readonly summary = node('div', 'ws-overview-summary ws-overview-meta')
  private readonly legend = node('div', 'ws-overview-legend ws-overview-meta')
  private readonly ribbon = node('div', 'ws-overview-ribbon')
  private readonly groupsEl = node('div', 'ws-overview-groups')
  private readonly status = node('p', 'ws-overview-status')
  private readonly find = node('input', 'ws-overview-find')
  private readonly lensGroup = node('div', 'ws-overview-lens')
  private readonly lensButtons = new Map<OverviewLens, HTMLButtonElement>()
  private readonly folios = new Map<string, Folio>()
  private readonly ribbonItems = new Map<DocKey, RibbonItem>()
  private readonly groups = new Map<string, Group>()
  private readonly thumbnails = new Map<string, Thumbnail>()
  private readonly visits = new Map<string, number>()
  private readonly openedCards = new Map<string, KanbanCard>()
  private readonly fetchedCards = new Map<string, KanbanCard>()
  private readonly cardLoads = new Map<string, Promise<KanbanCard | undefined>>()
  private readonly cardQueue: Array<{ uid: string; run(): Promise<void> }> = []
  private activeCardReads = 0
  private readonly cardRetries = new Map<string, { attempts: number; at: number }>()
  private readonly missingCards = new Set<string>()
  private readonly provisionalOpened = new Set<string>()
  private readonly externalLoads = new Set<string>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private navigation = 0
  private selection: HTMLButtonElement | null = null
  private readonly cardControllers = new Set<AbortController>()
  private readonly observer?: IntersectionObserver
  private readonly resizeObserver?: ResizeObserver
  private marks = new Map<string, string>()
  private files: ShelfFile[] = []
  private receiptCursor?: number
  private originHosts?: Set<string>
  private receiptBackfill = false
  private fleetHosts: string[] = []
  private lens: OverviewLens = 'recent'
  private order: KanbanCard[] = []
  private request?: AbortController
  private visible = true
  private disposed = false
  private scroll = 0
  /** When this sheet was last left; receipts before it are not news, even in fibers never opened. */
  private readonly seen: number
  private raf?: number

  constructor(opts: OverviewOptions) {
    this.opts = opts
    this.stopTitles = watchDocumentTitles(() => { if (!this.disposed) this.renderRibbon() })
    const lens = stored(LENS_STORAGE)
    if (lens === 'recent' || lens === 'projects' || lens === 'hosts') this.lens = lens
    const seen = stored(SEEN_STORAGE)
    this.seen = typeof seen === 'number' && Number.isFinite(seen) ? seen : Date.now()
    persist(SEEN_STORAGE, this.seen)
    const visits = stored(VISIT_STORAGE)
    if (visits && typeof visits === 'object' && !Array.isArray(visits)) {
      for (const [uid, at] of Object.entries(visits)) if (typeof at === 'number' && Number.isFinite(at)) this.visits.set(uid, at)
    }
    const header = node('header', 'ws-overview-masthead')
    const heading = node('div', 'ws-overview-heading')
    // The Desk's column heads open on an illuminated initial; so does the sheet.
    const title = node('h1', '')
    const cap = node('span', 'kbn-cap', 'D'); cap.dataset.letter = 'D'
    title.append(cap, 'ocuments')
    title.setAttribute('aria-label', 'Documents')
    heading.append(title, this.summary)
    this.legend.setAttribute('aria-label', 'Host legend')
    header.append(heading, this.legend)
    const receipts = node('section', 'ws-overview-receipts')
    receipts.setAttribute('aria-label', 'Latest receipts')
    const receiptHeading = node('h2', 'ws-overview-section-title', 'Latest receipts')
    receiptHeading.append(node('span', 'ws-overview-section-count', '12 newest across the fleet'))
    receipts.append(receiptHeading, this.ribbon)
    const controls = node('div', 'ws-overview-controls')
    this.lensGroup.setAttribute('role', 'radiogroup')
    this.lensGroup.setAttribute('aria-label', 'Group documents')
    for (const [value, label] of [['recent', 'Recent work'], ['projects', 'Projects'], ['hosts', 'Hosts']] as const) {
      const option = button('')
      option.textContent = label
      option.setAttribute('role', 'radio')
      option.dataset.lens = value
      option.addEventListener('click', () => this.setLens(value))
      this.lensButtons.set(value, option); this.lensGroup.append(option)
    }
    this.markLens()
    this.lensGroup.addEventListener('keydown', e => {
      const order = [...this.lensButtons.keys()]
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
      if (!step) return
      e.preventDefault(); e.stopPropagation()
      const next = order[(order.indexOf(this.lens) + step + order.length) % order.length]
      this.setLens(next); this.lensButtons.get(next)?.focus()
    })
    this.find.type = 'search'; this.find.placeholder = 'Find work or files…'
    this.find.setAttribute('aria-label', 'Find work or files')
    this.find.addEventListener('input', () => this.render())
    controls.append(this.lensGroup, this.find)
    this.status.setAttribute('role', 'status')
    this.inner.append(header, receipts, controls, this.groupsEl, this.status)
    this.el.append(this.inner)
    this.el.setAttribute('aria-label', 'Document overview')
    this.el.addEventListener('scroll', this.schedule, { passive: true })
    this.ribbon.addEventListener('scroll', this.schedule, { passive: true })
    if (typeof IntersectionObserver !== 'undefined') {
      this.observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const thumb = [...this.thumbnails.values()].find(t => t.el === entry.target)
          if (!thumb) continue
          thumb.near = entry.isIntersecting
          if (thumb.near) thumb.lastVisible = Date.now()
        }
        this.schedule()
      }, { root: this.el, rootMargin: LOAD_POLICY.ring })
    }
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => { this.scaleThumbnails(); this.schedule() })
      this.resizeObserver.observe(this.el)
    }
    window.addEventListener('resize', this.schedule)
    document.addEventListener('keydown', this.keydown)
    this.render()
  }

  /** Metadata paints immediately; one coalesced feed read finishes asynchronously. */
  refresh(): void {
    if (this.disposed) return
    if (!this.request) for (const retry of this.cardRetries.values()) retry.at = 0
    this.reconcile()
    if (this.request) return
    const controller = new AbortController()
    this.request = controller
    const sampledAt = Date.now()
    const windowStart = sampledAt - WINDOW_MS
    const backfill = this.receiptBackfill
    const since = backfill ? windowStart : Math.max(windowStart, this.receiptCursor === undefined ? windowStart : this.receiptCursor - RECEIPT_OVERLAP_MS)
    let discoveredOrigin = false
    const timeout = setTimeout(() => controller.abort(), 25000)
    void (async () => {
      try {
        const response = await fetch(`${this.opts.shuttleBase}/api/v1/sent-files/all/composite?since_ms=${Math.floor(since)}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Receipt feed unavailable')
        const raw: unknown = await response.json()
        if (this.disposed) return
        if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { files?: unknown }).files)) throw new Error('Invalid receipt feed')
        const incoming = normalizeShelfFiles(raw)
        this.files = mergeReceiptFiles(this.files, incoming, Date.now() - WINDOW_MS)
        const origins = (raw as { origins?: unknown }).origins
        if (origins && typeof origins === 'object' && !Array.isArray(origins)) {
          const hosts = Object.keys(origins)
          if (hosts.length) {
            const nextOrigins = new Set(hosts)
            const knownOrigins = this.originHosts
            const grew = knownOrigins !== undefined && hosts.some(host => !knownOrigins.has(host))
            this.fleetHosts = hosts
            this.originHosts = nextOrigins
            if (grew && !backfill) {
              this.receiptBackfill = true
              discoveredOrigin = true
            } else if (backfill) this.receiptBackfill = false
          }
        }
        this.receiptCursor = receiptWatermark(origins, sampledAt, this.receiptCursor, since)
        text(this.status, '')
        this.reconcile()
      } catch {
        if (!this.disposed) text(this.status, 'Receipt feed unavailable — showing the last loaded sheet.')
      } finally {
        clearTimeout(timeout)
        if (this.request === controller) this.request = undefined
        if (discoveredOrigin && !this.disposed) this.refresh()
      }
    })()
  }

  /** Board metadata arrived or changed; folios keep their places. */
  cardsChanged(): void { if (!this.disposed) this.reconcile() }

  opened(card: KanbanCard, authoritative = true): void {
    if (this.disposed) return
    const uid = uidOf(card)
    this.openedCards.set(uid, card)
    if (authoritative) this.provisionalOpened.delete(uid)
    else this.provisionalOpened.add(uid)
    this.visits.set(uid, Date.now())
    persist(VISIT_STORAGE, Object.fromEntries(this.visits))
    this.reconcile()
  }

  /** A body read supplies metadata without another visit or navigation. */
  resolved(card: KanbanCard): void {
    if (this.disposed) return
    const uid = uidOf(card)
    this.fetchedCards.set(uid, card)
    if (this.openedCards.has(uid)) this.openedCards.set(uid, card)
    this.provisionalOpened.delete(uid)
    this.missingCards.delete(uid)
    this.cardRetries.delete(uid)
    this.reconcile()
  }

  /** Workspace body reads already resolve this metadata; don't duplicate them. */
  resolving(uid: string, pending: boolean): void {
    if (pending) this.externalLoads.add(uid)
    else { this.externalLoads.delete(uid); if (!this.disposed) this.reconcile() }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return
    if (!visible) { this.navigation++; this.scroll = this.el.scrollTop; persist(SEEN_STORAGE, Date.now()) }
    this.visible = visible
    this.el.hidden = !visible
    this.el.inert = !visible
    if (visible) { this.el.scrollTop = this.scroll; this.schedule() }
    else {
      if (this.raf !== undefined) { cancelAnimationFrame(this.raf); this.raf = undefined }
      for (const thumb of this.thumbnails.values()) thumb.schedule()
    }
  }
  show(): void { this.setVisible(true) }
  hide(): void { this.setVisible(false) }
  setLens(lens: OverviewLens): void {
    if (lens === this.lens) return
    this.lens = lens
    persist(LENS_STORAGE, lens)
    this.markLens()
    this.render()
  }
  private markLens(): void {
    for (const [value, option] of this.lensButtons) {
      option.setAttribute('aria-checked', String(value === this.lens))
      option.tabIndex = value === this.lens ? 0 : -1
    }
  }
  /** Find never truncates keyboard channel order. */
  orderedCards(): KanbanCard[] { this.resolveFolios(); return [...this.order] }
  /** Notes and external entry points use Recent work, independent of the sheet's lens. */
  recentCards(): KanbanCard[] {
    return [...this.folios.values()].sort((a, b) =>
      DAY_GROUPS.indexOf(a.recent as typeof DAY_GROUPS[number]) - DAY_GROUPS.indexOf(b.recent as typeof DAY_GROUPS[number])
      || b.latest - a.latest || compare(a.uid, b.uid) || compare(a.card.originId, b.card.originId)).map(folio => folio.card)
  }
  /** Receipt metadata already held by the sheet; searching never reads fiber bodies. */
  fileNames(card: KanbanCard): string[] {
    return this.folios.get(uidOf(card))?.receipts.flatMap(r => [r.basename, r.fullPath]) ?? []
  }
  unfiledReceipts(uid: string): ShelfFile[] { return this.folios.get(uid)?.receipts ?? [] }
  hasMetadata(card: KanbanCard): boolean {
    const uid = uidOf(card)
    return uid.startsWith('other:') || this.knownCards().get(uid)?.originId === card.originId
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.navigation++
    this.stopTitles()
    this.receiptMotion.dispose()
    clearTimeout(this.retryTimer)
    this.request?.abort()
    for (const controller of this.cardControllers) controller.abort()
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    if (this.raf !== undefined) cancelAnimationFrame(this.raf)
    for (const thumb of this.thumbnails.values()) thumb.dispose()
    this.thumbnails.clear()
    window.removeEventListener('resize', this.schedule)
    document.removeEventListener('keydown', this.keydown)
    this.el.removeEventListener('scroll', this.schedule)
    this.ribbon.removeEventListener('scroll', this.schedule)
    this.el.remove()
  }

  private knownCards(): Map<string, KanbanCard> {
    const known = new Map(this.fetchedCards)
    for (const [uid, card] of this.openedCards) if (!this.provisionalOpened.has(uid)) known.set(uid, card)
    // The live board's chosen mirrored row owns fiber metadata, not the file's byte host.
    for (const card of this.opts.cards()) known.set(uidOf(card), card)
    return known
  }
  private fallback(uid: string, owner: string): KanbanCard {
    return { id: uid, uid, name: uid.startsWith('other:') ? `Unfiled · ${owner}` : `Resolving fiber · ${owner}`, path: '', originId: owner, status: '', createdAt: '',
      effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }
  }
  private reconcile(): void {
    const arrived: Folio[] = []
    const known = this.knownCards()
    for (const uid of known.keys()) { this.missingCards.delete(uid); this.cardRetries.delete(uid) }
    const byUid = new Map<string, Map<DocKey, Receipt>>()
    for (const file of this.files) {
      const card = file.uid ? known.get(file.uid) : undefined
      const key = docKey(file.host ?? '', file.fullPath, card?.originId ?? 'local', card?.fiberDir)
      const parsed = parseDocKey(key)!
      const uid = file.uid && !this.missingCards.has(file.uid) ? file.uid : `other:${parsed.owner}`
      const receipt: Receipt = { ...file, fullPath: parsed.path, key, uid, owner: parsed.owner, host: parsed.owner }
      let documents = byUid.get(uid)
      if (!documents) { documents = new Map(); byUid.set(uid, documents) }
      const prior = documents.get(key)
      if (!prior || receipt.timestamp > prior.timestamp || (receipt.timestamp === prior.timestamp && compare(receipt.sessionId ?? '', prior.sessionId ?? '') < 0)) documents.set(key, receipt)
    }
    for (const uid of this.openedCards.keys()) if (!byUid.has(uid)) byUid.set(uid, new Map())
    for (const [uid, documents] of byUid) {
      const receipts = [...documents.values()].sort((a, b) => b.timestamp - a.timestamp || compare(a.key, b.key))
      const card = known.get(uid) ?? this.openedCards.get(uid) ?? this.fallback(uid, receipts[0]?.owner ?? 'local')
      const latest = receipts[0]?.timestamp ?? 0
      let folio = this.folios.get(uid)
      const priorReceipts = folio?.receipts.map(r => [r.key, r.timestamp, r.sessionId])
      if (!folio) {
        folio = this.createFolio(uid, card)
        this.folios.set(uid, folio)
        folio.latest = latest
        folio.recent = overviewDayGroup(latest, Date.now())
      } else if (latest > folio.latest) {
        folio.latest = latest
        folio.recent = overviewDayGroup(latest, Date.now())
        folio.project = projectOf(card)
        folio.host = card.originId
      } else if (folio.provisional && known.has(uid)) {
        folio.project = projectOf(card)
        folio.host = card.originId
      }
      if (priorReceipts && JSON.stringify(priorReceipts) !== JSON.stringify(receipts.map(r => [r.key, r.timestamp, r.sessionId]))) arrived.push(folio)
      folio.provisional = !known.has(uid)
      folio.card = card; folio.receipts = receipts
      this.updateFolio(folio)
    }
    for (const [uid, folio] of this.folios) if (!byUid.has(uid)) {
      if (folio.thumb) this.removeThumbnail(folio.thumb)
      folio.el.remove(); this.folios.delete(uid)
    }
    this.marks = overviewHostMarks([...this.fleetHosts, ...known.values()].flatMap(h => typeof h === 'string' ? [h] : [h.originId, ...(h.mirroredOrigins ?? [])]).concat([...this.folios.values()].flatMap(f => f.receipts.map(r => r.owner))))
    this.render()
    if (this.visible && this.el.isConnected) {
      for (const folio of arrived) if (!folio.el.hidden) this.receiptMotion.folio(folio.el)
    }
    this.resolveFolios()
  }

  private resolveFolios(): void {
    if (this.disposed) return
    const candidates = [...this.folios.values()].filter(f => f.provisional && !f.uid.startsWith('other:'))
      .sort((a, b) => (a.thumb ? this.distance(a.thumb) : 0) - (b.thumb ? this.distance(b.thumb) : 0)).map(f => f.card)
    // Confirmed misses have moved to Unfiled, but their intrinsic ids remain retryable.
    for (const file of this.files) if (file.uid && this.missingCards.has(file.uid)) candidates.push(this.fallback(file.uid, file.host ?? 'local'))
    for (const card of candidates) {
      const uid = uidOf(card)
      if (!this.externalLoads.has(uid) && (this.cardRetries.get(uid)?.at ?? 0) <= Date.now()) void this.queueCard(card)
    }
    clearTimeout(this.retryTimer)
    const eligible = new Set(candidates.map(uidOf))
    const times = [...this.cardRetries].filter(([uid]) => eligible.has(uid) && !this.cardLoads.has(uid) && !this.externalLoads.has(uid)).map(([, retry]) => retry.at)
    if (times.length) this.retryTimer = setTimeout(() => this.reconcile(), Math.max(1, Math.min(...times) - Date.now()))
  }

  /** Clicks move ahead of queued preloads without duplicating or preempting active reads. */
  private queueCard(card: KanbanCard, priority = false): Promise<KanbanCard | undefined> {
    const uid = uidOf(card)
    const prior = this.cardLoads.get(uid)
    if (prior) {
      const index = priority ? this.cardQueue.findIndex(job => job.uid === uid) : -1
      if (index > 0) this.cardQueue.unshift(this.cardQueue.splice(index, 1)[0])
      return prior
    }
    let complete!: (card: KanbanCard | undefined) => void
    const pending = new Promise<KanbanCard | undefined>(resolve => { complete = resolve })
    this.cardLoads.set(uid, pending)
    const job = { uid, run: async (): Promise<void> => {
      const resolved = this.disposed ? undefined : this.knownCards().get(uid) ?? await this.loadCard(card)
      this.cardLoads.delete(uid)
      complete(resolved)
      if (!this.disposed) this.reconcile()
    } }
    if (priority) this.cardQueue.unshift(job)
    else this.cardQueue.push(job)
    this.pumpCards()
    return pending
  }
  private pumpCards(): void {
    while (this.activeCardReads < 4 && this.cardQueue.length) {
      const job = this.cardQueue.shift()!
      this.activeCardReads++
      void job.run().finally(() => { this.activeCardReads--; this.pumpCards() })
    }
  }

  private createFolio(uid: string, card: KanbanCard): Folio {
    const el = button('ws-overview-folio'); el.dataset.uid = uid
    const stack = node('div', 'ws-overview-stack')
    const tx = node('div', 'ws-overview-folio-text')
    const title = node('div', 'ws-overview-folio-title')
    const fresh = node('span', 'ws-overview-fresh'); fresh.title = 'New receipts since your last visit'
    const name = node('span', '')
    title.append(fresh, name)
    const outcome = node('div', 'ws-overview-outcome')
    const footer = node('div', 'ws-overview-footer ws-overview-meta')
    const marks = node('span', 'ws-overview-hostmarks')
    const count = node('span', '')
    const when = node('span', 'ws-overview-when')
    footer.append(marks, count, when); tx.append(title, outcome, footer); el.append(stack, tx)
    const folio: Folio = { uid, card, receipts: [], latest: 0, recent: 'Earlier', project: projectOf(card), host: card.originId, provisional: true,
      el, stack, name, fresh, outcome, marks, count, when }
    el.addEventListener('click', () => { void this.open(folio.card) })
    return folio
  }
  private updateFolio(folio: Folio): void {
    text(folio.name, folio.card.name)
    text(folio.outcome, folio.card.outcome ?? '')
    text(folio.count, `${folio.receipts.length} ${folio.receipts.length === 1 ? 'document' : 'documents'}`)
    text(folio.when, age(folio.latest))
    folio.el.title = folio.card.path || folio.uid
    folio.el.dataset.depth = String(Math.max(1, Math.min(3, folio.receipts.length)))
    folio.fresh.hidden = folio.latest <= Math.max(this.seen, this.visits.get(folio.uid) ?? 0)
    const lead = folio.receipts.find(r => r.fullPath.split('/').at(-1)?.toLowerCase() === 'report.html') ?? folio.receipts[0]
    const key = `folio:${folio.uid}:${lead?.key ?? 'prose'}`
    if (folio.thumb?.key !== key) {
      if (folio.thumb) this.removeThumbnail(folio.thumb)
      folio.thumb = this.createThumbnail(key, lead, `Fiber note · ${folio.card.outcome || folio.card.name}`)
      folio.stack.append(folio.thumb.el)
    } else if (folio.thumb) folio.thumb.file = lead
  }
  private grouped(): Array<[string, Folio[]]> {
    const groups = new Map<string, Folio[]>()
    for (const folio of this.folios.values()) {
      const key = this.lens === 'recent' ? folio.recent : this.lens === 'projects' ? folio.project : folio.host
      const list = groups.get(key) ?? []; list.push(folio); groups.set(key, list)
    }
    const cmp = (a: Folio, b: Folio): number => b.latest - a.latest || compare(a.uid, b.uid) || compare(a.card.originId, b.card.originId)
    for (const list of groups.values()) list.sort(cmp)
    return [...groups].sort(([ak, a], [bk, b]) => this.lens === 'recent'
      ? DAY_GROUPS.indexOf(ak as typeof DAY_GROUPS[number]) - DAY_GROUPS.indexOf(bk as typeof DAY_GROUPS[number])
      : cmp(a[0], b[0]) || compare(ak, bk))
  }
  private render(): void {
    const grouped = this.grouped()
    this.order = grouped.flatMap(([, rows]) => rows.map(f => f.card))
    this.opts.onOrder?.([...this.order])
    const query = this.find.value.trim().toLowerCase()
    const matches = (f: Folio): boolean => !query || [f.card.name, f.card.path, ...f.receipts.flatMap(r => [r.basename, r.fullPath])].some(v => v.toLowerCase().includes(query))
    const shown: HTMLElement[] = []
    for (const [name, rows] of grouped) {
      const filtered = rows.filter(matches)
      const key = `${this.lens}:${name}`
      let group = this.groups.get(key)
      if (!group) {
        const el = node('section', 'ws-overview-group')
        const title = node('h2', 'ws-overview-section-title', name)
        const count = node('span', 'ws-overview-section-count')
        const grid = node('div', 'ws-overview-folios')
        title.append(count); el.append(title, grid)
        group = { el, grid, count }; this.groups.set(key, group)
      }
      text(group.count, `${filtered.length} ${filtered.length === 1 ? 'fiber' : 'fibers'}`)
      group.el.hidden = !filtered.length
      place(group.grid, rows.map(f => f.el)); shown.push(group.el)
    }
    // Filtered folios stay mounted and inert, so Find never discards live thumbnails.
    for (const folio of this.folios.values()) {
      const visible = matches(folio)
      folio.el.hidden = !visible; folio.el.inert = !visible
      const hosts = [...new Set([folio.card.originId, ...(folio.card.mirroredOrigins ?? []), ...folio.receipts.map(r => r.owner)])].sort(compare)
      text(folio.marks, hosts.map(h => this.marks.get(h) ?? '○').join(' ')); folio.marks.title = hosts.join(', ')
      folio.marks.setAttribute('aria-label', hosts.join(', '))
    }
    place(this.groupsEl, shown)
    this.renderRibbon()
    text(this.summary, `${this.folios.size} fibers · ${new Set([...this.folios.values()].flatMap(f => f.receipts.map(r => r.key))).size} documents · last 30 days`)
    const legend = [...this.marks].map(([host, mark]) => node('span', 'ws-overview-hostmark', `${mark} ${host}`))
    this.legend.replaceChildren(...legend)
    if (!this.status.textContent || this.status.textContent.startsWith('No ')) text(this.status, this.folios.size ? grouped.some(([, rows]) => rows.some(matches)) ? '' : 'No work matches Find.' : 'No receipts in the last 30 days. Open a fiber to keep it here this session.')
    this.paintSelection()
    this.schedule()
  }

  private candidates(): HTMLButtonElement[] {
    return [...this.ribbon.querySelectorAll<HTMLButtonElement>('.ws-overview-rib'),
      ...this.groupsEl.querySelectorAll<HTMLButtonElement>('.ws-overview-folio')].filter(el => !el.closest('[hidden]'))
  }
  private paintSelection(): void {
    for (const el of this.el.querySelectorAll('.ws-key-selected')) el.classList.remove('ws-key-selected')
    if (this.selection && this.candidates().includes(this.selection)) this.selection.classList.add('ws-key-selected')
  }
  private moveSelection(intent: KeyIntent): void {
    const candidates = this.candidates()
    if (!candidates.length) return
    const current = this.selection && candidates.includes(this.selection) ? this.selection : null
    let next = current ?? candidates.find(el => el.classList.contains('ws-overview-folio')) ?? candidates[0]
    if (intent === 'open') { current?.click(); return }
    if (intent === 'first' || intent === 'last') {
      const folios = candidates.filter(el => el.classList.contains('ws-overview-folio'))
      next = (intent === 'first' ? folios[0] : folios.at(-1)) ?? next
    } else if (current) {
      const rect = current.getBoundingClientRect()
      const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
      const horizontal = intent === 'left' || intent === 'right'
      const forward = intent === 'right' || intent === 'down'
      const isRibbon = this.ribbon.contains(current)
      const ranked = candidates.filter(el => el !== current && (!horizontal || this.ribbon.contains(el) === isRibbon)).map(el => {
        const r = el.getBoundingClientRect()
        const dx = r.left + r.width / 2 - x, dy = r.top + r.height / 2 - y
        return { el, primary: (horizontal ? dx : dy) * (forward ? 1 : -1), cross: Math.abs(horizontal ? dy : dx) }
      }).filter(p => p.primary > 1).sort((a, b) => (a.primary + a.cross * 3) - (b.primary + b.cross * 3))
      next = ranked[0]?.el ?? current
    }
    this.selection = next
    this.paintSelection()
    next.scrollIntoView?.({ block: 'nearest', inline: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (!this.visible || blockingDialogOpen()) return
    const intent = keyIntent(event, 'overview')
    if (!intent || intent === 'help') return
    event.preventDefault()
    if (intent === 'find') this.find.focus({ preventScroll: true })
    else this.moveSelection(intent)
  }
  private renderRibbon(): void {
    const documents = new Map<DocKey, Receipt>()
    for (const folio of this.folios.values()) for (const receipt of folio.receipts) {
      const prior = documents.get(receipt.key)
      if (!prior || receipt.timestamp > prior.timestamp || (receipt.timestamp === prior.timestamp && compare(receipt.uid, prior.uid) < 0)) documents.set(receipt.key, receipt)
    }
    const recent = [...documents.values()].sort((a, b) => b.timestamp - a.timestamp || compare(a.key, b.key)).slice(0, 12)
    const labels = documentLabels(recent.map(r => ({ key: r.key, owner: r.owner, path: r.fullPath, name: r.basename, kind: documentKind(r.fullPath), provenance: [] })))
    const keep = new Set(recent.map(r => r.key))
    for (const [key, item] of this.ribbonItems) if (!keep.has(key)) {
      this.removeThumbnail(item.thumb); item.el.remove(); this.ribbonItems.delete(key)
    }
    for (const receipt of recent) {
      let item = this.ribbonItems.get(receipt.key)
      if (!item) {
        const el = button('ws-overview-rib')
        const thumb = this.createThumbnail(`ribbon:${receipt.key}`, receipt, receipt.basename)
        const label = node('span', 'ws-overview-rib-label')
        const name = node('span', 'ws-overview-rib-name')
        const footer = node('span', 'ws-overview-rib-footer ws-overview-meta')
        const when = node('span', ''), host = node('span', 'ws-overview-hostmark')
        footer.append(when, host); el.append(thumb.el, label, name, footer)
        item = { el, receipt, thumb, label, name, when, host }; this.ribbonItems.set(receipt.key, item)
        el.addEventListener('click', () => {
          const current = this.ribbonItems.get(receipt.key)?.receipt
          const folio = current && this.folios.get(current.uid)
          if (folio && current) void this.open(folio.card, current.key)
        })
      }
      item.receipt = receipt; item.thumb.file = receipt
      text(item.label, labels[recent.indexOf(receipt)])
      item.label.classList.toggle('ws-overview-declared-title', !!declaredTitle(receipt.key)?.title)
      text(item.name, this.folios.get(receipt.uid)?.card.name ?? 'Other')
      text(item.when, age(receipt.timestamp)); text(item.host, `${this.marks.get(receipt.owner) ?? '○'} ${receipt.owner}`)
      item.el.title = `${receipt.fullPath} — ${this.folios.get(receipt.uid)?.card.name ?? 'Other'}`
    }
    place(this.ribbon, recent.map(r => this.ribbonItems.get(r.key)!.el))
  }
  private async open(card: KanbanCard, key?: DocKey): Promise<void> {
    const navigation = ++this.navigation
    const uid = uidOf(card)
    let resolved = this.knownCards().get(uid)
    if (!resolved && !uid.startsWith('other:')) resolved = await this.queueCard(card, true)
    if (this.disposed || navigation !== this.navigation) return
    const target = resolved ?? (this.missingCards.has(uid) ? this.fallback(`other:${card.originId}`, card.originId) : card)
    this.opened(target, !!resolved || target.uid?.startsWith('other:'))
    this.opts.onOpen(target, key)
  }
  private async loadCard(fallback: KanbanCard): Promise<KanbanCard | undefined> {
    const controller = new AbortController(); this.cardControllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 25000)
    try {
      const entry = await readFiber(this.opts.shuttleBase, uidOf(fallback), fallback.originId, controller.signal, 'discover')
      const card = cardFromCompositeEntry(entry)
      const current = this.knownCards().get(uidOf(fallback))
      if (!this.disposed) this.resolved(current ?? card)
      return current ?? card
    } catch (error) {
      const uid = uidOf(fallback)
      const current = this.knownCards().get(uid)
      if (current) return current
      if (!this.disposed) {
        if (error instanceof Error && error.message.startsWith('Fiber not found on ')) this.missingCards.add(uid)
        const attempts = (this.cardRetries.get(uid)?.attempts ?? 0) + 1
        this.cardRetries.set(uid, { attempts, at: Date.now() + Math.min(30000, 1000 * 2 ** Math.min(attempts - 1, 5)) })
      }
      return undefined
    }
    finally { clearTimeout(timeout); this.cardControllers.delete(controller) }
  }

  private createThumbnail(key: string, file: Receipt | undefined, fallback: string): Thumbnail {
    const thumb: Thumbnail = new Thumbnail({ key, file, fallback, shuttleBase: this.opts.shuttleBase, className: 'ws-overview-thumb',
      captioned: key.startsWith('ribbon:'),
      priority: () => this.visible && !this.disposed ? this.priority(thumb) : 0,
      distance: () => this.distance(thumb),
    })
    this.thumbnails.set(key, thumb); this.observer?.observe(thumb.el)
    return thumb
  }
  private removeThumbnail(thumb: Thumbnail): void {
    this.observer?.unobserve(thumb.el); thumb.dispose(); this.thumbnails.delete(thumb.key)
  }
  private readonly schedule = (): void => {
    if (this.disposed || !this.visible || this.raf !== undefined) return
    this.raf = requestAnimationFrame(() => { this.raf = undefined; this.pump() })
  }
  private distance(thumb: Thumbnail): number {
    const root = this.el.getBoundingClientRect(), rect = thumb.el.getBoundingClientRect()
    return Math.hypot((rect.top + rect.bottom - root.top - root.bottom) / 2, (rect.left + rect.right - root.left - root.right) / 2)
  }
  private onScreen(thumb: Thumbnail): boolean {
    const root = this.el.getBoundingClientRect(), rect = thumb.el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && rect.bottom > root.top && rect.top < root.bottom && rect.right > root.left && rect.left < root.right
  }
  /** On screen outranks the loading ring, which outranks everything else. */
  private priority(thumb: Thumbnail): number {
    if (!thumb.el.isConnected || thumb.el.closest('[hidden]')) return 0
    if (this.onScreen(thumb)) return 2
    return (this.observer ? thumb.near : false) ? 1 : 0
  }
  private pump(): void {
    if (this.disposed || !this.visible) return
    pumpThumbnails()
  }
  private scaleThumbnails(): void {
    for (const thumb of this.thumbnails.values()) thumb.scale()
  }
}
