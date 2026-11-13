import { sentDocuments } from './SentFiles.js'
import type { ThreadIndex } from '../threads.js'
import './tokens.css'
import './reader.css'
import type { KanbanCard } from '../KanbanTypes.js'
import { constitutionAction } from './fiberPageState.js'
import { keyIntent, shouldForwardDocumentKey, type KeyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { MOBILE_MEDIA } from '../mobile.js'
import { announce, prepareAnnouncements } from '@ui-sdk/core'
import { fileBytesUrl, showToast } from '../utils.js'
import { instantStamp } from '../civilDay.js'
import { DocumentHost, type DocumentFrame } from './DocumentHost.js'
import { scrollHtmlViewer } from './DocumentBridge.js'
import { documentLabels, documentLabelMetadata, isDrawn, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'
import { DocumentSeen } from './DocumentSeen.js'
import { declaredTitle, watchDocumentTitles } from './DocumentTitles.js'
import { probeDocumentTitles } from './titleProbe.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'
import type { ChannelThemes } from './ChannelThemes.js'
import { deskCardKey } from '../deskOrdering.js'
import { groupJump, groupStops } from './groupJump.js'
import { invalidateWorkspaceMeasures, workspaceMeasure } from './measures.js'
import { type Verdict } from './Verdicts.js'
import { installPageSwipe, PhoneTopbar, SWIPE, swipeFollow, swipeOutcome, swipeSettleTime, type SwipeSignal } from './PhoneGestures.js'
import { PageSheet } from './PageSheet.js'
import { SettingsMenu } from './SettingsMenu.js'
import { anchorPopover, type Release } from './anchoredPopover.js'
import { headerIcon } from './headerIcon.js'

export interface ReaderOptions {
  shuttleBase: string
  themes?: ChannelThemes
  buildProse(doc: WorkspaceDocument): HTMLElement
  onRefreshProse(doc: WorkspaceDocument): void | Promise<void>
  onSelect(key: DocKey): void
  onNavigate?(source: WorkspaceDocument, href: string): void
  onReview?(source: WorkspaceDocument, message: string): Promise<void>
  canReview?(source: WorkspaceDocument): boolean
  reviewTarget?(source: WorkspaceDocument): string
  onCrossing?(travel: number): void
  onReturn(): void
  onOpenDocument(key: DocKey): void
  onRevisitDocument(key: DocKey): void
  /** Between the family's map and its tapestry; false outside a family. */
  onTapestry?(): boolean
  actionCard?(card: KanbanCard): KanbanCard
  onVerdict?(verdict: Verdict): void
  onConversation?(card: KanbanCard): void
  onRest?(card: KanbanCard, anchor: HTMLElement): void
  onEscapeLayer?(): boolean
  onChannel(card: KanbanCard): void
  /** Stepping between constitutions replaces the open history entry. */
  onScan?(card: KanbanCard): void
  /** Open the open thread's orchestrator; false outside a thread. */
  onOrchestrator?(): boolean
  cards(): KanbanCard[]
  /** The thread graph that places an off-Desk constitution beside its family. */
  threadIndex?(): ThreadIndex
  /** The Desk's reading order, which every constitution-stepping binding walks. */
  deskCards?(): KanbanCard[]
  pickerCards?(): KanbanCard[]
  /** The Desk column a card stands in: the J/K stops. */
  deskStop?(card: KanbanCard): string
  files?(card: KanbanCard): string[]
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

/** A latched swipe that neither moves nor releases for this long has lost its release. */
const SWIPE_QUIET = 500
/** How long the landing toast of a constitution step stands. */
const STEP_CUE = 1200

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
  private channelReady = false
  /** The body and receipts have settled; the files sheet can open. */
  private runSettled = true
  private readonly navbar: HTMLElement
  private readonly lead: HTMLElement
  private readonly trail = element('div', 'ws-nav-trail')
  private keyboardInput = false
  private readonly themeChanged = (): void => this.syncPlainToggle()
  private readonly title: HTMLButtonElement
  private readonly returnButton: HTMLButtonElement
  private backDestination = 'Desk'
  /** The band over the stage, seated by the workspace for a fiber on the Desk's lifecycle. */
  private readonly band = element('div', 'ws-stage-band')
  /** The one worker control: the card's own pill, drawn bare in the head's right end. */
  private readonly topbar = new PhoneTopbar(hidden => this.el.classList.toggle('ws-topbar-hidden', this.phone.matches && hidden))
  private readonly stopSwipe: () => void
  private swipeSettle: ReturnType<typeof setTimeout> | null = null
  private swiping = false
  private swipeWatchdog: ReturnType<typeof setTimeout> | null = null
  private readonly pageSheet: PageSheet
  private readonly settingsMenu: SettingsMenu
  private announcement = ''
  private readonly observer: ResizeObserver | null
  private readonly labels = new WeakMap<DocumentFrame, { glyph: HTMLElement; title: HTMLElement; provenance: HTMLElement }>()
  private channel: Channel | null = null
  private fresh: ReadonlySet<DocKey> = new Set()
  private currentCard: KanbanCard | null = null
  /** The constitution last open in each Desk column, for this session. */
  private readonly groupMemory = new Map<string, string>()
  private selected: DocKey | null = null
  private expanded = false
  private active = false
  private menu: HTMLElement | null = null
  private menuRelease: Release | null = null
  private menuAnchor: HTMLElement | null = null
  private readonly picker: ConstitutionPicker
  /** The way to the sheet of sent files, marked while one is unread. */
  private readonly filesToggle: HTMLButtonElement
  private instantRaf = 0
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly phone = window.matchMedia(MOBILE_MEDIA)

  constructor(opts: ReaderOptions) {
    this.opts = opts
    this.stopTitles = watchDocumentTitles(key => {
      const ch = this.channel
      if (!ch?.documents.some(d => d.key === key)) return
      ch.labels = documentLabels(ch.documents, ch.labels[ch.documents.findIndex(d => d.kind === 'fiber')] === 'Constitution')
      if (this.active) this.paint(false)
    })
    this.el.setAttribute('aria-label', 'Document reader')
    this.el.dataset.wsThemeBoundary = ''
    this.veil.dataset.part = 'veil'
    this.el.inert = true
    this.filesToggle = button('ws-files-toggle', '', () => this.openFilesSheet(), 'Sent files')
    this.filesToggle.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path class="ws-toggle-line" d="M6.5 3.5h7M6.5 8h7M6.5 12.5h7"/><circle class="ws-toggle-flag" cx="3" cy="3.5" r="1"/><circle class="ws-toggle-bullet" cx="3" cy="8" r="1"/><circle class="ws-toggle-bullet" cx="3" cy="12.5" r="1"/></svg>'
    this.returnButton = button('ws-return', '', () => this.back(), 'Back to Desk')
    this.title = button('ws-channel-title', '', () => this.openSwitcher())
    this.lead = element('div', 'ws-nav-lead')
    this.lead.append(this.returnButton, this.title)
    const documentMenu = button('ws-icon-button ws-phone-document-menu', '⋯', () => {
      const doc = this.document
      if (doc) this.openMenu(doc, documentMenu)
    }, 'Document menu')
    this.trail.append(this.filesToggle, documentMenu)
    // The phone's top bar owns return, the fiber's name and document actions.
    // The desktop draws no head of its own.
    this.navbar = element('nav', 'ws-navbar')
    this.navbar.dataset.part = 'phone-topbar'
    this.navbar.append(this.lead, this.trail)
    this.settingsMenu = new SettingsMenu()
    this.pageSheet = new PageSheet(opts.shuttleBase, key => this.openDocument(key), () => this.paintFilesToggle())
    prepareAnnouncements(document)
    this.parallax.append(this.track)
    this.stage.append(this.parallax)
    this.picker = new ConstitutionPicker({
      cards: () => this.withCurrent(this.opts.pickerCards?.() ?? this.opts.cards()),
      files: opts.files,
      current: card => (card.uid ?? card.id) === this.channel?.uid && card.originId === this.channel?.owner,
      onOpen: card => { this.closeMenu(); this.opts.onChannel(card) },
    })
    const column = element('div', 'ws-stage-column')
    this.band.hidden = true
    column.append(this.band, this.stage)
    this.el.append(this.veil, this.navbar, column, this.pageSheet.el)
    this.host = new DocumentHost(this.track, {
      shuttleBase: opts.shuttleBase,
      buildProse: opts.buildProse,
      onReview: opts.onReview,
      canReview: opts.canReview,
      reviewTarget: opts.reviewTarget,
      onRefreshProse: opts.onRefreshProse,
      onSelect: key => this.openDocument(key),
      onNavigate: (source, href) => this.opts.onNavigate?.(source, href),
      onFrame: frame => this.prepareFrame(frame),
      onViewerReady: () => this.layout(false),
      // Review navigation stays visible while diff windows change their measured heights.
      onScroll: (key, y) => { if (this.document?.kind !== 'change') this.topbar.scroll(key, y) },
      onSwipe: signal => this.swipe(signal),
    })
    this.stopSwipe = installPageSwipe(this.el, signal => this.swipe(signal), () => this.swipeable, SWIPE)
    this.observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.layout(false))
    this.observer?.observe(this.stage)
    window.addEventListener('resize', this.relayout)
    document.addEventListener('keydown', this.keydown, true)
    document.addEventListener('pointerdown', this.outside)
    document.addEventListener('pointerdown', this.pointerInput, true)
    this.motion.addEventListener('change', this.relayout)
    this.phone.addEventListener('change', this.relayout)
    this.el.addEventListener('workspace-theme-change', this.themeChanged)
    this.el.addEventListener('mousedown', e => {
      if (e.button === 0 && (e.target as Element).closest('button')) e.preventDefault()
    })
  }

  get document(): WorkspaceDocument | undefined { return this.channel?.documents.find(d => d.key === this.selected) }
  get isActive(): boolean { return this.active }
  setBackDestination(label: string): void {
    this.backDestination = label
    for (const button of this.el.querySelectorAll<HTMLElement>('.ws-return, .ws-document-back')) {
      button.replaceChildren(element('span', 'ws-back-label', label))
      button.title = `Back to ${label}`
      button.setAttribute('aria-label', button.title)
    }
  }

  /** Show the selected page; settled body and receipt reads enable the files sheet. */
  show(channel: Channel, selected: DocKey, origin = 'Desk', card?: KanbanCard, animate = true, ready = true, settled = ready): void {
    const switching = channel.uid !== this.channel?.uid || channel.owner !== this.channel?.owner || !this.active
    this.cancelSwipe()
    if (switching) { if (this.expanded) this.setExpanded(false); this.closeMenu(); this.pageSheet.hide(); this.settingsMenu.close() }
    const reordered = this.selected === selected && this.channel?.documents.map(d => d.key).join('\0') !== channel.documents.map(d => d.key).join('\0')
    this.channelReady = ready
    this.settleRun(settled)
    this.channel = channel
    probeDocumentTitles(this.opts.shuttleBase, channel.documents)
    this.currentCard = card ?? this.opts.cards().find(row => (row.uid ?? row.id) === channel.uid && row.originId === channel.owner) ?? null
    this.selected = selected
    if (this.currentCard) { this.opts.themes?.bind(this.el, this.currentCard, 'reader'); this.rememberStop() }
    const arriving = !this.active
    this.active = true
    if (arriving) this.arrive(origin === 'Board')
    this.el.inert = false
    this.el.removeAttribute('aria-hidden')
    this.setBackDestination(this.backDestination)
    this.title.textContent = channel.name
    this.title.title = channel.name
    this.host.setChannel(channel.documents, selected)
    this.paint(!switching && !reordered && animate)
    if (switching && this.keyboardInput) this.returnButton.focus({ preventScroll: true })
    requestAnimationFrame(() => this.layout(false))
  }

  select(key: DocKey): void {
    if (!this.channel?.documents.some(d => d.key === key) || key === this.selected) return
    this.cancelSwipe()
    this.closeMenu()
    this.selected = key
    if (this.expanded) this.setExpanded(false)
    this.host.select(key)
    this.paint(true)
  }

  /**
   * Leave the reader. Toward the Desk or Chronicle the veil lifts and the page
   * sinks back as one motion before the pages park; toward the Board, whose
   * sheet wears the same veil, it goes at once.
   */
  hide(animate = false): void {
    this.cancelSwipe()
    if (this.expanded) this.setExpanded(false)
    this.active = false
    this.opts.themes?.unbind(this.el)
    this.pageSheet.hide()
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
    this.runSettled = settled
    if (!settled) this.pageSheet.hide()
  }
  /** Open a file over the current page, preserving its exact return point. */
  openDocument(key: DocKey): void {
    if (key === this.selected) return
    this.opts.onOpenDocument(key)
  }
  /** Back, Escape and the phone swipe follow the same visited path. */
  back(): void { this.opts.onReturn() }
  closeSettings(after: () => void): void { this.settingsMenu.close(after) }
  /** Seat the band over the stage, or clear it where the page has none. */
  setBand(el: HTMLElement | null): void {
    if (el ? this.band.firstChild === el : !this.band.firstChild) return
    this.band.replaceChildren(...(el ? [el] : []))
    this.band.hidden = !el
    if (this.active) this.layout(false)
  }
  /** The settings dropdown under the ⚙ that asked, kept inside the band's styling boundary (`host`) wherever that ⚙ sits. */
  showSettings(content: HTMLElement, opener: HTMLElement, host: HTMLElement = opener.closest<HTMLElement>('.ws-dock') ?? this.el): void {
    this.closeMenu()
    this.settingsMenu.show(content, opener, host)
  }
  private openFilesSheet(opener: HTMLElement = this.filesToggle): void {
    if (!this.runSettled) return
    this.el.append(this.pageSheet.el)
    this.pageSheet.show(opener)
  }
  private get swipeable(): boolean {
    return this.active && this.phone.matches && !this.expanded && !this.pageSheet.isOpen && !this.menu
      && this.runSettled && (window.visualViewport?.scale ?? 1) <= 1.01
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
    const hasPrevious = true, hasNext = false
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
    if (delta < 0) this.back()
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
  private paint(animate: boolean): void {
    const ch = this.channel
    if (!ch) return
    const index = ch.documents.findIndex(d => d.key === this.selected)
    ch.documents.forEach((doc, i) => {
      const frame = this.host.get(doc.key)
      if (!frame) return
      frame.el.classList.toggle('ws-expanded', doc.key === this.selected && this.expanded)
      this.fillLabel(frame, ch.labels[i])
    })
    const fresh = this.seen.observe(ch, this.selected ?? '', this.channelReady)
    this.pageSheet.update(ch, this.selected ?? '', fresh)
    this.fresh = fresh
    this.paintFilesToggle()
    const doc = ch.documents[index]
    if (doc) this.el.dataset.page = doc.kind
    else delete this.el.dataset.page
    if (doc) {
      this.topbar.select(doc.key)
    }
    const announcement = ch.labels[index] ?? ''
    // A provisional run's count goes unannounced; the final one is read once it lands.
    if (this.runSettled && this.announcement !== announcement) {
      this.announcement = announcement
      announce(announcement)
    }
    this.layout(animate)
  }
  private prepareFrame(frame: DocumentFrame): void {
    if (frame.doc.kind === 'audio' || frame.doc.kind === 'video') frame.el.classList.add('ws-media-page')
    frame.el.setAttribute('role', 'tabpanel')
    frame.el.setAttribute('aria-label', frame.doc.name)
    const glyph = element('span', 'ws-kind-glyph')
    const title = element('span', 'ws-label-title')
    const provenance = element('span', 'ws-provenance')
    const back = button('ws-document-back', '', () => this.back(), `Back to ${this.backDestination}`)
    back.append(element('span', 'ws-back-label', this.backDestination))
    back.title = `Back to ${this.backDestination}`
    frame.label.append(back, glyph, title, provenance)
    // A drawn page has nothing to say about itself beyond what the band says.
    if (isDrawn(frame.doc)) frame.el.dataset.drawn = ''
    else {
      const download = element('a', 'ws-icon-button ws-download')
      download.href = fileBytesUrl(this.opts.shuttleBase, frame.doc.path, frame.doc.owner); download.download = frame.doc.name
      download.innerHTML = headerIcon('download')
      download.title = `Download ${frame.doc.name}`; download.setAttribute('aria-label', download.title)
      const menu = button('ws-icon-button ws-menu-button', '⋯', () => this.openMenu(frame.doc, menu), 'Document menu')
      frame.label.append(download, menu)
    }
    this.labels.set(frame, { glyph, title, provenance })
    frame.label.addEventListener('dblclick', e => {
      if (!(e.target as Element).closest('button,a') && frame.doc.key === this.selected) this.toggleExpand()
    })
  }
  private fillLabel(frame: DocumentFrame, label: string): void {
    const doc = frame.doc
    const metadata = documentLabelMetadata(doc, label, this.channel?.owner ?? doc.owner)
    const glyph = { fiber: '▤', family: '⋔', html: '▣', pdf: '▧', image: '▨', audio: '♪', video: '▹', text: '≡', other: '□', change: '±' }[doc.kind]
    const parts = this.labels.get(frame)
    if (!parts) return
    parts.glyph.hidden = isDrawn(doc)
    parts.glyph.textContent = isDrawn(doc) ? '' : glyph
    parts.title.hidden = isDrawn(doc)
    parts.title.textContent = metadata.title
    parts.title.title = doc.path
    parts.title.classList.toggle('ws-declared-title', !!declaredTitle(doc.key)?.title || doc.provenance.some(p => p.kind === 'embed' && p.title))
    if (parts.provenance.title !== metadata.summary) {
      parts.provenance.textContent = metadata.summary
      parts.provenance.title = metadata.summary
    }
  }

  private measure(name: string, fallback: number): number {
    return workspaceMeasure(this.el, name, fallback)
  }
  private preferredWidth(doc: WorkspaceDocument, max: number, height: number): number {
    if (this.phone.matches) return max
    if (doc.kind === 'change') return Math.min(max, this.measure('change-width', 1200))
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
  private layout(animate: boolean): void {
    this.layoutNavbar()
    const ch = this.channel
    if (!ch || !this.active) return
    const W = this.stage.clientWidth, H = this.stage.clientHeight
    if (!W || !H) return
    const inset = this.measure('stage-inset', 28), top = this.measure('stage-top', 10), gap = this.measure('gap', 24)
    // The selected page fills the stage: its header line and its document are the reader's only frame.
    const boxW = W - inset * 2, boxH = H - top - inset
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
      const width = sel ? boxW : this.preferredWidth(doc, boxW, boxH)
      f.el.style.left = `${x}px`
      f.el.style.width = `${width}px`
      f.el.style.height = `${boxH}px`
      if (sel) centre = x + width / 2
      x += width + gap
    })
    const target = Math.round(W / 2 - centre)
    if (animate && !this.motion.matches && target !== this.trackX) this.opts.onCrossing?.(target - this.trackX)
    this.trackX = target
    if (!this.swiping) this.track.style.transform = `translateX(${target}px)`
  }
  private readonly relayout = (): void => {
    invalidateWorkspaceMeasures(this.el)
    if (this.active) this.paintFilesToggle()
    if (!this.phone.matches) this.el.classList.remove('ws-topbar-hidden')
    this.layout(false)
  }
  /** Expand takes the whole window: the board bar steps aside until it is restored. */
  private toggleExpand(): void {
    this.setExpanded(!this.expanded)
    this.paint(true)
  }
  private setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.el.classList.toggle('ws-expand-mode', expanded)
    invalidateWorkspaceMeasures(this.el)
    this.opts.onExpand?.(expanded)
  }
  private openMenu(doc: WorkspaceDocument, anchor: HTMLElement): void {
    const same = this.menuAnchor === anchor
    this.closeMenu()
    if (same) return
    const menu = element('div', 'ws-menu')
    menu.setAttribute('aria-label', 'Document and constitution actions')
    const url = isDrawn(doc) ? window.location.href : fileBytesUrl(this.opts.shuttleBase, doc.path, doc.owner)
    for (const [label, download] of (doc.kind === 'family' ? [['Open in new tab', false]] : [['Open in new tab', false], ['Download', true]]) as Array<[string, boolean]>) {
      const a = element('a', 'ws-menu-item', label)
      a.href = isDrawn(doc) && download ? fileBytesUrl(this.opts.shuttleBase, doc.path, doc.owner) : url
      if (download) a.download = doc.name
      else { a.target = '_blank'; a.rel = 'noopener' }
      menu.append(a)
    }
    menu.append(button('ws-menu-item', 'Copy path', () => {
      void navigator.clipboard?.writeText(doc.path).then(() => showToast('Path copied')).catch(() => showToast('Couldn’t copy path', 'error'))
      this.closeMenu()
    }))
    if (doc.kind !== 'family') menu.append(button('ws-menu-item', 'Refresh', () => { this.host.refresh(doc.key); this.closeMenu() }))
    const receipts = element('details', 'ws-receipts')
    const sends = doc.provenance.filter(p => p.kind === 'sent')
    receipts.append(element('summary', '', `Receipts (${sends.length})`))
    for (const p of [...sends].reverse()) {
      if (p.kind === 'sent') receipts.append(element('div', '', `${instantStamp(p.time)} · ${p.worker ?? ''} · ${p.session ?? ''}`))
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
  private readonly pointerInput = (): void => { this.keyboardInput = false; this.el.classList.remove('ws-keyboard') }
  private readonly keyboardModality = (): void => { this.keyboardInput = true; this.el.classList.add('ws-keyboard') }
  private readonly outside = (e: PointerEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node) && !this.menuAnchor?.contains(e.target as Node)) this.closeMenu()
  }
  private openSwitcher(): void {
    if (!this.phone.matches && this.opts.onFind?.()) return
    if (this.picker.isOpen) { this.picker.close(); return }
    this.closeMenu()
    this.picker.show(this.el, this.title)
  }
  /** Re-list the channel rows after the overview's order changes. */
  refreshChannels(): void {
    if (this.active && this.picker.isOpen) this.picker.refresh()
  }
  /** The phone's top bar holds the toggle, marked while a sent file is unread. */
  private paintFilesToggle(): void {
    const documents = this.channel ? sentDocuments(this.channel) : []
    this.filesToggle.hidden = !documents.length
    this.filesToggle.setAttribute('aria-expanded', String(this.pageSheet.isOpen))
    this.filesToggle.toggleAttribute('data-attention', this.fresh.size > 0)
  }
  private readonly keydown = (e: KeyboardEvent): void => {
    if (this.pageSheet.isOpen || this.settingsMenu.isOpen) return
    this.keyboardModality()
    if (!this.active || e.isComposing || e.defaultPrevented || blockingDialogOpen()) return
    if ((e.key === 'Enter' || e.key === 'Escape') && this.picker.el.contains(e.target as Node)) return
    // Activation belongs to the focused control, including command-modified keys.
    if (['Enter', ' '].includes(e.key) && !shouldForwardDocumentKey({ target: e.target, defaultPrevented: false, key: e.key })) return
    // Alt chords never bypass editable/native control guards; command shortcuts may.
    const forward = shouldForwardDocumentKey(e)
    if (e.altKey && !forward) return
    // Native controls own activation and composite navigation.
    if (!forward && !e.metaKey && !e.ctrlKey) return
    const intent = keyIntent(e, 'reader')
    if (intent && this.handleIntent(intent, e.repeat, e.key === 'Escape')) {
      e.preventDefault(); e.stopImmediatePropagation()
    }
  }
  private handleIntent(intent: KeyIntent, repeat = false, escape = false): boolean {
    if (intent === 'help') return false
    if (intent === 'back') {
      if (repeat) return true
      if (this.picker.isOpen) this.picker.close(true)
      else if (this.menu) { const anchor = this.menuAnchor; this.closeMenu(); anchor?.focus({ preventScroll: true }) }
      else if (this.opts.onEscapeLayer?.()) { /* An inline control popover consumed Escape. */ }
      else if (escape && this.expanded) this.toggleExpand()
      else this.back()
      return true
    }
    if (intent === 'orchestrator') return this.opts.onOrchestrator?.() ?? false
    if (intent === 'tapestry') return this.opts.onTapestry?.() ?? false
    const actionCard = this.currentCard && (this.opts.actionCard?.(this.currentCard) ?? this.currentCard)
    if (constitutionAction(intent, actionCard, {
      verdict: (_, verdict) => this.opts.onVerdict?.(verdict),
      conversation: card => this.opts.onConversation?.(card),
      rest: card => this.opts.onRest?.(card, this.el),
    })) return true
    if (intent === 'find') {
      if (!this.phone.matches && this.opts.onFind?.()) { /* The board bar's Find serves the reader too. */ }
      else if (this.picker.isOpen) this.picker.focus()
      else this.openSwitcher()
    }
    else if (intent === 'open') this.toggleExpand()
    else if (intent === 'prevChannel' || intent === 'nextChannel') {
      const cards = this.deskCards()
      const index = this.deskPosition(cards)
      const card = cards[index + (intent === 'prevChannel' ? -1 : 1)]
      if (index >= 0 && card) this.step(card)
    } else if (intent === 'prevGroup' || intent === 'nextGroup') {
      const cards = this.deskCards()
      const index = this.deskPosition(cards)
      this.rememberStop()
      const card = groupJump(cards, index, intent === 'prevGroup' ? -1 : 1, this.stopOf, deskCardKey, this.groupMemory)
      if (card) this.step(card)
    } else if (['scrollDown', 'scrollUp', 'halfDown', 'halfUp', 'pageDown', 'pageUp'].includes(intent)) this.scrollDocument(intent, repeat)
    else return false
    return true
  }

  private readonly stopOf = (card: KanbanCard): string => this.opts.deskStop?.(card) ?? ''
  private rememberStop(): void {
    if (!this.currentCard) return
    const identity = deskCardKey(this.currentCard)
    const stop = groupStops(this.deskCards(), this.stopOf).find(run => run.cards.some(card => deskCardKey(card) === identity))
    if (stop) this.groupMemory.set(stop.key, identity)
  }
  /**
   * The open constitution joins the list it is missing from: right after its
   * family's Desk row, which keeps it in that row's group; else after the
   * nearest ancestor the list holds; anything else at the end.
   */
  private withCurrent(cards: KanbanCard[]): KanbanCard[] {
    const current = this.currentCard
    if (!current || cards.some(card => deskCardKey(card) === deskCardKey(current))) return cards
    const index = this.opts.threadIndex?.()
    const lead = index?.family(index.card(current)).lead
    const row = lead ? cards.findIndex(card => deskCardKey(card) === deskCardKey(lead)) : -1
    if (row >= 0) return [...cards.slice(0, row + 1), current, ...cards.slice(row + 1)]
    for (let parent = index?.parentOf(current); parent; parent = index!.parentOf(parent)) {
      const at = cards.findIndex(card => deskCardKey(card) === deskCardKey(parent!))
      if (at >= 0) return [...cards.slice(0, at + 1), current, ...cards.slice(at + 1)]
    }
    return [...cards, current]
  }
  private deskPosition(cards: KanbanCard[]): number {
    return cards.findIndex(card => (card.uid ?? card.id) === this.channel?.uid && card.originId === this.channel?.owner)
  }
  /** The Desk's rows, which j/k and J/K walk, with the open constitution among them. */
  private deskCards(): KanbanCard[] { return this.withCurrent(this.opts.deskCards?.() ?? this.opts.cards()) }
  /** With no list on screen, a brief toast says where the step landed. */
  private step(card: KanbanCard): void {
    showToast([this.stopOf(card), card.name].filter(Boolean).join(' · '), 'success', STEP_CUE)
    ;(this.opts.onScan ?? this.opts.onChannel)(card)
  }

  private scrollDocument(intent: KeyIntent, repeat: boolean): void {
    const doc = this.document
    const viewer = doc && this.host.get(doc.key)?.viewer
    if (!doc || !viewer || !['fiber', 'family', 'html', 'markdown', 'text', 'code', 'change'].includes(doc.kind)) return
    let scroller = viewer.querySelector<HTMLElement>('.ws-prose-scroll,.ws-family-scroll,.kbn-fileview-text,.change-scroll')
    if (isDrawn(doc)) scroller = viewer.matches('.ws-prose-scroll') ? viewer : scroller
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
    this.closeMenu()
    this.stopSwipe()
    this.clearSwipeWatchdog()
    this.pageSheet.dispose()
    this.settingsMenu.dispose()
    this.observer?.disconnect()
    window.removeEventListener('resize', this.relayout)
    cancelAnimationFrame(this.instantRaf)
    cancelAnimationFrame(this.arrival)
    if (this.departure !== null) clearTimeout(this.departure)
    this.stopTitles()
    this.picker.dispose()
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
