import './tokens.css'
import './reader.css'
import type { KanbanCard } from '../KanbanTypes.js'
import { keyIntent, shouldForwardDocumentKey, type KeyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { fileBytesUrl, showToast } from '../utils.js'
import { DocumentHost, type DocumentFrame } from './DocumentHost.js'
import type { Channel, DocKey, WorkspaceDocument } from './documents.js'
import { TabStrip } from './TabStrip.js'

export interface ReaderOptions {
  shuttleBase: string
  buildProse(doc: WorkspaceDocument): HTMLElement
  onRefreshProse(doc: WorkspaceDocument): void | Promise<void>
  onSelect(key: DocKey): void
  onReturn(): void
  workerPill?(card: KanbanCard): HTMLElement | null
  onEscapeLayer?(): boolean
  onChannel(card: KanbanCard): void
  cards(): KanbanCard[]
  /** The sidebar's order, shared by every constitution-stepping binding. */
  switcherCards?(): KanbanCard[]
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = cls
  if (text) el.textContent = text
  return el
}
function button(cls: string, text: string, action: () => void, label = text): HTMLButtonElement {
  const b = element('button', cls, text)
  b.type = 'button'
  b.setAttribute('aria-label', label)
  b.addEventListener('click', action)
  return b
}

/** The viewport at which desktop sidebar layout is available. */
export const SIDEBAR_MEDIA = '(min-width: 1280px)'
const SIDEBAR_STORAGE = 'shuttle:workspace:sidebar'

/** A single stage whose identity-keyed pages stay attached across channels. */
export class Reader {
  readonly el = element('section', 'ws-reader ws-dormant')
  /** The vellum the reader floats on; the only blurred layer, and it never moves. */
  private readonly veil = element('div', 'ws-veil')
  private departure: ReturnType<typeof setTimeout> | null = null
  private arrival = 0
  readonly track = element('div', 'ws-track')
  readonly stage = element('div', 'ws-stage')
  readonly host: DocumentHost
  private readonly opts: ReaderOptions
  private readonly tabs: TabStrip
  private readonly navbar: HTMLElement
  private readonly lead: HTMLElement
  private readonly trail: HTMLElement
  private keyboardInput = false
  private readonly title: HTMLButtonElement
  private readonly returnButton: HTMLButtonElement
  private readonly conversation = element('div', 'ws-worker-pill')
  private readonly position = element('span', 'ws-position')
  private readonly announcement = element('div', 'ws-sr-only')
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly observer: ResizeObserver | null
  private readonly labels = new WeakMap<DocumentFrame, { glyph: HTMLElement; title: HTMLElement; provenance: HTMLElement; expand: HTMLButtonElement }>()
  private channel: Channel | null = null
  private agent = ''
  private selected: DocKey | null = null
  private expanded = false
  private active = false
  private menu: HTMLElement | null = null
  private menuAnchor: HTMLElement | null = null
  private switcher = false
  private sidebar = element('aside', 'ws-sidebar')
  private readonly sidebarFind = element('input', 'ws-channel-find')
  private sidebarList: HTMLElement = element('div', 'ws-channel-list')
  /** The persisted choice; absent, the sidebar is closed. */
  private sidebarChoice: boolean | null = null
  private readonly sidebarToggle: HTMLButtonElement
  private readonly wide = window.matchMedia(SIDEBAR_MEDIA)
  private liveWidth: number | null = null
  private cancelResize: (() => void) | null = null
  private instantRaf = 0
  private sizes: Record<string, number> = {}
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly phone = window.matchMedia(MOBILE_MEDIA)

  constructor(opts: ReaderOptions) {
    this.opts = opts
    this.el.setAttribute('aria-label', 'Document reader')
    this.el.inert = true
    this.tabs = new TabStrip(i => this.selectIndex(i), () => this.toggleExpand())
    this.returnButton = button('ws-return', '‹ Desk', () => opts.onReturn())
    this.title = button('ws-channel-title', '', () => this.openSwitcher())
    this.sidebarToggle = button('ws-sidebar-toggle', '▥ Constitutions', () => this.toggleSidebar(), 'Constitutions')
    this.sidebarToggle.title = 'Constitutions (⌘\\)'
    this.lead = element('div', 'ws-nav-lead')
    this.lead.append(this.returnButton, this.sidebarToggle, this.title)
    this.trail = element('div', 'ws-nav-trail')
    this.trail.append(this.conversation)
    this.navbar = element('nav', 'ws-navbar')
    this.navbar.append(this.lead, this.tabs.el, this.trail)
    this.prev = button('ws-thumb-button', '‹', () => this.step(-1), 'Previous document')
    this.next = button('ws-thumb-button', '›', () => this.step(1), 'Next document')
    const thumbMenu = button('ws-thumb-button', '⋯', () => {
      const doc = this.document
      if (doc) this.openMenu(doc, thumbMenu)
    }, 'Document menu')
    const thumb = element('div', 'ws-thumbbar')
    thumb.append(this.prev, this.position, this.next, thumbMenu)
    this.announcement.setAttribute('aria-live', 'polite')
    this.announcement.setAttribute('aria-atomic', 'true')
    this.stage.append(this.track)
    this.sidebar.setAttribute('aria-label', 'Constitutions')
    this.sidebarFind.type = 'search'
    this.sidebarFind.placeholder = 'Find a constitution'
    this.sidebarFind.setAttribute('aria-label', 'Find a constitution')
    this.sidebarFind.addEventListener('input', () => this.fillSidebar())
    this.sidebar.append(this.sidebarFind, this.sidebarList)
    const main = element('div', 'ws-stage-row')
    main.append(this.sidebar, this.stage)
    this.el.append(this.veil, this.navbar, main, thumb, this.announcement)
    this.host = new DocumentHost(this.track, {
      shuttleBase: opts.shuttleBase,
      buildProse: opts.buildProse,
      onRefreshProse: opts.onRefreshProse,
      onSelect: key => opts.onSelect(key),
      onFrame: frame => this.prepareFrame(frame),
    })
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout(false))
    this.observer?.observe(this.stage)
    window.addEventListener('resize', this.relayout)
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
    document.addEventListener('pointerdown', this.pointerInput, true)
    this.motion.addEventListener('change', this.relayout)
    this.phone.addEventListener('change', this.relayout)
    this.wide.addEventListener('change', this.relayout)
    this.el.addEventListener('mousedown', e => {
      if (e.button === 0 && (e.target as Element).closest('button')) e.preventDefault()
    })
    try {
      this.sizes = JSON.parse(sessionStorage.getItem('shuttle:workspace:sizes') ?? '{}')
      const choice = localStorage.getItem(SIDEBAR_STORAGE)
      if (choice === 'true' || choice === 'false') this.sidebarChoice = choice === 'true'
    } catch { /* Storage is optional. */ }
  }

  get document(): WorkspaceDocument | undefined { return this.channel?.documents.find(d => d.key === this.selected) }
  get isActive(): boolean { return this.active }

  show(channel: Channel, selected: DocKey, origin = 'Desk', card?: KanbanCard, animate = true): void {
    const switching = channel.uid !== this.channel?.uid || channel.owner !== this.channel?.owner || !this.active
    if (switching) { this.cancelResize?.(); this.expanded = false; this.closeMenu() }
    this.channel = channel
    this.selected = selected
    const arriving = !this.active
    this.active = true
    if (arriving) this.arrive(origin === 'Board')
    this.el.inert = false
    this.el.removeAttribute('aria-hidden')
    this.returnButton.textContent = `‹ ${origin}`
    this.returnButton.setAttribute('aria-label', `Return to ${origin}`)
    this.title.textContent = channel.name
    this.title.title = channel.name
    const pill = card ? this.opts.workerPill?.(card) : null
    this.conversation.replaceChildren(...(pill ? [pill] : []))
    this.agent = card?.workerAgent ?? card?.shuttleAgent ?? ''
    this.tabs.render(channel.labels)
    this.host.setChannel(channel.documents, selected)
    this.paint(!switching && animate)
    this.renderSidebar()
    if (switching && this.keyboardInput) this.returnButton.focus({ preventScroll: true })
    requestAnimationFrame(() => this.layout(false))
  }

  select(key: DocKey): void {
    if (!this.channel?.documents.some(d => d.key === key) || key === this.selected) return
    this.cancelResize?.()
    this.closeMenu()
    this.selected = key
    this.host.select(key)
    this.paint(true)
  }

  /**
   * Leave the reader. Toward the Desk or Chronicle the veil lifts and the page
   * sinks back as one motion before the pages park; toward the Board, whose
   * sheet wears the same veil, it goes at once.
   */
  hide(animate = false): void {
    this.cancelResize?.()
    this.active = false
    this.closeMenu()
    this.el.inert = true
    this.el.setAttribute('aria-hidden', 'true')
    cancelAnimationFrame(this.arrival)
    if (this.departure !== null) clearTimeout(this.departure)
    this.departure = null
    const settle = (): void => {
      this.departure = null
      this.host.parkAll()
      // Dormant first: it suspends transitions, so the veil resets without replaying.
      this.el.classList.add('ws-dormant')
      this.el.classList.remove('ws-departing')
    }
    this.el.classList.remove('ws-arriving', 'ws-veil-held')
    if (!animate || this.motion.matches || this.el.classList.contains('ws-dormant')) { settle(); return }
    this.el.classList.add('ws-departing')
    this.departure = setTimeout(settle, this.measure('veil-time', 180))
  }
  /** The veil fades in while the stage settles up; over the Board's veil only the stage moves. */
  private arrive(veilHeld: boolean): void {
    if (this.departure !== null) { clearTimeout(this.departure); this.departure = null }
    const fromRest = this.el.classList.contains('ws-dormant')
    this.el.classList.remove('ws-departing')
    if (!fromRest || this.motion.matches) { this.el.classList.remove('ws-dormant'); return }
    // Take the starting pose while dormant (no transitions), then wake and release it.
    this.el.classList.toggle('ws-veil-held', veilHeld)
    this.el.classList.add('ws-arriving')
    void this.el.offsetWidth
    this.el.classList.remove('ws-dormant')
    cancelAnimationFrame(this.arrival)
    this.arrival = requestAnimationFrame(() => {
      this.arrival = 0
      this.el.classList.remove('ws-arriving', 'ws-veil-held')
    })
  }

  private selectIndex(index: number): void {
    const doc = this.channel?.documents[index]
    if (doc) this.opts.onSelect(doc.key)
  }
  private step(delta: number): void {
    if (this.channel) this.selectIndex(this.channel.documents.findIndex(d => d.key === this.selected) + delta)
  }
  private paint(animate: boolean): void {
    const ch = this.channel
    if (!ch) return
    const index = ch.documents.findIndex(d => d.key === this.selected)
    ch.documents.forEach((doc, i) => {
      const frame = this.host.get(doc.key)
      if (!frame) return
      frame.el.classList.toggle('ws-before', i < index)
      frame.el.classList.toggle('ws-after', i > index)
      frame.el.classList.toggle('ws-expanded', doc.key === this.selected && this.expanded)
      this.fillLabel(frame, ch.labels[i])
    })
    this.tabs.mark(index, animate)
    this.position.textContent = `${index + 1} / ${ch.documents.length}`
    this.prev.disabled = index <= 0
    this.next.disabled = index >= ch.documents.length - 1
    const announcement = `${ch.labels[index]}, ${index + 1} of ${ch.documents.length}`
    if (this.announcement.textContent !== announcement) this.announcement.textContent = announcement
    this.layout(animate)
  }
  private prepareFrame(frame: DocumentFrame): void {
    frame.el.setAttribute('role', 'tabpanel')
    frame.el.setAttribute('aria-label', frame.doc.name)
    const glyph = element('span', 'ws-kind-glyph')
    const title = element('span', 'ws-label-title')
    const provenance = element('span', 'ws-provenance')
    const expand = button('ws-icon-button ws-expand-button', '⤢', () => this.toggleExpand(), 'Expand document')
    const menu = button('ws-icon-button ws-menu-button', '⋯', () => this.openMenu(frame.doc, menu), 'Document menu')
    frame.label.append(glyph, title, provenance, expand, menu)
    this.labels.set(frame, { glyph, title, provenance, expand })
    frame.label.addEventListener('dblclick', e => {
      if (!(e.target as Element).closest('button,a') && frame.doc.key === this.selected) this.toggleExpand()
    })
    for (const side of ['left', 'right'] as const) {
      const edge = element('div', `ws-edge ws-edge-${side}`)
      edge.addEventListener('pointerdown', e => this.resizeStart(e, frame, side))
      frame.el.append(edge)
    }
  }
  private fillLabel(frame: DocumentFrame, label: string): void {
    const doc = frame.doc
    const sent = doc.provenance.filter(p => p.kind === 'sent')
    const latest = sent.at(-1)
    const embed = doc.provenance.find(p => p.kind === 'embed')
    // Provenance reads in the mono register; the machine that sent it wears cobalt.
    const segments: Array<string | HTMLElement> = [doc.kind === 'fiber' ? 'fiber page' : embed ? 'embedded' : 'linked from body']
    if (latest?.kind === 'sent') {
      const age = Math.max(0, Math.round((Date.now() - latest.time) / 60000))
      segments[0] = `sent ${age < 60 ? `${age}m` : age < 1440 ? `${Math.floor(age / 60)}h` : `${Math.floor(age / 1440)}d`} ago`
      if (sent.length > 1) segments.push(`${sent.length} receipts`)
      const agent = latest.worker ?? this.agent
      if (agent) segments.push(element('span', 'ws-agent', agent))
    } else if (embed?.kind === 'embed' && embed.title) segments.push(embed.title)
    segments.push(doc.owner)
    const glyph = { fiber: '▤', html: '▣', pdf: '▧', image: '▨', text: '≡', other: '□' }[doc.kind]
    const parts = this.labels.get(frame)
    if (!parts) return
    const summary = segments.map(part => typeof part === 'string' ? part : part.textContent).join(' · ')
    parts.glyph.textContent = glyph
    parts.title.textContent = label
    parts.title.title = doc.path
    if (parts.provenance.title !== summary) {
      parts.provenance.replaceChildren(...segments.flatMap((part, i) => i ? [' · ', part] : [part]))
      parts.provenance.title = summary
    }
    parts.expand.textContent = this.expanded ? '⤡' : '⤢'
    parts.expand.setAttribute('aria-label', this.expanded ? 'Restore size' : 'Expand document')
  }

  private measure(name: string, fallback: number): number {
    return parseFloat(getComputedStyle(this.el).getPropertyValue(`--ws-${name}`)) || fallback
  }
  private preferredWidth(doc: WorkspaceDocument, max: number, height: number): number {
    if (this.phone.matches) return max
    const saved = this.sizes[doc.key]
    if (Number.isFinite(saved) && saved > 0) return Math.min(max, saved)
    let width = this.measure(doc.kind === 'html' ? 'html-width' : doc.kind === 'pdf' ? 'pdf-width' : 'prose-width', doc.kind === 'html' ? 1040 : doc.kind === 'pdf' ? 900 : 760)
    const img = this.host.get(doc.key)?.content.querySelector('img')
    if (doc.kind === 'image' && img?.naturalWidth && img.naturalHeight) width = Math.max(320, (height - this.measure('label-height', 40)) * img.naturalWidth / img.naturalHeight)
    return Math.min(max, width)
  }
  private layoutNavbar(): void {
    if (this.phone.matches) { this.navbar.style.removeProperty('grid-template-columns'); return }
    const style = getComputedStyle(this.navbar)
    const gap = parseFloat(style.columnGap) || 12
    const padLeft = parseFloat(style.paddingLeft) || 12
    const width = this.navbar.clientWidth - padLeft - (parseFloat(style.paddingRight) || 12)
    if (!width) return
    const lead = this.returnButton.offsetWidth + this.sidebarToggle.offsetWidth + 2 * gap + Math.min(280, Math.max(100, this.title.scrollWidth))
    const trail = this.conversation.offsetWidth
    const tabs = this.tabs.buttons.reduce((sum, b) => sum + b.offsetWidth, 0) + Math.max(0, this.tabs.buttons.length - 1) * 2 + 4
    // A fitting strip is centred over the stage, which starts after the sidebar;
    // a longer strip takes the remaining band, bounded by both controls.
    const sidebar = this.sidebarShown ? this.sidebar.offsetWidth : 0
    const centre = sidebar + (this.navbar.clientWidth - sidebar) / 2 - padLeft
    const leadBand = Math.floor(centre - tabs / 2 - gap)
    const trailBand = width - leadBand - tabs - 2 * gap
    this.navbar.style.gridTemplateColumns = leadBand >= lead && trailBand >= trail
      ? `${leadBand}px ${tabs}px minmax(0, 1fr)`
      : `${Math.min(lead, width * 0.32)}px minmax(0, 1fr) ${trail}px`
  }
  private layout(animate: boolean): void {
    this.layoutNavbar()
    const tabIndex = this.channel?.documents.findIndex(d => d.key === this.selected) ?? -1
    if (tabIndex >= 0) this.tabs.mark(tabIndex, animate)
    const ch = this.channel
    if (!ch || !this.active) return
    const W = this.stage.clientWidth, H = this.stage.clientHeight
    if (!W || !H) return
    const inset = this.measure('inset', 12), gap = this.measure('gap', 24)
    const boxW = W - inset * 2, boxH = H - inset * 2
    if (!animate || this.motion.matches) {
      this.stage.classList.add('ws-instant')
      void this.stage.offsetWidth
      cancelAnimationFrame(this.instantRaf)
      this.instantRaf = requestAnimationFrame(() => {
        this.instantRaf = requestAnimationFrame(() => this.stage.classList.remove('ws-instant'))
      })
    }
    let x = 0, centre = 0
    ch.documents.forEach(doc => {
      const f = this.host.get(doc.key)
      if (!f) return
      const sel = doc.key === this.selected
      const width = sel && this.expanded ? boxW : sel && this.liveWidth !== null ? this.liveWidth : this.preferredWidth(doc, boxW, boxH)
      f.el.style.left = `${x}px`
      f.el.style.width = `${width}px`
      f.el.style.height = `${boxH}px`
      if (sel) centre = x + width / 2
      x += width + gap
    })
    this.track.style.transform = `translateX(${Math.round(W / 2 - centre)}px)`
  }
  private readonly relayout = (): void => {
    this.renderSidebar()
    this.layout(false)
    const index = this.channel?.documents.findIndex(d => d.key === this.selected) ?? 0
    this.tabs.mark(index, false)
  }
  private toggleExpand(): void {
    this.cancelResize?.()
    this.expanded = !this.expanded
    this.paint(true)
  }
  private resizeStart(e: PointerEvent, frame: DocumentFrame, side: 'left' | 'right'): void {
    if (this.phone.matches || this.expanded || frame.doc.key !== this.selected || e.button !== 0) return
    e.preventDefault()
    this.cancelResize?.()
    const edge = e.currentTarget as HTMLElement
    edge.setPointerCapture(e.pointerId)
    const startX = e.clientX, width = frame.el.offsetWidth
    let latched = false
    this.stage.classList.add('ws-resizing')
    const move = (ev: PointerEvent): void => {
      const delta = (ev.clientX - startX) * (side === 'right' ? 1 : -1)
      if (!latched && Math.abs(delta) < this.measure('drag-latch', 4)) return
      latched = true
      this.liveWidth = Math.max(Math.min(320, this.stage.clientWidth - 24), Math.min(this.stage.clientWidth - 24, width + delta * 2))
      this.layout(false)
    }
    const finish = (commit: boolean): void => {
      edge.removeEventListener('pointermove', move)
      edge.removeEventListener('pointerup', up)
      edge.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      this.cancelResize = null
      if (commit && latched && this.liveWidth !== null) {
        this.sizes[frame.doc.key] = this.liveWidth
        try { sessionStorage.setItem('shuttle:workspace:sizes', JSON.stringify(this.sizes)) } catch { /* Storage is optional. */ }
      }
      this.liveWidth = null
      this.stage.classList.remove('ws-resizing')
      this.layout(false)
      if (edge.hasPointerCapture(e.pointerId)) edge.releasePointerCapture(e.pointerId)
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(false) }
    }
    this.cancelResize = cancel
    edge.addEventListener('pointermove', move)
    edge.addEventListener('pointerup', up)
    edge.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }

  private openMenu(doc: WorkspaceDocument, anchor: HTMLElement): void {
    const same = this.menuAnchor === anchor
    this.closeMenu()
    if (same) return
    const menu = element('div', 'ws-menu')
    menu.setAttribute('aria-label', 'Document actions')
    const url = doc.kind === 'fiber' ? window.location.href : fileBytesUrl(this.opts.shuttleBase, doc.path, doc.owner)
    for (const [label, download] of [['Open in new tab', false], ['Download', true]] as const) {
      const a = element('a', 'ws-menu-item', label)
      a.href = doc.kind === 'fiber' && download ? fileBytesUrl(this.opts.shuttleBase, doc.path, doc.owner) : url
      if (download) a.download = doc.name
      else { a.target = '_blank'; a.rel = 'noopener' }
      menu.append(a)
    }
    menu.append(button('ws-menu-item', 'Copy path', () => {
      void navigator.clipboard?.writeText(doc.path).then(() => showToast('Path copied')).catch(() => showToast('Couldn’t copy path', 'error'))
      this.closeMenu()
    }))
    menu.append(button('ws-menu-item', 'Refresh', () => { this.host.refresh(doc.key); this.closeMenu() }))
    const receipts = element('details', 'ws-receipts')
    const sends = doc.provenance.filter(p => p.kind === 'sent')
    receipts.append(element('summary', '', `Receipts (${sends.length})`))
    for (const p of [...sends].reverse()) {
      if (p.kind === 'sent') receipts.append(element('div', '', `${new Date(p.time).toLocaleString()} · ${p.worker ?? ''} · ${p.session ?? ''}`))
    }
    menu.append(receipts, element('code', 'ws-path', `${doc.owner}:${doc.path}`))
    this.el.append(menu)
    this.menu = menu
    this.menuAnchor = anchor
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(12, Math.min(window.innerWidth - menu.offsetWidth - 12, r.right - menu.offsetWidth))}px`
    menu.style.top = `${Math.max(12, r.top - menu.offsetHeight - 6)}px`
    if (this.keyboardInput) menu.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true })
  }
  private closeMenu(): boolean {
    if (!this.menu) return false
    this.menu.remove()
    this.menu = null
    this.menuAnchor = null
    this.switcher = false
    return true
  }
  private readonly pointerInput = (): void => { this.keyboardInput = false; this.el.classList.remove('ws-keyboard') }
  private readonly keyboardModality = (): void => { this.keyboardInput = true; this.el.classList.add('ws-keyboard') }
  private readonly outside = (e: PointerEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node) && !this.menuAnchor?.contains(e.target as Node)) this.closeMenu()
  }
  private channelList(filter = ''): HTMLElement {
    const list = element('div', 'ws-channel-list')
    for (const card of (this.opts.switcherCards?.() ?? this.opts.cards())) {
      if (!`${card.name} ${card.path}`.toLowerCase().includes(filter.toLowerCase())) continue
      const row = button('ws-channel-row', '', () => { this.closeMenu(); this.opts.onChannel(card) }, card.name)
      row.append(element('span', 'ws-channel-name', card.name))
      row.title = card.outcome ?? card.path
      row.setAttribute('aria-current', String((card.uid ?? card.id) === this.channel?.uid && card.originId === this.channel?.owner))
      row.append(element('small', '', card.originId))
      list.append(row)
    }
    return list
  }
  private openSwitcher(): void {
    if (this.sidebarShown) { this.sidebarFind.focus(); return }
    if (this.switcher) { this.closeMenu(); return }
    this.closeMenu()
    const menu = element('div', 'ws-menu ws-switcher')
    const find = element('input', 'ws-channel-find')
    find.placeholder = 'Find a constitution'
    find.setAttribute('aria-label', 'Find a constitution')
    let list = this.channelList()
    find.addEventListener('input', () => { const next = this.channelList(find.value); list.replaceWith(next); list = next })
    menu.append(find, list)
    this.el.append(menu)
    this.menu = menu
    this.menuAnchor = this.title
    this.switcher = true
    const rect = this.title.getBoundingClientRect()
    menu.style.left = `${Math.min(rect.left, Math.max(12, window.innerWidth - menu.offsetWidth - 12))}px`
    menu.style.top = `${rect.bottom + 6}px`
    find.focus()
  }
  /** Re-list the channel rows after the overview's order changes. */
  refreshChannels(): void {
    if (this.active && this.sidebarShown) this.fillSidebar()
  }
  private get sidebarShown(): boolean {
    return !this.phone.matches && (this.sidebarChoice ?? false)
  }
  private toggleSidebar(): void {
    this.sidebarChoice = !this.sidebarShown
    try { localStorage.setItem(SIDEBAR_STORAGE, String(this.sidebarChoice)) } catch { /* Storage is optional. */ }
    this.closeMenu()
    this.renderSidebar(); this.layout(false)
  }
  private renderSidebar(): void {
    const shown = this.sidebarShown
    this.el.classList.toggle('ws-with-sidebar', shown)
    this.sidebarToggle.setAttribute('aria-expanded', String(shown))
    this.sidebarToggle.setAttribute('aria-label', shown ? 'Hide constitutions' : 'Show constitutions')
    this.sidebar.inert = !shown
    if (shown) this.fillSidebar()
  }
  /** Rows refresh in place; the list keeps its scroll and the find its text. */
  private fillSidebar(): void {
    const top = this.sidebarList.scrollTop
    const next = this.channelList(this.sidebarFind.value)
    this.sidebarList.replaceWith(next)
    this.sidebarList = next
    next.scrollTop = top
    const current = next.querySelector<HTMLElement>('[aria-current="true"]')
    if (current && (current.offsetTop < next.scrollTop || current.offsetTop + current.offsetHeight > next.scrollTop + next.clientHeight)) {
      next.scrollTop = Math.max(0, current.offsetTop - next.clientHeight / 3)
    }
  }
  private readonly keydown = (e: KeyboardEvent): void => {
    this.keyboardModality()
    if (!this.active || e.isComposing || e.defaultPrevented || blockingDialogOpen()) return
    // Native controls own activation and composite navigation; the managed tablist uses our shared intents.
    if (!this.tabs.el.contains(e.target as Node) && !shouldForwardDocumentKey(e) && !e.altKey && !e.metaKey && !e.ctrlKey) return
    const intent = keyIntent(e, 'reader')
    if (intent && this.handleIntent(intent, e.repeat)) {
      e.preventDefault(); e.stopImmediatePropagation()
    }
  }
  private handleIntent(intent: KeyIntent, repeat = false): boolean {
    if (intent === 'help') return false
    if (intent === 'back') {
      if (this.cancelResize) this.cancelResize()
      else if (this.menu) { const anchor = this.menuAnchor; this.closeMenu(); anchor?.focus({ preventScroll: true }) }
      else if (this.opts.onEscapeLayer?.()) { /* An inline control popover consumed Escape. */ }
      else if (this.expanded) this.toggleExpand()
      else this.opts.onReturn()
      return true
    }
    if (this.tabs.handleIntent(intent)) return true
    if (intent === 'sidebar') this.toggleSidebar()
    else if (intent === 'prev' || intent === 'next') this.step(intent === 'prev' ? -1 : 1)
    else if (intent === 'first' || intent === 'last') this.selectIndex(intent === 'first' ? 0 : (this.channel?.documents.length ?? 1) - 1)
    else if (intent === 'open') this.toggleExpand()
    else if (intent === 'prevChannel' || intent === 'nextChannel') {
      const cards = this.opts.switcherCards?.() ?? this.opts.cards()
      const index = cards.findIndex(c => (c.uid ?? c.id) === this.channel?.uid && c.originId === this.channel?.owner)
      const card = cards[index + (intent === 'prevChannel' ? -1 : 1)]
      if (index >= 0 && card) this.opts.onChannel(card)
    } else if (['scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp'].includes(intent)) this.scrollDocument(intent, repeat)
    else return false
    return true
  }

  private scrollDocument(intent: KeyIntent, repeat: boolean): void {
    const doc = this.document
    const viewer = doc && this.host.get(doc.key)?.viewer
    if (!doc || !viewer || !['fiber', 'html', 'markdown', 'text', 'code'].includes(doc.kind)) return
    let scroller = viewer.querySelector<HTMLElement>('.ws-prose-scroll,.kbn-fileview-text')
    if (doc.kind === 'fiber') scroller = viewer.matches('.ws-prose-scroll') ? viewer : scroller
    if (doc.kind === 'html') {
      try {
        const frame = viewer.querySelector('iframe')
        const content = frame?.contentDocument
        if (!content) return
        const root = content.scrollingElement as HTMLElement | null
        const nested = [...content.querySelectorAll<HTMLElement>('body *')].filter(el =>
          el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(content.defaultView!.getComputedStyle(el).overflowY))
        scroller = root && root.scrollHeight > root.clientHeight + 1 ? root
          : nested.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
      } catch { return }
    }
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return
    const up = ['scrollUp', 'halfUp', 'pageUp'].includes(intent)
    const line = parseFloat(scroller.ownerDocument.defaultView?.getComputedStyle(scroller).lineHeight ?? '') || 24
    const amount = intent.startsWith('half') ? scroller.clientHeight / 2 : intent.startsWith('page') ? scroller.clientHeight : 3 * line
    scroller.scrollBy?.({ top: (up ? -1 : 1) * amount, behavior: this.motion.matches || repeat ? 'instant' : 'smooth' })
  }
  dispose(): void {
    this.cancelResize?.()
    this.closeMenu()
    this.observer?.disconnect()
    window.removeEventListener('resize', this.relayout)
    cancelAnimationFrame(this.instantRaf)
    cancelAnimationFrame(this.arrival)
    if (this.departure !== null) clearTimeout(this.departure)
    this.wide.removeEventListener('change', this.relayout)
    this.tabs.dispose()
    this.host.dispose()
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    document.removeEventListener('pointerdown', this.pointerInput, true)
    this.motion.removeEventListener('change', this.relayout)
    this.phone.removeEventListener('change', this.relayout)
    this.el.remove()
  }
}
