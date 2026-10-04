import type { KanbanCard } from '../KanbanTypes.js'
import { parseCompositeFeed } from '../KanbanComposite.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import { fiberDocUrl } from '../utils.js'
import { fileUrl, normalizeShelfFiles, shelfKind, type ShelfFile } from '../views/shelfData.js'
import { chooseEvictions, chooseLoads, LOAD_POLICY, TextCache } from '../views/shelfLoad.js'
import { docKey, parseDocKey, type DocKey } from './documents.js'
import './tokens.css'
import './overview.css'

export interface OverviewOptions {
  shuttleBase: string
  cards(): KanbanCard[]
  onOpen(card: KanbanCard, doc?: DocKey): void
  /** Full lens order, independent of Find; suitable for reader channel stepping. */
  onOrder?(cards: KanbanCard[]): void
}
export type OverviewLens = 'recent' | 'projects' | 'hosts'
const WINDOW_MS = 30 * 86400000
const LENS_STORAGE = 'shuttle.workspace.overview.lens'
const VISIT_STORAGE = 'shuttle.workspace.overview.visits'
const DAY_GROUPS = ['Today', 'Yesterday', 'This week', 'Earlier'] as const
const HOST_MARKS = ['○', '■', '▲', '◇', '◐']
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uidOf = (card: KanbanCard): string => card.uid ?? card.id

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
  opened: boolean
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
interface Thumbnail {
  key: string
  el: HTMLElement
  file?: Receipt
  state: 'idle' | 'loading' | 'live' | 'failed'
  near: boolean
  lastVisible: number
  body?: HTMLElement
  controller?: AbortController
  timer?: ReturnType<typeof setTimeout>
  generation: number
}

/** Persistent contact sheet; receipts are raw, owner-aware, and never path-deduped. */
export class Overview {
  readonly el = node('div', 'ws-overview')
  private readonly opts: OverviewOptions
  private readonly inner = node('div', 'ws-overview-inner')
  private readonly summary = node('div', 'ws-overview-summary')
  private readonly legend = node('div', 'ws-overview-legend')
  private readonly ribbon = node('div', 'ws-overview-ribbon')
  private readonly groupsEl = node('div', 'ws-overview-groups')
  private readonly status = node('p', 'ws-overview-status')
  private readonly find = node('input', 'ws-overview-find')
  private readonly lensSelect = node('select', 'ws-overview-lens')
  private readonly folios = new Map<string, Folio>()
  private readonly ribbonItems = new Map<DocKey, RibbonItem>()
  private readonly groups = new Map<string, Group>()
  private readonly thumbnails = new Map<string, Thumbnail>()
  private readonly textCache = new TextCache()
  private readonly visits = new Map<string, number>()
  private readonly openedCards = new Map<string, KanbanCard>()
  private readonly fetchedCards = new Map<string, KanbanCard>()
  private readonly cardLoads = new Map<string, Promise<KanbanCard>>()
  private readonly cardControllers = new Set<AbortController>()
  private readonly observer?: IntersectionObserver
  private readonly resizeObserver?: ResizeObserver
  private marks = new Map<string, string>()
  private files: ShelfFile[] = []
  private fleetHosts: string[] = []
  private lens: OverviewLens = 'recent'
  private order: KanbanCard[] = []
  private request?: AbortController
  private visible = true
  private disposed = false
  private scroll = 0
  private raf?: number

