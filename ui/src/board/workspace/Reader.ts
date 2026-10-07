import './tokens.css'
import './reader.css'
import type { KanbanCard } from '../KanbanTypes.js'
import { onDesk, verdictReachable } from './fiberPageState.js'
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
import { cardIdentity, SidebarFlight, type SidebarEntry } from './SidebarFlight.js'
import { groupJump } from './groupJump.js'
import { workspaceMeasure } from './measures.js'
import { workerPlate } from './workerPlate.js'
import { ReceiptArrivals } from './receiptMotion.js'
import { installPageSwipe, PhoneTopbar, SWIPE, swipeFollow, swipeOutcome, swipeSettleTime, type SwipeSignal } from './PhoneGestures.js'
import { PageSheet } from './PageSheet.js'
import { anchorPopover, type Release } from './anchoredPopover.js'

export interface ReaderOptions {
  shuttleBase: string
  themes?: ChannelThemes
  buildProse(doc: WorkspaceDocument): HTMLElement
  onRefreshProse(doc: WorkspaceDocument): void | Promise<void>
  onSelect(key: DocKey): void
  onCrossing?(travel: number): void
  onReturn(): void
  workerPill?(card: KanbanCard): HTMLElement | null
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
  /** The board bar's Find field: on the desktop it filters the open sidebar. */
  find?: HTMLInputElement
  /** Summon the board bar's Find (desktop), in place of the phone's switcher. */
  onFind?(): boolean
  /** Expand has taken, or given back, the whole window. */
  onExpand?(expanded: boolean): void
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
const SIDEBAR_WIDTH_STORAGE = 'shuttle:workspace:sidebar-width'
/** One arrow press resizes the sidebar by this much; with Shift, four times as much. */
const SIDEBAR_STEP = 16
/** A latched swipe that neither moves nor releases for this long has lost its release. */
const SWIPE_QUIET = 500
/** Anything a click outside dismisses: anchored lists and menus, the switcher, the conversation menu. */
const POPOVERS = '[data-anchored], .ws-menu, .ws-switcher, .kbn-conversation-menu'

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
  /** Whether the channel's run is final: the strip, ticks, count and steps wait for it. */
  private runSettled = true
  private readonly tabs: TabStrip
  private readonly navbar: HTMLElement
  private readonly lead: HTMLElement
  private keyboardInput = false
  private readonly themeChanged = (): void => this.syncPlainToggle()
  private readonly title: HTMLButtonElement
  private readonly returnButton: HTMLButtonElement
  private readonly position = element('span', 'ws-position')
  /** The page count the board bar carries before its settings, on the desktop. */
  readonly barPosition = element('span', 'ws-position ws-head-position')
  /** The map the board bar carries at its centre on the desktop: the tiles, the selected one over the page's centre. */
  readonly barIndex = element('div', 'ws-head-index')
  /** The phone's sense of place: one tick per page along the bottom bar's top edge. */
  private readonly ticks = element('div', 'ws-page-ticks')
  /** The one worker control: the card's own pill, drawn bare in the head's right end. */
  private readonly headWorker = element('span', 'ws-head-worker')
  private workerClock = 0
  private readonly pageTitle = element('span', 'ws-thumb-title')
  private readonly arrivalSummary = element('span', 'ws-thumb-arrival')
  private readonly topbar = new PhoneTopbar(hidden => this.el.classList.toggle('ws-topbar-hidden', this.phone.matches && hidden))
  private readonly stopSwipe: () => void
  private swipeSettle: ReturnType<typeof setTimeout> | null = null
  private swiping = false
  /** A press that began on the bare stage, which closes the reader if it ends there too. */
  private stagePress: { id: number; x: number; y: number } | null = null
  /** Whether a popover was open when the current press began, before any outside-click handler closed it. */
  private pressDismisses = false
  private swipeWatchdog: ReturnType<typeof setTimeout> | null = null
  private readonly pageSheet: PageSheet
  private readonly announcement = element('div', 'ws-sr-only')
  private readonly prev: HTMLButtonElement
  private readonly pageChoice: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly observer: ResizeObserver | null
  private readonly labels = new WeakMap<DocumentFrame, { glyph: HTMLElement; title: HTMLElement; provenance: HTMLElement; expand: HTMLButtonElement }>()
  private channel: Channel | null = null
  private currentCard: KanbanCard | null = null
  /** The constitution last open in each sidebar group stop, for this session. */
  private readonly groupMemory = new Map<string, string>()
  private selected: DocKey | null = null
  private expanded = false
  private active = false
  private menu: HTMLElement | null = null
  private menuRelease: Release | null = null
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
  /** The sidebar's edge: a separator that resizes it by pointer or keys. */
  private readonly sidebarHandle = element('div', 'ws-sidebar-handle')
  /** The viewer's chosen width; absent, the measure's default. */
  private sidebarWidthChoice: number | null = null
  private readonly wide = window.matchMedia(SIDEBAR_MEDIA)
  private liveWidth: number | null = null
  private cancelResize: (() => void) | null = null
  private cancelSidebarSlide: (() => void) | null = null
  private instantRaf = 0
  private sizes: Record<string, number> = {}
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly phone = window.matchMedia(MOBILE_MEDIA)

