import './tokens.css'
import './reader.css'
import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { fiberPageColumn } from './fiberPageState.js'
import { keyIntent, shouldForwardDocumentKey, type KeyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { fileBytesUrl, showToast } from '../utils.js'
import { DocumentHost, type DocumentFrame } from './DocumentHost.js'
import { scrollHtmlViewer } from './DocumentBridge.js'
import { documentLabels, documentLabelMetadata, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'
import { TabStrip } from './TabStrip.js'
import { DocumentSeen } from './DocumentSeen.js'
import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'
import type { ChannelThemes } from './ChannelThemes.js'
import { buildCardPaper } from '../KanbanSurfaces.js'
import { overviewHostMarks } from './Overview.js'
import { SidebarFlight, type SidebarEntry } from './SidebarFlight.js'
import { workspaceMeasure } from './measures.js'
import { workerPlate } from './workerPlate.js'
import { ReceiptArrivals } from './receiptMotion.js'
import { installBarSwipe, PhoneTopbar } from './PhoneGestures.js'
import { PageSheet } from './PageSheet.js'

export interface ReaderOptions {
  shuttleBase: string
  themes?: ChannelThemes
  buildProse(doc: WorkspaceDocument): HTMLElement
  onRefreshProse(doc: WorkspaceDocument): void | Promise<void>
  onSelect(key: DocKey): void
  onCrossing?(travel: number): void
  onReturn(): void
  workerPill?(card: KanbanCard): HTMLElement | null
  verdictPlate?(card: KanbanCard): HTMLElement
  onVerdict?(verdict: 'tempered' | 'composted'): void
  onCompose?(): void
  onConversation?(card: KanbanCard): void
  onEscapeLayer?(): boolean
  onChannel(card: KanbanCard): void
  cards(): KanbanCard[]
  /** The sidebar's order, shared by every constitution-stepping binding. */
  switcherCards?(): KanbanCard[]
  pickerCards?(): KanbanCard[]
  sidebarBand?(card: KanbanCard): string | undefined
  files?(card: KanbanCard): string[]
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

/** The viewport at which the desktop sidebar defaults open. */
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
  private readonly parallax = element('div', 'ws-parallax')
  private trackX = 0
  readonly host: DocumentHost
  private readonly opts: ReaderOptions
  private readonly stopTitles: () => void
  private readonly seen = new DocumentSeen()
  private readonly receipts = new ReceiptArrivals()
  private channelReady = false
  private readonly tabs: TabStrip
  private readonly navbar: HTMLElement
  private readonly lead: HTMLElement
  private readonly trail: HTMLElement
  private keyboardInput = false
  private readonly themeChanged = (): void => this.syncPlainToggle()
  private readonly title: HTMLButtonElement
  private readonly returnButton: HTMLButtonElement
  private readonly conversation = element('div', 'ws-worker-pill')
  private readonly position = element('span', 'ws-position')
  private readonly pageTitle = element('span', 'ws-thumb-title')
  private readonly arrivalSummary = element('span', 'ws-thumb-arrival')
  private readonly topbar = new PhoneTopbar(hidden => this.el.classList.toggle('ws-topbar-hidden', this.phone.matches && hidden))
  private readonly stopSwipe: () => void
  private readonly pageSheet: PageSheet
  private readonly announcement = element('div', 'ws-sr-only')
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly observer: ResizeObserver | null
  private readonly labels = new WeakMap<DocumentFrame, { glyph: HTMLElement; title: HTMLElement; provenance: HTMLElement; expand: HTMLButtonElement }>()
  private channel: Channel | null = null
  private currentCard: KanbanCard | null = null
  private selected: DocKey | null = null
  private expanded = false
  private active = false
  private menu: HTMLElement | null = null
  private menuAnchor: HTMLElement | null = null
  private sidebar = element('aside', 'ws-sidebar')
  private readonly sidebarPicker: ConstitutionPicker
  private readonly picker: ConstitutionPicker
  private readonly sidebarFlight: SidebarFlight
  private readonly sidebarRows = new Map<HTMLElement, KanbanCard>()
  private readonly flightRoots = new Set<HTMLElement>()
  /** The persisted choice; absent, desktop widths of at least 1280 px show the column. */
  private sidebarChoice: boolean | null = null
  private readonly sidebarToggle: HTMLButtonElement
  private readonly wide = window.matchMedia(SIDEBAR_MEDIA)
  private liveWidth: number | null = null
  private cancelResize: (() => void) | null = null
  private instantRaf = 0
  private sizes: Record<string, number> = {}
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly phone = window.matchMedia(MOBILE_MEDIA)
  private readonly workerClock: number

  constructor(opts: ReaderOptions) {
    this.opts = opts
    this.workerClock = window.setInterval(() => { if (this.active) { this.paintWorker(); this.layoutNavbar() } }, 30000)
    this.stopTitles = watchDocumentTitles(key => {
      const ch = this.channel
      if (!ch?.documents.some(d => d.key === key)) return
      ch.labels = documentLabels(ch.documents, ch.labels[0] === 'Constitution')
      this.tabs.render(ch.labels, ch.documents.map(d => d.key), ch)
      if (this.active) this.paint(false)
    })
    this.el.setAttribute('aria-label', 'Document reader')
    this.el.dataset.wsThemeBoundary = ''
    this.veil.dataset.part = 'veil'
    this.conversation.dataset.part = 'act'
    this.el.inert = true
    this.tabs = new TabStrip(i => this.selectIndex(i), () => this.toggleExpand(), {
      shuttleBase: opts.shuttleBase,
      onHeight: height => this.el.style.setProperty('--ws-strip-h', `${height}px`),
    })
    this.returnButton = button('ws-return', '‹ Desk', () => opts.onReturn())
    this.title = button('ws-channel-title', '', () => this.openSwitcher())
    this.sidebarToggle = button('ws-sidebar-toggle', '▥ Constitutions', () => this.toggleSidebar(), 'Constitutions')
    this.sidebarToggle.title = 'Constitutions (⌘\\)'
    this.lead = element('div', 'ws-nav-lead')
    this.lead.dataset.part = 'chrome-plate'
    this.lead.append(this.returnButton, this.sidebarToggle, this.title)
    this.trail = element('div', 'ws-nav-trail')
    this.trail.append(this.conversation)
    this.navbar = element('nav', 'ws-navbar')
    this.navbar.dataset.part = 'phone-topbar'
    const tabPlate = element('div', 'ws-nav-tabs')
    tabPlate.dataset.part = 'chrome-plate'
    tabPlate.append(this.tabs.el)
    this.navbar.append(this.lead, tabPlate, this.trail)
    this.prev = button('ws-thumb-button', '‹', () => this.step(-1), 'Previous document')
    this.next = button('ws-thumb-button', '›', () => this.step(1), 'Next document')
    const thumbMenu = button('ws-thumb-button', '⋯', () => {
      const doc = this.document
      if (doc) this.openMenu(doc, thumbMenu)
    }, 'Document menu')
    const thumb = element('div', 'ws-thumbbar')
    thumb.dataset.part = 'phone-bottom-bar'
    this.pageSheet = new PageSheet(opts.shuttleBase, key => this.opts.onSelect(key))
    const pageChoice = button('ws-page-choice', '', () => { this.closeMenu(); this.pageSheet.show(pageChoice) }, 'Choose a page')
    pageChoice.setAttribute('aria-haspopup', 'dialog')
    pageChoice.setAttribute('aria-expanded', 'false')
    pageChoice.append(this.pageTitle, this.arrivalSummary, this.position)
    thumb.append(this.prev, pageChoice, this.next, thumbMenu)
    this.stopSwipe = installBarSwipe(thumb, () => this.active && this.phone.matches, delta => this.step(delta))
    this.announcement.setAttribute('aria-live', 'polite')
    this.announcement.setAttribute('aria-atomic', 'true')
    this.parallax.append(this.track)
    this.stage.append(this.parallax)
    this.sidebar.setAttribute('aria-label', 'Constitutions')
    const withCurrent = (cards: KanbanCard[]): KanbanCard[] => {
      const current = this.currentCard
      return current && !cards.some(card => (card.uid ?? card.id) === (current.uid ?? current.id) && card.originId === current.originId) ? [...cards, current] : cards
    }
    const sidebarCards = (): KanbanCard[] => withCurrent(this.opts.switcherCards?.() ?? this.opts.cards())
    const pickerOptions = {
      cards: () => withCurrent(this.opts.pickerCards?.() ?? sidebarCards()),
      files: opts.files,
      current: (card: KanbanCard) => (card.uid ?? card.id) === this.channel?.uid && card.originId === this.channel?.owner,
      onOpen: (card: KanbanCard) => { this.closeMenu(); this.opts.onChannel(card) },
    }
    this.sidebarPicker = new ConstitutionPicker({
      ...pickerOptions, cards: sidebarCards, revealCurrent: true,
      renderCard: card => this.sidebarCard(card), group: opts.sidebarBand,
      onRow: (el, card) => {
        this.sidebarRows.set(el, card)
        if (this.active && this.sidebarShown) this.opts.themes?.bind(el, card)
        else this.opts.themes?.unbind(el)
      },
      onRemove: el => { this.sidebarRows.delete(el); this.opts.themes?.unbind(el) },
    })
    this.sidebarFlight = new SidebarFlight(this.el, this.sidebar)
    this.picker = new ConstitutionPicker(pickerOptions)
    this.sidebarPicker.el.style.display = 'contents'
    this.sidebar.append(this.sidebarPicker.el)
    const main = element('div', 'ws-stage-row')
    main.append(this.sidebar, this.stage)
    this.el.append(this.veil, this.navbar, main, thumb, this.announcement, this.pageSheet.el)
    this.host = new DocumentHost(this.track, {
      shuttleBase: opts.shuttleBase,
      buildProse: opts.buildProse,
      onRefreshProse: opts.onRefreshProse,
      onSelect: key => opts.onSelect(key),
      onFrame: frame => this.prepareFrame(frame),
      onScroll: (key, y) => this.topbar.scroll(key, y),
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
    this.el.addEventListener('workspace-theme-change', this.themeChanged)
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

  show(channel: Channel, selected: DocKey, origin = 'Desk', card?: KanbanCard, animate = true, ready = true): void {
    const switching = channel.uid !== this.channel?.uid || channel.owner !== this.channel?.owner || !this.active
    if (switching) { this.cancelResize?.(); this.expanded = false; this.closeMenu(); this.pageSheet.hide() }
    const arrivals = this.receipts.observe(channel, ready)
    const reordered = this.selected === selected && this.channel?.documents.map(d => d.key).join('\0') !== channel.documents.map(d => d.key).join('\0')
    this.channelReady = ready
    this.channel = channel
    this.currentCard = card ?? this.opts.cards().find(row => (row.uid ?? row.id) === channel.uid && row.originId === channel.owner) ?? null
    this.selected = selected
    if (this.currentCard) this.opts.themes?.bind(this.el, this.currentCard, 'reader')
    const arriving = !this.active
    this.active = true
    if (arriving) this.arrive(origin === 'Board')
    this.el.inert = false
    this.el.removeAttribute('aria-hidden')
    this.returnButton.textContent = `‹ ${origin}`
    this.returnButton.setAttribute('aria-label', `Return to ${origin}`)
    this.title.textContent = channel.name
    this.title.title = channel.name
    this.paintWorker()
    this.tabs.setVisible(true)
    this.tabs.render(channel.labels, channel.documents.map(d => d.key), channel)
    if (!switching) this.tabs.arrive(arrivals)
    this.host.setChannel(channel.documents, selected)
    this.paint(!switching && !reordered && animate)
    this.renderSidebar()
    if (arriving) this.setSidebarVisible(this.sidebarShown)
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
    this.setSidebarVisible(false, animate)
    this.active = false
    this.sidebarPicker.refresh(false)
    this.opts.themes?.unbind(this.el)
    this.pageSheet.hide()
    this.tabs.setVisible(false)
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
    this.departure = setTimeout(settle, this.measure('crossing', 280))
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
  private paintWorker(): void {
    const card = this.currentCard
    const review = !!card && !hasLiveWorker(card) && fiberPageColumn(card) === 'awaitingReview' && this.document?.kind !== 'fiber'
    const control = card ? review ? this.opts.verdictPlate?.(card) : workerPlate(card, this.opts.workerPill?.(card) ?? null) : null
    const focused = this.conversation.contains(document.activeElement)
      ? document.activeElement?.matches('.kbn-ctl-temper') ? '.kbn-ctl-temper'
        : document.activeElement?.matches('.kbn-ctl-discard') ? '.kbn-ctl-discard' : '.kbn-card-worker' : null
    this.conversation.classList.toggle('ws-worker-review', review)
    this.conversation.dataset.act = review ? 'verdict' : 'worker'
    this.conversation.replaceChildren(...(control ? [control] : []))
    if (focused) this.conversation.querySelector<HTMLElement>(focused)?.focus({ preventScroll: true })
  }
  private paint(animate: boolean): void {
    this.paintWorker()
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
    this.tabs.setCompact(this.expanded)
    const fresh = this.seen.observe(ch, this.selected ?? '', this.channelReady)
    this.tabs.fresh(fresh)
    this.pageSheet.update(ch, this.selected ?? '', fresh)
    this.tabs.mark(index, animate)
    this.position.textContent = `${index + 1} / ${ch.documents.length}`
    const doc = ch.documents[index]
    if (doc) {
      const metadata = documentLabelMetadata(doc, ch.labels[index], ch.owner)
      this.pageTitle.textContent = doc.kind === 'fiber' ? ch.labels[index] : metadata.title
      this.arrivalSummary.textContent = metadata.summary
      this.topbar.select(doc.key)
    }
    this.prev.disabled = index <= 0
    this.next.disabled = index >= ch.documents.length - 1
    const announcement = `${ch.labels[index]}, ${index + 1} of ${ch.documents.length}`
    if (this.announcement.textContent !== announcement) this.announcement.textContent = announcement
    this.layout(animate)
  }
  private prepareFrame(frame: DocumentFrame): void {
    frame.el.classList.toggle('ws-text-page', ['fiber', 'text', 'markdown', 'code'].includes(frame.doc.kind))
    frame.el.classList.toggle('ws-native-page', ['audio', 'video', 'pdf'].includes(frame.doc.kind))
    if (frame.doc.kind === 'audio' || frame.doc.kind === 'video') frame.el.classList.add('ws-media-page')
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
    const metadata = documentLabelMetadata(doc, label, this.channel?.owner ?? doc.owner)
    const glyph = { fiber: '▤', html: '▣', pdf: '▧', image: '▨', audio: '♪', video: '▹', text: '≡', other: '□' }[doc.kind]
    const parts = this.labels.get(frame)
    if (!parts) return
    parts.glyph.hidden = doc.kind === 'fiber'
    parts.glyph.textContent = doc.kind === 'fiber' ? '' : glyph
    parts.title.hidden = doc.kind === 'fiber'
    parts.title.textContent = metadata.title
    parts.title.title = doc.path
    parts.title.classList.toggle('ws-declared-title', !!declaredTitle(doc.key)?.title || doc.provenance.some(p => p.kind === 'embed' && p.title))
    if (parts.provenance.title !== metadata.summary) {
      parts.provenance.textContent = metadata.summary
      parts.provenance.title = metadata.summary
    }
    parts.expand.textContent = this.expanded ? '⤡' : '⤢'
    parts.expand.setAttribute('aria-label', this.expanded ? 'Restore size' : 'Expand document')
  }

  private measure(name: string, fallback: number): number {
    return workspaceMeasure(this.el, name, fallback)
  }
  private preferredWidth(doc: WorkspaceDocument, max: number, height: number): number {
    if (this.phone.matches) return max
    const saved = this.sizes[doc.key]
    if (Number.isFinite(saved) && saved > 0) return Math.min(max, saved)
    let width = this.measure(doc.kind === 'html' ? 'html-width' : doc.kind === 'pdf' ? 'pdf-width' : 'prose-width', doc.kind === 'html' ? 1040 : doc.kind === 'pdf' ? 900 : 760)
    const content = this.host.get(doc.key)?.content
    const img = content?.querySelector('img')
    if (doc.kind === 'image' && img?.naturalWidth && img.naturalHeight) width = Math.max(320, (height - this.measure('label-height', 40)) * img.naturalWidth / img.naturalHeight)
    const video = content?.querySelector('video')
    if (doc.kind === 'video' && video?.videoWidth && video.videoHeight) width = Math.max(320, (height - 180) * video.videoWidth / video.videoHeight)
    return Math.min(max, width)
  }
  private layoutNavbar(): void {
    if (this.phone.matches) {
      this.navbar.style.removeProperty('grid-template-columns')
      this.el.style.setProperty('--ws-phone-bar-height', `${this.navbar.offsetHeight}px`)
      return
    }
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
    const inset = this.measure('stage-inset', 28), gap = this.measure('gap', 24)
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
    const target = Math.round(W / 2 - centre)
    if (animate && !this.motion.matches && target !== this.trackX) this.opts.onCrossing?.(target - this.trackX)
    this.trackX = target
    this.track.style.transform = `translateX(${target}px)`
    // Fade the visible margin, not an outer edge already clipped off-screen.
    for (const doc of ch.documents) {
      const frame = this.host.get(doc.key)
      if (!frame || doc.key === this.selected) continue
      const width = parseFloat(frame.el.style.width)
      const before = frame.el.classList.contains('ws-before')
      const scale = this.measure('receded-scale', 0.94)
      const left = target + parseFloat(frame.el.style.left) + (before ? width * (1 - scale) : 0)
      const right = left + width * scale
      const visible = Math.max(0, Math.min(W, right) - Math.max(0, left))
      const edge = Math.min(100, Math.max(0, before ? -left : right - W) / (width * scale) * 100)
      const end = Math.min(100, edge + visible / (width * scale) * this.measure('neighbour-fade', 45))
      frame.el.style.setProperty('--ws-neighbour-edge', `${edge}%`)
      frame.el.style.setProperty('--ws-neighbour-fade-end', `${end}%`)
    }
  }
  private readonly relayout = (): void => {
    if (!this.phone.matches) { this.pageSheet.close(); this.el.classList.remove('ws-topbar-hidden') }
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
    menu.setAttribute('aria-label', 'Document and constitution actions')
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
    menu.append(receipts)
    if (this.currentCard && this.opts.themes) {
      const plain = button('ws-menu-item ws-plain-toggle', "Plain (drop this constitution's theme)", () => {
        if (!this.currentCard) return
        this.opts.themes!.togglePlain(this.currentCard)
        this.syncPlainToggle(plain)
      }, "Plain (drop this constitution's theme)")
      plain.dataset.part = 'plain-toggle'
      this.syncPlainToggle(plain)
      menu.append(plain)
    }
    menu.append(element('code', 'ws-path', `${doc.owner}:${doc.path}`))
    this.el.append(menu)
    this.menu = menu
    this.menuAnchor = anchor
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(12, Math.min(window.innerWidth - menu.offsetWidth - 12, r.right - menu.offsetWidth))}px`
    menu.style.top = `${Math.max(12, r.top - menu.offsetHeight - 6)}px`
    if (this.keyboardInput) menu.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true })
  }
  private syncPlainToggle(item?: HTMLButtonElement): void {
    const toggle = item ?? this.menu?.querySelector<HTMLButtonElement>('[data-part="plain-toggle"]')
    const card = this.currentCard
    const themes = this.opts.themes
    if (!toggle || !themes) return
    toggle.hidden = !card || !themes.hasTheme(card)
    toggle.setAttribute('aria-pressed', String(!!card && themes.isPlain(card)))
  }
  private closeMenu(): boolean {
    if (this.picker.isOpen) { this.picker.close(); return true }
    if (!this.menu) return false
    this.menu.remove()
    this.menu = null
    this.menuAnchor = null
    return true
  }
  private readonly pointerInput = (): void => { this.keyboardInput = false; this.el.classList.remove('ws-keyboard') }
  private readonly keyboardModality = (): void => { this.keyboardInput = true; this.el.classList.add('ws-keyboard') }
  private readonly outside = (e: PointerEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node) && !this.menuAnchor?.contains(e.target as Node)) this.closeMenu()
  }
  private openSwitcher(): void {
    if (this.sidebarShown) { this.sidebarPicker.focus(); return }
    if (this.picker.isOpen) { this.picker.close(); return }
    this.closeMenu()
    this.picker.show(this.el, this.title)
  }
  /** The source column is captured before the live Desk starts receding. */
  captureSidebar(entries: SidebarEntry[]): void { this.sidebarFlight.capture(entries) }
  private sidebarCard(card: KanbanCard): HTMLElement {
    const face = buildCardPaper(card)
    face.classList.add('ws-constitution-card')
    face.dataset.part = 'sidebar-card'
    face.dataset.wsThemeBoundary = ''
    face.querySelector('.kbn-card-name')?.classList.add('ws-channel-name')
    const meta = element('div', 'kbn-card-meta')
    const host = element('small', 'ws-channel-owner')
    const marks = overviewHostMarks(this.opts.cards().map(row => row.originId).concat(card.originId))
    host.textContent = `${marks.get(card.originId) ?? '○'} ${card.originId}`
    host.title = card.originId
    meta.append(host)
    const pill = this.opts.workerPill?.(card)
    if (pill) {
      pill.dataset.part = 'act'; pill.dataset.act = 'worker'
      meta.append(workerPlate(card, pill))
    }
    face.append(meta)
    return face
  }
  /** Re-list the channel rows after the overview's order changes. */
  refreshChannels(): void {
    if (this.active && this.sidebarShown) this.fillSidebar()
    if (this.active && this.picker.isOpen) this.picker.refresh()
  }
  private get sidebarShown(): boolean {
    return !this.phone.matches && (this.sidebarChoice ?? this.wide.matches)
  }
  private toggleSidebar(): void {
    this.sidebarChoice = !this.sidebarShown
    try { localStorage.setItem(SIDEBAR_STORAGE, String(this.sidebarChoice)) } catch { /* Storage is optional. */ }
    this.closeMenu()
    if (!this.sidebarShown) this.setSidebarVisible(false)
    this.renderSidebar(); this.layout(false)
    if (this.sidebarShown) this.setSidebarVisible(true)
  }
  private renderSidebar(): void {
    const shown = this.sidebarShown
    this.el.classList.toggle('ws-with-sidebar', shown)
    this.sidebarToggle.setAttribute('aria-expanded', String(shown))
    this.sidebarToggle.setAttribute('aria-label', shown ? 'Hide constitutions' : 'Show constitutions')
    this.sidebar.inert = !shown
    this.sidebarPicker.refresh(shown)
    this.sidebarFlight.refresh()
    if (!shown) this.setSidebarVisible(false, false)
  }
  /** Travelling copies keep their channel's stylesheet until their own flight ends. */
  private setSidebarVisible(visible: boolean, animate = true): void {
    this.sidebarFlight.setVisible(visible, animate)
    if (!this.opts.themes) return
    for (const ghost of this.el.querySelectorAll<HTMLElement>('.ws-sidebar-flight .ws-channel-row')) {
      if (this.flightRoots.has(ghost)) continue
      const card = [...this.sidebarRows.values()].find(card => (card.uid ?? card.id) === ghost.dataset.channelUid && card.originId === ghost.dataset.channelOwner)
      if (!card) continue
      this.flightRoots.add(ghost); this.opts.themes.bind(ghost, card)
      const flights = ghost.getAnimations().filter(animation => !('animationName' in animation) && !('transitionProperty' in animation))
      void Promise.allSettled(flights.map(animation => animation.finished)).then(() => {
        if (this.flightRoots.delete(ghost)) this.opts.themes?.unbind(ghost)
      })
    }
  }
  /** Rows refresh in place; the list keeps its scroll and the find its text. */
  private fillSidebar(): void {
    this.sidebarPicker.refresh(this.sidebarShown)
  }
  private readonly keydown = (e: KeyboardEvent): void => {
    if (this.pageSheet.isOpen) return
    this.keyboardModality()
    if (!this.active || e.isComposing || e.defaultPrevented || blockingDialogOpen()) return
    if ((e.key === 'Enter' || e.key === 'Escape') && (this.picker.el.contains(e.target as Node) || this.sidebarPicker.el.contains(e.target as Node))) return
    // Alt chords never bypass editable/native control guards; command shortcuts may.
    const forward = shouldForwardDocumentKey(e)
    if (e.altKey && !forward) return
    // Native controls own activation and composite navigation; the managed tablist uses our shared intents.
    if (!this.tabs.el.contains(e.target as Node) && !forward && !e.metaKey && !e.ctrlKey) return
    const intent = keyIntent(e, 'reader')
    if (intent && this.handleIntent(intent, e.repeat)) {
      e.preventDefault(); e.stopImmediatePropagation()
    }
  }
  private handleIntent(intent: KeyIntent, repeat = false): boolean {
    if (intent === 'help') return false
    if (intent === 'back') {
      if (this.cancelResize) this.cancelResize()
      else if (this.picker.isOpen) this.picker.close(true)
      else if (this.menu) { const anchor = this.menuAnchor; this.closeMenu(); anchor?.focus({ preventScroll: true }) }
      else if (this.opts.onEscapeLayer?.()) { /* An inline control popover consumed Escape. */ }
      else if (this.expanded) this.toggleExpand()
      else this.opts.onReturn()
      return true
    }
    if (this.tabs.handleIntent(intent)) return true
    if (intent === 'temper' || intent === 'discard') {
      if (!this.currentCard || fiberPageColumn(this.currentCard) !== 'awaitingReview') return false
      this.opts.onVerdict?.(intent === 'temper' ? 'tempered' : 'composted')
    }
    else if (intent === 'compose') this.opts.onCompose?.()
    else if (intent === 'conversation') {
      if (this.currentCard) this.opts.onConversation?.(this.currentCard)
    }
    else if (intent === 'sidebar') this.toggleSidebar()
    else if (intent === 'find') {
      if (this.sidebarShown) this.sidebarPicker.focus()
      else if (this.picker.isOpen) this.picker.focus()
      else this.openSwitcher()
    }
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
      scrollHtmlViewer(viewer, intent, this.motion.matches || repeat)
      return
    }
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) return
    const up = ['scrollUp', 'halfUp', 'pageUp'].includes(intent)
    const line = parseFloat(scroller.ownerDocument.defaultView?.getComputedStyle(scroller).lineHeight ?? '') || 24
    const amount = intent.startsWith('half') ? scroller.clientHeight / 2 : intent.startsWith('page') ? scroller.clientHeight : 3 * line
    scroller.scrollBy?.({ top: (up ? -1 : 1) * amount, behavior: this.motion.matches || repeat ? 'instant' : 'smooth' })
  }
  dispose(): void {
    this.opts.themes?.unbind(this.el)
    this.cancelResize?.()
    this.closeMenu()
    this.stopSwipe()
    this.pageSheet.dispose()
    this.observer?.disconnect()
    window.clearInterval(this.workerClock)
    window.removeEventListener('resize', this.relayout)
    cancelAnimationFrame(this.instantRaf)
    cancelAnimationFrame(this.arrival)
    if (this.departure !== null) clearTimeout(this.departure)
    this.wide.removeEventListener('change', this.relayout)
    this.stopTitles()
    this.tabs.dispose()
    this.picker.dispose()
    this.sidebarPicker.dispose()
    for (const ghost of this.flightRoots) this.opts.themes?.unbind(ghost)
    this.flightRoots.clear()
    this.sidebarFlight.dispose()
    this.host.dispose()
    document.removeEventListener('keydown', this.keydown, true)
    document.removeEventListener('pointerdown', this.outside)
    document.removeEventListener('pointerdown', this.pointerInput, true)
    this.motion.removeEventListener('change', this.relayout)
    this.phone.removeEventListener('change', this.relayout)
    this.el.removeEventListener('workspace-theme-change', this.themeChanged)
    this.el.remove()
  }
}