  constructor(opts: OverviewOptions) {
    this.opts = opts
    const lens = stored(LENS_STORAGE)
    if (lens === 'recent' || lens === 'projects' || lens === 'hosts') this.lens = lens
    const visits = stored(VISIT_STORAGE)
    if (visits && typeof visits === 'object' && !Array.isArray(visits)) {
      for (const [uid, at] of Object.entries(visits)) if (typeof at === 'number' && Number.isFinite(at)) this.visits.set(uid, at)
    }
    const header = node('header', 'ws-overview-masthead')
    const heading = node('div', 'ws-overview-heading')
    heading.append(node('h1', '', 'Documents'), this.summary)
    this.legend.setAttribute('aria-label', 'Host legend')
    header.append(heading, this.legend)
    const receipts = node('section', 'ws-overview-receipts')
    receipts.setAttribute('aria-label', 'Latest receipts')
    const receiptHeading = node('h2', 'ws-overview-section-title', 'Latest receipts')
    receiptHeading.append(node('span', 'ws-overview-section-count', '12 newest across the fleet'))
    receipts.append(receiptHeading, this.ribbon)
    const controls = node('div', 'ws-overview-controls')
    this.lensSelect.setAttribute('aria-label', 'Group documents')
    for (const [value, label] of [['recent', 'Recent work'], ['projects', 'Projects'], ['hosts', 'Hosts']]) {
      const option = node('option', '', label); option.value = value; this.lensSelect.append(option)
    }
    this.lensSelect.value = this.lens
    this.lensSelect.addEventListener('change', () => {
      this.lens = this.lensSelect.value as OverviewLens
      persist(LENS_STORAGE, this.lens)
      this.render()
    })
    this.find.type = 'search'; this.find.placeholder = 'Find work or files…'
    this.find.setAttribute('aria-label', 'Find work or files')
    this.find.addEventListener('input', () => this.render())
    controls.append(this.lensSelect, this.find)
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
    this.render()
  }