  constructor(opts: ReaderOptions) {
    this.opts = opts
    this.stopTitles = watchDocumentTitles(key => {
      const ch = this.channel
      if (!ch?.documents.some(d => d.key === key)) return
      ch.labels = documentLabels(ch.documents, ch.labels[ch.documents.findIndex(d => d.kind === 'fiber')] === 'Constitution')
      this.tabs.render(ch.labels, ch.documents.map(d => d.key), ch)
      if (this.active) this.paint(false)
    })
    this.el.setAttribute('aria-label', 'Document reader')
    this.el.dataset.wsThemeBoundary = ''
    this.veil.dataset.part = 'veil'
    this.el.inert = true
    this.tabs = new TabStrip(i => this.selectIndex(i), () => this.toggleExpand(), { shuttleBase: opts.shuttleBase })
    this.sidebarToggle = button('ws-sidebar-toggle', '', () => this.toggleSidebar(), 'Constitutions')
    this.sidebarToggle.title = 'Constitutions · s'
    this.sidebarToggle.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect class="ws-toggle-column" x="1.5" y="2.5" width="4.5" height="11"/><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M6 2.5v11"/></svg>'
    this.returnButton = button('ws-return', '‹ Desk', () => opts.onReturn())
    this.title = button('ws-channel-title', '', () => this.openSwitcher())
    this.lead = element('div', 'ws-nav-lead')
    this.lead.append(this.returnButton, this.title)
    this.barPosition.setAttribute('aria-hidden', 'true')
    this.headWorker.dataset.part = 'act'; this.headWorker.dataset.act = 'worker'
    this.headWorker.hidden = true
    const trail = element('div', 'ws-nav-trail')
    trail.append(this.headWorker, this.barPosition)
    this.barIndex.dataset.part = 'page-band'
    this.barIndex.append(this.tabs.el, this.tabs.tip)
    // The phone's top bar: back, the fiber's name, the worker's dot. The desktop
    // draws no head of its own: the board's bar adopts the map and the count,
    // which otherwise wait here, unseen.
    this.navbar = element('nav', 'ws-navbar')
    this.navbar.dataset.part = 'phone-topbar'
    this.navbar.append(this.lead, this.barIndex, trail)
    this.ticks.setAttribute('aria-hidden', 'true')
    this.prev = button('ws-thumb-button', '', () => this.step(-1), 'Previous document')
    this.next = button('ws-thumb-button', '', () => this.step(1), 'Next document')
    this.prev.innerHTML = '<svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><path d="M10 2 2 10l8 8"/></svg>'
    this.next.innerHTML = '<svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><path d="m2 2 8 8-8 8"/></svg>'
    const thumbMenu = button('ws-thumb-button', '⋯', () => {
      const doc = this.document
      if (doc) this.openMenu(doc, thumbMenu)
    }, 'Document menu')
    const thumb = element('div', 'ws-thumbbar')
    thumb.dataset.part = 'phone-bottom-bar'
    thumb.dataset.wsSwipe = 'on'
    this.pageSheet = new PageSheet(opts.shuttleBase, key => this.opts.onSelect(key))
    const pageChoice = this.pageChoice = button('ws-page-choice', '', () => { if (!this.runSettled) return; this.closeMenu(); this.pageSheet.show(pageChoice) }, 'Choose a page')
    pageChoice.setAttribute('aria-haspopup', 'dialog')
    pageChoice.setAttribute('aria-expanded', 'false')
    const pageMeta = element('span', 'ws-thumb-meta')
    pageMeta.append(this.position, this.arrivalSummary)
    pageChoice.append(this.pageTitle, pageMeta)
    thumb.append(this.ticks, this.prev, pageChoice, this.next, thumbMenu)
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
      find: opts.find, active: () => this.active && this.sidebarShown,
      // Escape on a card leaves the reader, as it does anywhere else in it.
      onEscape: () => { this.handleIntent('back') },
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
    this.sidebarHandle.setAttribute('role', 'separator')
    this.sidebarHandle.setAttribute('aria-orientation', 'vertical')
    this.sidebarHandle.setAttribute('aria-label', 'Resize constitutions')
    this.sidebarHandle.title = 'Drag to resize · double-click to reset'
    this.sidebarHandle.tabIndex = 0
    this.sidebarHandle.addEventListener('pointerdown', e => this.sidebarResizeStart(e))
    this.sidebarHandle.addEventListener('keydown', e => this.sidebarResizeKey(e))
    this.sidebarHandle.addEventListener('dblclick', () => this.setSidebarWidth(null, true))
    this.sidebar.append(this.sidebarPicker.el, this.sidebarHandle)
    // The list's scroll offset sets how far its top fades under the toggle.
    this.sidebar.addEventListener('scroll', event => {
      const list = event.target
      if (list instanceof HTMLElement && list.classList.contains('ws-channel-list')) list.style.setProperty('--ws-list-scroll', `${list.scrollTop}px`)
    }, { capture: true, passive: true })
    const column = element('div', 'ws-stage-column')
    column.append(this.stage)
    const main = element('div', 'ws-stage-row')
    main.append(this.sidebar, column)
    this.el.append(this.veil, this.navbar, this.sidebarToggle, main, thumb, this.announcement, this.pageSheet.el)
    this.host = new DocumentHost(this.track, {
      shuttleBase: opts.shuttleBase,
      buildProse: opts.buildProse,
      onRefreshProse: opts.onRefreshProse,
      onSelect: key => opts.onSelect(key),
      onFrame: frame => this.prepareFrame(frame),
      onScroll: (key, y) => this.topbar.scroll(key, y),
      onSwipe: signal => this.swipe(signal),
    })
    // Registered first on the window's capture phase, so it reads the page before any popover's own outside-click handler closes it.
    window.addEventListener('pointerdown', this.notePopovers, true)
    this.stage.addEventListener('pointerdown', this.stageDown)
    this.stage.addEventListener('pointerup', this.stageUp)
    this.stage.addEventListener('pointercancel', () => { this.stagePress = null })
    this.stopSwipe = installPageSwipe(this.el, signal => this.swipe(signal), () => this.swipeable, SWIPE)
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout(false))
    this.observer?.observe(this.stage)
    // The index's slot moves with the lead's width (a name, a font arriving).
    this.observer?.observe(this.tabs.el)
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
      const width = Number(localStorage.getItem(SIDEBAR_WIDTH_STORAGE))
      if (Number.isFinite(width) && width > 0) this.sidebarWidthChoice = width
    } catch { /* Storage is optional. */ }
    this.applySidebarWidth()
  }

  /** Whether the sidebar's list is on screen, where the board bar's Find filters it. */
  get sidebarVisible(): boolean { return this.active && this.sidebarShown }
  get document(): WorkspaceDocument | undefined { return this.channel?.documents.find(d => d.key === this.selected) }
  get isActive(): boolean { return this.active }

  /**
   * `settled` says the channel's run is final (its body has been read, or the
   * read has failed). Until then the selected page shows alone: the strip's
   * tiles, the ticks, the count and the steps hold their room unseen, and
   * stepping keys do nothing, so no page appears on one side of the § and
   * then crosses it.
   */
  show(channel: Channel, selected: DocKey, origin = 'Desk', card?: KanbanCard, animate = true, ready = true, settled = ready): void {
    const switching = channel.uid !== this.channel?.uid || channel.owner !== this.channel?.owner || !this.active
    this.cancelSwipe()
    if (switching) { this.cancelResize?.(); if (this.expanded) this.setExpanded(false); this.closeMenu(); this.pageSheet.hide() }
    const arrivals = this.receipts.observe(channel, ready)
    const reordered = this.selected === selected && this.channel?.documents.map(d => d.key).join('\0') !== channel.documents.map(d => d.key).join('\0')
    this.channelReady = ready
    this.settleRun(settled)
    this.channel = channel
    this.currentCard = card ?? this.opts.cards().find(row => (row.uid ?? row.id) === channel.uid && row.originId === channel.owner) ?? null
    this.selected = selected
    if (this.currentCard) { this.opts.themes?.bind(this.el, this.currentCard, 'reader'); this.rememberStop() }
    const arriving = !this.active
    this.active = true
    if (arriving) this.arrive(origin === 'Board')
    this.el.inert = false
    this.el.removeAttribute('aria-hidden')
    this.returnButton.textContent = `‹ ${origin}`
    this.returnButton.setAttribute('aria-label', `Return to ${origin}`)
    this.title.textContent = channel.name
    this.title.title = channel.name
    if (!this.workerClock) this.workerClock = window.setInterval(() => this.paintWorker(), 30000)
    this.tabs.setVisible(true)
    this.tabs.render(channel.labels, channel.documents.map(d => d.key), channel)
    if (!switching) this.tabs.arrive(arrivals)
    this.host.setChannel(channel.documents, selected)
    this.paint(!switching && !reordered && animate)
    this.renderSidebar()
    if (arriving) this.setSidebarVisible(this.sidebarShown)
    // A keyboard switch gives focus a home on the new channel: its selected tile
    // on the desktop, the top bar's back control on the phone.
    if (switching && this.keyboardInput) (this.phone.matches || !settled ? this.returnButton : this.tabs.buttons.find(tab => tab.tabIndex === 0) ?? this.returnButton).focus({ preventScroll: true })
    requestAnimationFrame(() => this.layout(false))
  }

  select(key: DocKey): void {
    if (!this.channel?.documents.some(d => d.key === key) || key === this.selected) return
    this.cancelSwipe()
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
    window.clearInterval(this.workerClock); this.workerClock = 0
    this.cancelSwipe()
    this.cancelResize?.()
    this.setSidebarVisible(false, animate)
    if (this.expanded) this.setExpanded(false)
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

  /** Hide the run's surfaces while it is provisional; they fade in once, when it lands. */
  private settleRun(settled: boolean): void {
    const landing = settled && !this.runSettled
    this.runSettled = settled
    this.pageChoice.setAttribute('aria-disabled', String(!settled))
    for (const el of [this.tabs.el, this.barPosition, this.ticks, this.position, this.prev, this.next]) {
      el.classList.toggle('ws-run-pending', !settled)
      if (!settled || landing) el.classList.remove('ws-run-landing')
      if (landing) el.classList.add('ws-run-landing')
    }
    if (!settled) this.pageSheet.hide()
  }
  private selectIndex(index: number): void {
    if (!this.runSettled) return
    const doc = this.channel?.documents[index]
    if (doc) this.opts.onSelect(doc.key)
  }
  private step(delta: number): void {
    if (this.channel) this.selectIndex(this.channel.documents.findIndex(d => d.key === this.selected) + delta)
  }
  private get swipeable(): boolean {
    return this.active && this.phone.matches && !this.expanded && !this.pageSheet.isOpen && !this.menu
      && this.runSettled && (window.visualViewport?.scale ?? 1) <= 1.01 && (this.channel?.documents.length ?? 0) > 1
  }
  /**
   * The track follows a latched page swipe, then settles on the page the
   * release chose. A swipe whose release cannot be honoured, or that goes
   * quiet for half a second, is cancelled so layout owns the track again.
   */
  private swipe(signal: SwipeSignal): void {
    const ch = this.channel
    const index = ch?.documents.findIndex(d => d.key === this.selected) ?? -1
    const width = this.stage.clientWidth
    if (!ch || index < 0 || !width) { this.cancelSwipe(); return }
    if (!this.swiping && (signal.phase !== 'move' || !this.swipeable)) return
    const hasPrevious = index > 0, hasNext = index < ch.documents.length - 1
    if (signal.phase === 'move') {
      if (this.swipeSettle !== null) { clearTimeout(this.swipeSettle); this.swipeSettle = null }
      if (this.swipeWatchdog !== null) clearTimeout(this.swipeWatchdog)
      this.swipeWatchdog = setTimeout(() => { this.swipeWatchdog = null; this.cancelSwipe() }, SWIPE_QUIET)
      this.swiping = true
      this.stage.classList.remove('ws-swipe-release')
      this.stage.classList.add('ws-swiping')
      this.track.style.transform = `translateX(${this.trackX + swipeFollow(signal.dx, width, hasPrevious, hasNext)}px)`
      return
    }
    this.clearSwipeWatchdog()
    this.swiping = false
    const delta = signal.phase === 'end' && this.swipeable ? swipeOutcome(signal.dx, signal.velocity, width, hasPrevious, hasNext) : 0
    const travelled = signal.phase === 'end' ? Math.abs(swipeFollow(signal.dx, width, hasPrevious, hasNext)) : 0
    const settle = swipeSettleTime(delta ? width - travelled : travelled, signal.phase === 'end' ? signal.velocity : 0, this.measure('crossing', 280))
    this.stage.classList.remove('ws-swiping')
    if (!this.motion.matches) {
      this.stage.style.setProperty('--ws-swipe-settle', `${settle}ms`)
      this.stage.classList.add('ws-swipe-release')
      this.swipeSettle = setTimeout(() => { this.swipeSettle = null; this.stage.classList.remove('ws-swipe-release') }, settle + 40)
    }
    if (delta) this.step(delta)
    else this.layout(true)
  }
  /** Abandon a latched swipe in place: the track returns to the selected page without a release. */
  private cancelSwipe(): void {
    this.clearSwipeWatchdog()
    if (!this.swiping) return
    this.swiping = false
    this.stage.classList.remove('ws-swiping')
    this.layout(false)
  }
  private clearSwipeWatchdog(): void {
    if (this.swipeWatchdog !== null) clearTimeout(this.swipeWatchdog)
    this.swipeWatchdog = null
  }
  /** Repaint the head's worker control from the current card, keeping its focus. */
  private paintWorker(): void {
    const card = this.currentCard
    const pill = card ? this.opts.workerPill?.(card) ?? null : null
    const focused = this.headWorker.contains(document.activeElement)
    this.headWorker.replaceChildren(...(card && pill ? [workerPlate(card, pill)] : []))
    this.headWorker.hidden = !pill
    if (focused) this.headWorker.querySelector<HTMLElement>('.kbn-card-worker')?.focus({ preventScroll: true })
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
    const fresh = this.seen.observe(ch, this.selected ?? '', this.channelReady)
    this.tabs.fresh(fresh)
    this.pageSheet.update(ch, this.selected ?? '', fresh)
    this.tabs.mark(index, animate)
    this.position.textContent = this.barPosition.textContent = `${index + 1} / ${ch.documents.length}`
    // Held at the widest count, so stepping from 9 to 10 never moves the index.
    const digits = 2 * String(ch.documents.length).length + 3
    this.barPosition.style.minWidth = `calc(${digits}ch + ${digits} * var(--ws-mono-tracking))`
    this.paintTicks(index, ch.documents.length)
    const doc = ch.documents[index]
    if (doc) {
      const metadata = documentLabelMetadata(doc, ch.labels[index], ch.owner)
      this.pageTitle.textContent = doc.kind === 'fiber' ? ch.labels[index] : metadata.title
      this.arrivalSummary.textContent = metadata.summary && ` · ${metadata.summary.charAt(0).toLowerCase()}${metadata.summary.slice(1)}`
      this.topbar.select(doc.key)
    }
    this.prev.disabled = index <= 0
    this.next.disabled = index >= ch.documents.length - 1
    const announcement = `${ch.labels[index]}, ${index + 1} of ${ch.documents.length}`
    // A provisional run's count goes unannounced; the final one is read once it lands.
    if (this.runSettled && this.announcement.textContent !== announcement) this.announcement.textContent = announcement
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
    if (this.phone.matches) this.el.style.setProperty('--ws-phone-bar-height', `${this.navbar.offsetHeight}px`)
  }
  /** One tick per page, the selected one in ink; a long run's ticks close up rather than wrap. */
  private paintTicks(index: number, count: number): void {
    if (count < 2) count = 0
    if (this.ticks.childElementCount !== count) this.ticks.replaceChildren(...Array.from({ length: count }, () => element('i', 'ws-page-tick')))
    ;[...this.ticks.children].forEach((tick, i) => tick.classList.toggle('ws-page-tick-current', i === index))
  }
  private layout(animate: boolean): void {
    this.layoutNavbar()
    const tabIndex = this.channel?.documents.findIndex(d => d.key === this.selected) ?? -1
    const ch = this.channel
    if (!ch || !this.active) { if (tabIndex >= 0) this.tabs.mark(tabIndex, animate); return }
    const W = this.stage.clientWidth, H = this.stage.clientHeight
    if (!W || !H) { if (tabIndex >= 0) this.tabs.mark(tabIndex, animate); return }
    const inset = this.measure('stage-inset', 28), top = this.measure('stage-top', 10), gap = this.measure('gap', 24)
    // Beside the sidebar the page keeps one page gap from the column and shrinks
    // before that gutter grows; the right neighbour has the room left over.
    // Without the sidebar the page is centred in the stage.
    const docked = this.sidebarShown
    const boxW = docked ? W - gap - inset : W - inset * 2, boxH = H - top - inset
    if (!animate || this.motion.matches) {
      this.stage.classList.add('ws-instant')
      void this.stage.offsetWidth
      cancelAnimationFrame(this.instantRaf)
      this.instantRaf = requestAnimationFrame(() => {
        this.instantRaf = requestAnimationFrame(() => this.stage.classList.remove('ws-instant'))
      })
    }
    let x = 0, centre = 0, selectedWidth = 0
    ch.documents.forEach(doc => {
      const f = this.host.get(doc.key)
      if (!f) return
      const sel = doc.key === this.selected
      const width = sel && this.expanded ? boxW : sel && this.liveWidth !== null ? this.liveWidth : this.preferredWidth(doc, boxW, boxH)
      f.el.style.left = `${x}px`
      f.el.style.width = `${width}px`
      f.el.style.height = `${boxH}px`
      if (sel) { centre = x + width / 2; selectedWidth = width }
      x += width + gap
    })
    const target = Math.round(docked ? gap - (centre - selectedWidth / 2) : W / 2 - centre)
    // The index holds the selected tile over the page's centre, or as near it as its slot allows.
    const tile = this.tabs.selectedWidth / 2 + this.measure('index-fade', 40)
    // The map rides the board bar, outside the reader, so the page's centre is measured on screen.
    const column = this.stage.parentElement?.getBoundingClientRect().left ?? 0
    const focus = column + target + centre - this.tabs.el.getBoundingClientRect().left
    this.tabs.setFocus(Math.max(Math.min(tile, this.tabs.el.clientWidth / 2), Math.min(Math.max(this.tabs.el.clientWidth / 2, this.tabs.el.clientWidth - tile), focus)))
    if (tabIndex >= 0) this.tabs.mark(tabIndex, animate)
    if (animate && !this.motion.matches && target !== this.trackX) this.opts.onCrossing?.(target - this.trackX)
    this.trackX = target
    if (!this.swiping) this.track.style.transform = `translateX(${target}px)`
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
    this.applySidebarWidth()
    this.renderSidebar()
    this.layout(false)
    const index = this.channel?.documents.findIndex(d => d.key === this.selected) ?? 0
    this.tabs.mark(index, false)
  }
  /** Expand takes the whole window: the board bar and the sidebar step aside until it is restored. */
  private toggleExpand(): void {
    this.cancelResize?.()
    this.setExpanded(!this.expanded)
    this.paint(true)
  }
  private setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.el.classList.toggle('ws-expand-mode', expanded)
    this.opts.onExpand?.(expanded)
    this.renderSidebar()
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
    this.menuRelease = anchorPopover(menu, anchor, { placement: 'above-end', gap: 6, margin: 12 })
    if (this.keyboardInput) menu.querySelector<HTMLElement>('a,button')?.focus({ preventScroll: true })
  }
  private syncPlainToggle(item?: HTMLButtonElement): void {
    const toggle = item ?? this.menu?.querySelector<HTMLButtonElement>('[data-part="plain-toggle"]')
    const card = this.currentCard
    const themes = this.opts.themes
    if (!toggle || !themes) return
    // A stored Plain choice stays reachable even when no theme is declared, so it can be cleared.
    toggle.hidden = !card || (!themes.hasTheme(card) && !themes.isPlain(card))
    toggle.setAttribute('aria-pressed', String(!!card && themes.isPlain(card)))
  }
  private closeMenu(): boolean {
    if (this.picker.isOpen) { this.picker.close(); return true }
    if (!this.menu) return false
    this.menuRelease?.(); this.menuRelease = null
    this.menu.remove()
    this.menu = null
    this.menuAnchor = null
    return true
  }
  /** The stage's bare ground, around the pages: not a page, a tile, the sidebar or the bar. */
  private bareStage(target: EventTarget | null): boolean {
    return target === this.stage || target === this.parallax || target === this.track
  }
  private readonly notePopovers = (): void => {
    this.pressDismisses = !!document.querySelector(POPOVERS)
  }
  private readonly stageDown = (e: PointerEvent): void => {
    // A press that dismisses an open popover or picker does only that.
    this.stagePress = e.button === 0 && e.isPrimary && !this.phone.matches && !this.expanded && !this.pressDismisses && this.bareStage(e.target)
      ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null
  }
  /**
   * A click on the bare stage closes the reader back to its origin, as a click
   * outside a modal does, by the same path as Escape. It must start and end on
   * the stage, barely move, select no text and interrupt no resize; expanded,
   * the stage is the page's and a click there does nothing.
   */
  private readonly stageUp = (e: PointerEvent): void => {
    const press = this.stagePress
    this.stagePress = null
    if (!press || press.id !== e.pointerId || !this.active || this.expanded || this.cancelResize || !this.bareStage(e.target)) return
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > this.measure('drag-latch', 4)) return
    if (window.getSelection()?.toString()) return
    this.opts.onReturn()
  }
  private readonly pointerInput = (): void => { this.keyboardInput = false; this.el.classList.remove('ws-keyboard') }
  private readonly keyboardModality = (): void => { this.keyboardInput = true; this.el.classList.add('ws-keyboard') }
  private readonly outside = (e: PointerEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node) && !this.menuAnchor?.contains(e.target as Node)) this.closeMenu()
  }
  private openSwitcher(): void {
    if (!this.phone.matches && this.opts.onFind?.()) return
    if (this.sidebarShown) { this.sidebarPicker.focus(); return }
    if (this.picker.isOpen) { this.picker.close(); return }
    this.closeMenu()
    this.picker.show(this.el, this.title)
  }
  /** The source column is captured before the live Desk starts receding. */
  captureSidebar(entries: SidebarEntry[]): void { this.sidebarFlight.capture(entries) }
  private sidebarCard(card: KanbanCard): HTMLElement {
    const face = buildCardPaper(card)
    // A note or role has no lifecycle, so it carries no lifecycle glyph.
    if (!onDesk(card)) face.querySelector('.kbn-card-glyph')?.remove()
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
    return !this.phone.matches && !this.expanded && (this.sidebarChoice ?? this.wide.matches)
  }
  /**
   * Opening or closing the sidebar is one coordinated motion: the column
   * slides in or out while the stage and the tab strip glide to their new
   * places. The layout lands at once and only `translate` and `opacity`
   * animate back from where things were, so nothing reflows per frame.
   * Under reduced motion it lands instantly.
   */
  private toggleSidebar(): void {
    this.sidebarChoice = !this.sidebarShown
    try { localStorage.setItem(SIDEBAR_STORAGE, String(this.sidebarChoice)) } catch { /* Storage is optional. */ }
    this.closeMenu()
    this.cancelSidebarSlide?.()
    const shown = this.sidebarShown
    const slide = !this.motion.matches && typeof this.sidebar.animate === 'function' && this.active
    const before = slide ? this.stagePlaces() : null
    this.setSidebarVisible(shown, false)
    this.renderSidebar(); this.layout(false)
    if (before) this.slideSidebar(shown, before)
  }
  private stagePlaces(): { page: number; tabs: number[]; sidebar: number } {
    const page = this.selected ? this.host.get(this.selected)?.el.getBoundingClientRect().left ?? 0 : 0
    return { page, tabs: this.tabs.buttons.map(tab => tab.getBoundingClientRect().left), sidebar: this.sidebar.offsetWidth }
  }
  private slideSidebar(shown: boolean, before: { page: number; tabs: number[]; sidebar: number }): void {
    const after = this.stagePlaces()
    const options: KeyframeAnimationOptions = {
      duration: this.measure('sidebar-time', 220),
      easing: getComputedStyle(this.el).getPropertyValue('--ws-sidebar-ease').trim() || 'ease',
    }
    const animations: Animation[] = []
    const glide = (el: Element | null, from: number): void => {
      if (el && Math.abs(from) >= 1) animations.push(el.animate([{ translate: `${from}px 0` }, { translate: '0 0' }], options))
    }
    glide(this.parallax, before.page - after.page)
    // The tiles follow their page across the head, inside the index's slot.
    this.tabs.buttons.forEach((tab, i) => glide(tab, (before.tabs[i] ?? after.tabs[i]) - after.tabs[i]))
    const width = Math.max(before.sidebar, after.sidebar)
    const hidden = { translate: `${-width}px 0`, opacity: 0 }, rest = { translate: '0 0', opacity: 1 }
    this.el.classList.add('ws-sidebar-sliding')
    if (!shown) this.el.classList.add('ws-sidebar-leaving')
    animations.push(this.sidebar.animate(shown ? [hidden, rest] : [rest, hidden], options))
    // The left neighbour the sidebar covers fades with it instead of blinking.
    for (const page of this.track.querySelectorAll<HTMLElement>('.ws-page.ws-receded.ws-before')) {
      const opacity = getComputedStyle(page).opacity
      animations.push(page.animate(shown
        ? [{ clipPath: 'none', opacity }, { clipPath: 'none', opacity: 0 }]
        : [{ opacity: 0 }, { opacity }], options))
    }
    const finish = (): void => {
      if (this.cancelSidebarSlide !== cancel) return
      this.cancelSidebarSlide = null
      this.el.classList.remove('ws-sidebar-leaving', 'ws-sidebar-sliding')
    }
    const cancel = (): void => { for (const animation of animations) animation.cancel(); finish() }
    this.cancelSidebarSlide = cancel
    void Promise.allSettled(animations.map(animation => animation.finished)).then(finish)
  }
  /** The sidebar's bounds: the measure's floor, up to a share of the viewport. */
  private sidebarBounds(): { min: number; max: number; preferred: number } {
    const min = this.measure('sidebar-min', 320)
    const max = Math.max(min, Math.floor(window.innerWidth * this.measure('sidebar-max-share', 0.4)))
    return { min, max, preferred: Math.min(max, Math.max(min, this.measure('sidebar-default', 384))) }
  }
  /** The width the sidebar wears now: the viewer's choice clamped to the viewport, else the default. */
  private applySidebarWidth(width = this.sidebarWidthChoice): number {
    const { min, max, preferred } = this.sidebarBounds()
    const px = Math.round(width === null ? preferred : Math.min(max, Math.max(min, width)))
    this.el.style.setProperty('--ws-sidebar-width', `${px}px`)
    this.sidebarHandle.setAttribute('aria-valuemin', String(min))
    this.sidebarHandle.setAttribute('aria-valuemax', String(max))
    this.sidebarHandle.setAttribute('aria-valuenow', String(px))
    return px
  }
  /** Set (or with null, reset) the viewer's width; the stage reflows at once, without a crossing. */
  private setSidebarWidth(width: number | null, persist: boolean): void {
    this.sidebarWidthChoice = width
    this.applySidebarWidth()
    this.layout(false)
    if (!persist) return
    try {
      if (width === null) localStorage.removeItem(SIDEBAR_WIDTH_STORAGE)
      else localStorage.setItem(SIDEBAR_WIDTH_STORAGE, String(Math.round(width)))
    } catch { /* Storage is optional. */ }
  }
  private sidebarResizeStart(e: PointerEvent): void {
    if (e.button !== 0 || !this.sidebarShown) return
    e.preventDefault()
    const handle = this.sidebarHandle
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX, startWidth = this.sidebar.offsetWidth, before = this.sidebarWidthChoice
    let latched = false
    this.el.classList.add('ws-sidebar-resizing')
    this.stage.classList.add('ws-resizing')
    const move = (ev: PointerEvent): void => {
      const delta = ev.clientX - startX
      if (!latched && Math.abs(delta) < this.measure('drag-latch', 4)) return
      latched = true
      const { min, max } = this.sidebarBounds()
      this.setSidebarWidth(Math.min(max, Math.max(min, startWidth + delta)), false)
    }
    const finish = (commit: boolean): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      this.el.classList.remove('ws-sidebar-resizing')
      this.stage.classList.remove('ws-resizing')
      if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId)
      if (!latched) return
      if (commit) this.setSidebarWidth(this.sidebarWidthChoice, true)
      else this.setSidebarWidth(before, false)
    }
    const up = (): void => finish(true)
    const cancel = (): void => finish(false)
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(false) }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }
  private sidebarResizeKey(e: KeyboardEvent): void {
    const { min, max } = this.sidebarBounds()
    const now = this.sidebar.offsetWidth, step = SIDEBAR_STEP * (e.shiftKey ? 4 : 1)
    const next = e.key === 'ArrowLeft' ? now - step : e.key === 'ArrowRight' ? now + step
      : e.key === 'Home' ? min : e.key === 'End' ? max : e.key === 'Enter' ? null : undefined
    if (next === undefined) return
    e.preventDefault()
    e.stopPropagation()
    this.setSidebarWidth(next === null ? null : Math.min(max, Math.max(min, next)), true)
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
    // The sidebar's edge takes its own arrows, Home, End and Enter.
    if (e.target === this.sidebarHandle && ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)) return
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
      if (!this.currentCard || !verdictReachable(this.currentCard)) return false
      this.opts.onVerdict?.(intent === 'temper' ? 'tempered' : 'composted')
    }
    else if (intent === 'compose') this.opts.onCompose?.()
    else if (intent === 'conversation') {
      if (this.currentCard) this.opts.onConversation?.(this.currentCard)
    }
    else if (intent === 'sidebar') this.toggleSidebar()
    else if (intent === 'find') {
      if (!this.phone.matches && this.opts.onFind?.()) { /* The board bar's Find serves the reader too. */ }
      else if (this.sidebarShown) this.sidebarPicker.focus()
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
    } else if (intent === 'prevGroup' || intent === 'nextGroup') {
      const cards = this.opts.switcherCards?.() ?? this.opts.cards()
      const index = cards.findIndex(c => (c.uid ?? c.id) === this.channel?.uid && c.originId === this.channel?.owner)
      this.rememberStop()
      const card = groupJump(cards, index, intent === 'prevGroup' ? -1 : 1, this.stopOf, cardIdentity, this.groupMemory)
      if (card) this.opts.onChannel(card)
    } else if (['scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp'].includes(intent)) this.scrollDocument(intent, repeat)
    else return false
    return true
  }

  private readonly stopOf = (card: KanbanCard): string => this.opts.sidebarBand?.(card) ?? ''
  private rememberStop(): void {
    if (this.currentCard) this.groupMemory.set(this.stopOf(this.currentCard), cardIdentity(this.currentCard))
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
    window.clearInterval(this.workerClock)
    this.cancelSidebarSlide?.()
    this.opts.themes?.unbind(this.el)
    this.cancelResize?.()
    this.closeMenu()
    this.stopSwipe()
    this.clearSwipeWatchdog()
    this.pageSheet.dispose()
    this.observer?.disconnect()
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
    window.removeEventListener('pointerdown', this.notePopovers, true)
    document.removeEventListener('pointerdown', this.pointerInput, true)
    this.motion.removeEventListener('change', this.relayout)
    this.phone.removeEventListener('change', this.relayout)
    this.el.removeEventListener('workspace-theme-change', this.themeChanged)
    this.el.remove()
  }
}