  /** Metadata paints immediately; one coalesced feed read finishes asynchronously. */
  refresh(): void {
    if (this.disposed) return
    this.reconcile()
    if (this.request) return
    const controller = new AbortController()
    this.request = controller
    const since = Date.now() - WINDOW_MS
    const timeout = setTimeout(() => controller.abort(), 25000)
    void (async () => {
      try {
        const response = await fetch(`${this.opts.shuttleBase}/api/v1/sent-files/all/composite?since_ms=${Math.floor(since)}`, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Receipt feed unavailable')
        const raw: unknown = await response.json()
        if (this.disposed) return
        if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { files?: unknown }).files)) throw new Error('Invalid receipt feed')
        this.files = normalizeShelfFiles(raw).filter(f => Number.isFinite(f.timestamp) && f.timestamp > 0 && f.timestamp >= since)
        const origins = (raw as { origins?: unknown }).origins
        this.fleetHosts = origins && typeof origins === 'object' ? Object.keys(origins) : []
        text(this.status, '')
        this.reconcile()
      } catch {
        if (!this.disposed) text(this.status, 'Receipt feed unavailable — showing the last loaded sheet.')
      } finally {
        clearTimeout(timeout)
        if (this.request === controller) this.request = undefined
      }
    })()
  }

  opened(card: KanbanCard): void {
    if (this.disposed) return
    const uid = uidOf(card)
    this.openedCards.set(uid, card)
    this.visits.set(uid, Date.now())
    persist(VISIT_STORAGE, Object.fromEntries(this.visits))
    this.reconcile()
  }

  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return
    if (!visible) this.scroll = this.el.scrollTop
    this.visible = visible
    this.el.hidden = !visible
    this.el.inert = !visible
    if (visible) { this.el.scrollTop = this.scroll; this.schedule() }
    else if (this.raf !== undefined) { cancelAnimationFrame(this.raf); this.raf = undefined }
  }
  show(): void { this.setVisible(true) }
  hide(): void { this.setVisible(false) }
  /** Find never truncates keyboard channel order. */
  orderedCards(): KanbanCard[] { return [...this.order] }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.request?.abort()
    for (const controller of this.cardControllers) controller.abort()
    this.observer?.disconnect()
    this.resizeObserver?.disconnect()
    if (this.raf !== undefined) cancelAnimationFrame(this.raf)
    for (const thumb of this.thumbnails.values()) this.unmount(thumb)
    this.thumbnails.clear()
    window.removeEventListener('resize', this.schedule)
    this.el.removeEventListener('scroll', this.schedule)
    this.ribbon.removeEventListener('scroll', this.schedule)
    this.el.remove()
  }

  private knownCards(): Map<string, KanbanCard> {
    const known = new Map(this.fetchedCards)
    for (const [uid, card] of this.openedCards) known.set(uid, card)
    // The live board's chosen mirrored row owns fiber metadata, not the file's byte host.
    for (const card of this.opts.cards()) known.set(uidOf(card), card)
    return known
  }
  private fallback(uid: string, owner: string): KanbanCard {
    return { id: uid, uid, name: uid.startsWith('other:') ? 'Other' : `Other · ${uid}`, path: '', originId: owner, status: '', createdAt: '',
      effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }
  }
  private reconcile(): void {
    const known = this.knownCards()
    const byUid = new Map<string, Map<DocKey, Receipt>>()
    for (const file of this.files) {
      const card = file.uid ? known.get(file.uid) : undefined
      const key = docKey(file.host ?? '', file.fullPath, card?.originId ?? 'local', card?.fiberDir)
      const parsed = parseDocKey(key)!
      const uid = file.uid ?? `other:${parsed.owner}`
      const receipt: Receipt = { ...file, fullPath: parsed.path, key, uid, owner: parsed.owner, host: parsed.owner }
      let documents = byUid.get(uid)
      if (!documents) { documents = new Map(); byUid.set(uid, documents) }
      const prior = documents.get(key)
      if (!prior || receipt.timestamp > prior.timestamp || (receipt.timestamp === prior.timestamp && compare(receipt.sessionId ?? '', prior.sessionId ?? '') < 0)) documents.set(key, receipt)
    }
    for (const uid of this.openedCards.keys()) if (!byUid.has(uid)) byUid.set(uid, new Map())
    for (const [uid, documents] of byUid) {
      const receipts = [...documents.values()].sort((a, b) => b.timestamp - a.timestamp || compare(a.key, b.key))
      const card = known.get(uid) ?? this.fallback(uid, receipts[0]?.owner ?? 'local')
      const latest = receipts[0]?.timestamp ?? 0
      let folio = this.folios.get(uid)
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
      }
      folio.card = card; folio.receipts = receipts; folio.opened = this.openedCards.has(uid)
      this.updateFolio(folio)
    }
    for (const [uid, folio] of this.folios) if (!byUid.has(uid)) {
      if (folio.thumb) this.removeThumbnail(folio.thumb)
      folio.el.remove(); this.folios.delete(uid)
    }
    this.marks = overviewHostMarks([...this.fleetHosts, ...known.values()].flatMap(h => typeof h === 'string' ? [h] : [h.originId, ...(h.mirroredOrigins ?? [])]).concat([...this.folios.values()].flatMap(f => f.receipts.map(r => r.owner))))
    this.render()
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
    const footer = node('div', 'ws-overview-footer')
    const marks = node('span', 'ws-overview-hostmarks')
    const count = node('span', '')
    const when = node('span', 'ws-overview-when')
    footer.append(marks, count, when); tx.append(title, outcome, footer); el.append(stack, tx)
    const folio: Folio = { uid, card, receipts: [], latest: 0, recent: 'Earlier', project: projectOf(card), host: card.originId,
      opened: false, el, stack, name, fresh, outcome, marks, count, when }
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
    folio.fresh.hidden = folio.latest <= (this.visits.get(folio.uid) ?? 0)
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
    this.schedule()
  }
  private renderRibbon(): void {
    const documents = new Map<DocKey, Receipt>()
    for (const folio of this.folios.values()) for (const receipt of folio.receipts) {
      const prior = documents.get(receipt.key)
      if (!prior || receipt.timestamp > prior.timestamp || (receipt.timestamp === prior.timestamp && compare(receipt.uid, prior.uid) < 0)) documents.set(receipt.key, receipt)
    }
    const recent = [...documents.values()].sort((a, b) => b.timestamp - a.timestamp || compare(a.key, b.key)).slice(0, 12)
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
        const footer = node('span', 'ws-overview-rib-footer')
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
      text(item.label, receipt.basename); text(item.name, this.folios.get(receipt.uid)?.card.name ?? 'Other')
      text(item.when, age(receipt.timestamp)); text(item.host, `${this.marks.get(receipt.owner) ?? '○'} ${receipt.owner}`)
      item.el.title = `${receipt.fullPath} — ${this.folios.get(receipt.uid)?.card.name ?? 'Other'}`
    }
    place(this.ribbon, recent.map(r => this.ribbonItems.get(r.key)!.el))
  }
  private async open(card: KanbanCard, key?: DocKey): Promise<void> {
    const uid = uidOf(card)
    let resolved = this.knownCards().get(uid)
    if (!resolved && !uid.startsWith('other:')) {
      let pending = this.cardLoads.get(uid)
      if (!pending) {
        pending = this.loadCard(card); this.cardLoads.set(uid, pending)
        void pending.finally(() => this.cardLoads.delete(uid))
      }
      resolved = await pending
    }
    if (this.disposed) return
    resolved ??= card
    this.opened(resolved)
    this.opts.onOpen(resolved, key)
  }
  private async loadCard(fallback: KanbanCard): Promise<KanbanCard> {
    const controller = new AbortController(); this.cardControllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), 25000)
    try {
      const response = await fetch(`${fiberDocUrl(this.opts.shuttleBase, uidOf(fallback))}?body=true&origin=${encodeURIComponent(fallback.originId)}`, { signal: controller.signal })
      if (!response.ok) return fallback
      const entry = parseCompositeFeed(await response.json()).entries[0]
      if (!entry) return fallback
      const card = cardFromCompositeEntry(entry)
      if (!this.disposed) this.fetchedCards.set(uidOf(fallback), card)
      return card
    } catch { return fallback }
    finally { clearTimeout(timeout); this.cardControllers.delete(controller) }
  }

  private createThumbnail(key: string, file: Receipt | undefined, fallback: string): Thumbnail {
    const el = node('div', 'ws-overview-thumb')
    el.setAttribute('aria-hidden', 'true'); el.inert = true
    const face = node('div', 'ws-overview-thumb-face', file?.basename ?? fallback)
    el.append(face)
    const thumb: Thumbnail = { key, el, file, state: 'idle', near: false, lastVisible: 0, generation: 0 }
    this.thumbnails.set(key, thumb); this.observer?.observe(el)
    return thumb
  }
  private removeThumbnail(thumb: Thumbnail): void {
    this.observer?.unobserve(thumb.el); this.unmount(thumb); thumb.el.remove(); this.thumbnails.delete(thumb.key)
  }
  private unmount(thumb: Thumbnail): void {
    thumb.generation++
    thumb.controller?.abort(); thumb.controller = undefined
    clearTimeout(thumb.timer); thumb.timer = undefined
    thumb.body?.remove(); thumb.body = undefined; thumb.state = 'idle'
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
  private pump(): void {
    if (this.disposed || !this.visible) return
    this.scaleThumbnails()
    const eligible = (t: Thumbnail): boolean => t.el.isConnected && !t.el.closest('[hidden]') && (!!this.observer ? t.near : this.onScreen(t))
    const alive = [...this.thumbnails.values()].filter(t => t.state === 'live' || t.state === 'loading')
    // Make room before mounting, keeping the sixteen-body bound strict even in a dense viewport.
    const candidates = [...this.thumbnails.values()].filter(t => t.state === 'idle' && t.file && eligible(t) && ['page', 'image', 'text'].includes(shelfKind(t.file.fullPath)))
    if (candidates.length && alive.length >= LOAD_POLICY.maxLive) {
      const victims = chooseEvictions(alive.map(t => ({ key: t.key, lastVisible: t.lastVisible, exempt: eligible(t) && this.onScreen(t) })), { maxLive: LOAD_POLICY.maxLive - 1, evictTo: LOAD_POLICY.evictTo })
      for (const key of victims) this.unmount(this.thumbnails.get(key)!)
    }
    const population = [...this.thumbnails.values()].filter(t => t.state === 'live' || t.state === 'loading')
    const slots = Math.min(LOAD_POLICY.maxConcurrent - population.filter(t => t.state === 'loading').length, LOAD_POLICY.maxLive - population.length)
    for (const key of chooseLoads(candidates.map(t => ({ key: t.key, distance: this.distance(t) })), slots)) this.mount(this.thumbnails.get(key)!)
  }
  private scaleThumbnails(): void {
    for (const thumb of this.thumbnails.values()) {
      if (!thumb.body) continue
      if (thumb.body.tagName !== 'IFRAME' && thumb.body.tagName !== 'PRE') continue
      const width = thumb.body.tagName === 'IFRAME' ? 1040 : 760
      const scale = (thumb.el.clientWidth || 176) / width
      thumb.body.style.transform = `scale(${scale})`
      if (thumb.body.tagName === 'IFRAME') thumb.body.style.height = `${Math.ceil((thumb.el.clientHeight || 116) / scale)}px`
    }
  }
  private mount(thumb: Thumbnail): void {
    const file = thumb.file
    if (!file || thumb.state !== 'idle') return
    const generation = ++thumb.generation
    thumb.state = 'loading'
    const current = (): boolean => !this.disposed && thumb.generation === generation
    const finish = (ok: boolean): void => {
      if (!current() || thumb.state !== 'loading') return
      clearTimeout(thumb.timer); thumb.timer = undefined
      thumb.state = ok ? 'live' : 'failed'
      if (!ok) { thumb.controller?.abort(); thumb.body?.remove(); thumb.body = undefined }
      this.schedule()
    }
    thumb.timer = setTimeout(() => finish(false), file.owner === 'local' ? LOAD_POLICY.softTimeoutLocalMs : LOAD_POLICY.softTimeoutRemoteMs)
    const url = fileUrl(this.opts.shuttleBase, file)
    const kind = shelfKind(file.fullPath)
    if (kind === 'page') {
      const frame = node('iframe', 'ws-overview-thumb-body')
      frame.setAttribute('sandbox', ''); frame.inert = true; frame.tabIndex = -1; frame.title = file.basename
      frame.setAttribute('scrolling', 'no'); frame.style.width = '1040px'
      frame.addEventListener('load', () => finish(true), { once: true })
      frame.addEventListener('error', () => finish(false), { once: true })
      frame.src = url; thumb.body = frame; thumb.el.append(frame)
    } else if (kind === 'image') {
      const image = node('img', 'ws-overview-thumb-body')
      image.alt = ''; image.decoding = 'async'; image.inert = true
      image.addEventListener('load', () => finish(true), { once: true })
      image.addEventListener('error', () => finish(false), { once: true })
      image.src = url; thumb.body = image; thumb.el.append(image)
    } else if (kind === 'text') {
      const controller = new AbortController(); thumb.controller = controller
      const draw = (source: string): void => {
        if (!current() || thumb.state !== 'loading') return
        const pre = node('pre', 'ws-overview-thumb-body', source.slice(0, 12000))
        pre.style.width = '760px'; pre.inert = true
        thumb.body = pre; thumb.el.append(pre); this.scaleThumbnails(); finish(true)
      }
      const cached = this.textCache.get(file.key)
      if (cached !== undefined) draw(cached)
      else void fetch(url, { signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('Thumbnail unavailable')
        const source = (await response.text()).slice(0, 12000)
        if (!current()) return
        this.textCache.set(file.key, source); draw(source)
      }).catch(() => finish(false))
    }
    this.scaleThumbnails()
  }
}
