import { ThreadIndex } from '../threads.js'
import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import type { Dock } from './Dock.js'
import { Verdicts, confirmWorkerStop, type Verdict } from './Verdicts.js'
import { fiberPageKicker, onDesk, reviewReachable, verdictReachable } from './fiberPageState.js'
import { holdsRevision, roleHolds, roleSlug } from './RolePage.js'
import type { DispatchFailureBody } from '../KanbanModalShared.js'
import { readFiber } from './fiberSource.js'
import { inLane } from '../requestLanes.js'
import { cardFromCompositeEntry, IN_FLIGHT_BANDS, inFlightBand } from '../KanbanReadModel.js'
import { deskColumn } from '../deskColumn.js'
import { sidebarAnchor } from './SidebarOutline.js'
import { normalizeShelfFiles } from '../views/shelfData.js'
import type { ShelfFile } from '../views/shelfData.js'
import { fileBytesUrl, renderMarkdown, showToast } from '../utils.js'
import type { DeskPlacement } from '../deskOrdering.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { channelLead, familyKey, isDrawn, leadReceipt, buildChannel, normalizeAbsolutePath, defaultSelection, docKey, fallbackSelection, parseDocKey, proseDocument, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'
import { meetingHostCard, type MeetingRecord } from '../meeting.js'
import { buildFiberProse } from './FiberProse.js'
import { bindConstitutionMentions } from './bodyLinks.js'
import { frameBridge } from './DocumentBridge.js'
import './mentions.css'
import { Reader } from './Reader.js'
import { WorkspaceDepth } from './Depth.js'
import { cardIdentity, type SidebarEntry } from './SidebarFlight.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'
import { TranscriptResults } from './TranscriptResults.js'
import { Overview } from './Overview.js'
import { FamilyPage } from './FamilyPage.js'
import { FamilyActivity } from './familyActivity.js'
import { unseenSince } from './DocumentSeen.js'
import type { FiberSend } from '../fiberSends.js'
import { parseRoute, WorkspaceHistory, type WorkspaceOriginView, type WorkspaceRoute } from './route.js'
import { ChannelThemes } from './ChannelThemes.js'
import { changeReviewTarget } from './changeReviewTarget.js'

export interface WorkspaceOptions {
  /** The current response's thread graph, built once per response. */
  threadIndex?(): ThreadIndex
  shuttleBase: string
  cards(): KanbanCard[]
  /** The active Desk projection, already in the Desk's visible reading order. */
  deskRows(): KanbanCard[]
  /** The same projection's column and caption for each visible Desk row. */
  deskPlacement?(card: KanbanCard): DeskPlacement | undefined
  origin(): string
  onVisibility(active: boolean): void
  onVoiceCard?(card: KanbanCard | null): void
  deskColumn?(card: KanbanCard): SidebarEntry[]
  onReturnCard?(card: KanbanCard): void
  onEscapeHome?(): void
  /** A history entry addressed a board view or channel origin; switch to it without pushing. */
  onView?(view: WorkspaceView): void
  dock: Dock
  /** The board bar's Find field, shared by every view on the desktop. */
  find?: HTMLInputElement
  /** Focus the board bar's Find; false where the bar has none (the phone). */
  focusFind?(): boolean
  /** Expand has taken, or given back, the whole window. */
  onExpand?(expanded: boolean): void
  onRest?(card: KanbanCard, anchor: HTMLElement): void
  /** A card's sent files, newest first. */
  sends?(card: KanbanCard): FiberSend[]
  /** Asks for the sent-file feed; throttled by its reader. */
  refreshSends?(): void
}
interface ChannelState {
  card: KanbanCard
  channel: Channel
  links: Array<{ path: string; owner?: string; title?: string }>
  fileModifiedAt: Map<DocKey, string>
  /** The owner file-time reads in flight, at most one per channel. */
  metadataRead?: Promise<boolean>
  selected?: DocKey
  /** The next arrival lands on the channel's lead page, whatever it last showed. */
  leadLanding?: boolean
  routedFile?: DocKey
  loaded: boolean
  familyPage?: FamilyPage
  /** The run is final: body and receipts are both in, or the body read failed. The strip waits for it. */
  runFinal: boolean
  metadataKnown: boolean
  error?: string
}
export type WorkspaceView = WorkspaceOriginView
const VIEW_HASHES: Record<string, WorkspaceView> = { '#/desk': 'desk', '#/chronicle': 'chronicle', '#/board': 'board' }
const VIEW_LABELS: Record<WorkspaceView, string> = { desk: 'Desk', chronicle: 'Chronicle', board: 'Board' }
const viewForOrigin = (origin: string): WorkspaceOriginView => origin === 'Desk' ? 'desk' : origin === 'Chronicle' ? 'chronicle' : 'board'
const channelId = (uid: string, owner: string): string => JSON.stringify([owner, uid])
const pageLabel = (doc: WorkspaceDocument): string => doc.kind === 'fiber' ? 'Constitution' : doc.name
const threadFamilyRevision = (card: KanbanCard, index: ThreadIndex): string => {
  const current = index.card(card)
  const ancestry = index.ancestry(current).flatMap(entry => entry.card ? [index.card(entry.card)] : [])
  const scope = ancestry[0] ?? current
  return JSON.stringify({ card: current, ancestry, family: [scope, ...index.subtree(scope)], summary: index.summary(scope) })
}
/** The Board's Read lately shelf holds this many constitutions. */
const READ_LATELY = 8

/** Routes, owner-addressed sources and per-channel selection for one reader. */
export class Workspace {
  readonly reader: Reader
  readonly overview: Overview
  readonly dock: Dock
  private readonly verdicts = new Verdicts()
  private readonly activity: FamilyActivity
  private readonly picker: ConstitutionPicker
  /** The list the board bar's Find hangs beneath itself; the phone, without that field, uses `picker`. */
  private readonly barPicker: ConstitutionPicker
  private readonly themes: ChannelThemes
  private readonly root: HTMLElement
  private readonly depth: WorkspaceDepth
  private readonly opts: WorkspaceOptions
  private readonly history: WorkspaceHistory
  private readonly channels = new Map<string, ChannelState>()
  private readonly proseRevisions = new Map<DocKey, string>()
  private current: ChannelState | null = null
  /** Constitutions opened in this session, most recent first. */
  private readLately: string[] = []
  private column: SidebarEntry[] | null = null
  private origin = 'Board'
  private readonly receipts = new Map<string, { files: ShelfFile[]; etag?: string }>()
  private readonly receiptsRead = new Map<string, Promise<void>>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly mentions: ReturnType<typeof bindConstitutionMentions>
  private timer: number | null = null
  private disposed = false
  private routeEpoch = 0
  private lastBoardRoute: Extract<WorkspaceRoute, { kind: 'channel' }> | null = null
  private startPrompt: { card: KanbanCard; failure: DispatchFailureBody } | null = null
  /** The complete board-card payload used by the reader's thread and runtime surfaces. */
  private lastUpdateRevision = ''
  private lastRenderedFamilyRevision = ''

  constructor(root: HTMLElement, opts: WorkspaceOptions) {
    this.opts = opts
    this.root = root
    this.activity = new FamilyActivity(opts.shuttleBase, () => { if (this.current && this.isActive) this.current.familyPage?.update(this.current.card, this.graph()) })
    this.mentions = bindConstitutionMentions(root, opts.cards, (id, origin) => { void this.openFiber(id, origin) }, {
      shuttleBase: opts.shuttleBase, frameActive: frame => frameBridge(frame)?.active ?? null,
    })
    this.depth = new WorkspaceDepth(root)
    this.origin = opts.origin()
    this.history = new WorkspaceHistory(route => { void this.applyRoute(route) })
    this.dock = opts.dock
    const meetingHost = (meeting: MeetingRecord): KanbanCard | undefined => meetingHostCard(meeting, this.opts.cards()) ?? undefined
    this.dock.setMeetingHostOpen(meeting => {
      if (!meeting.fiber) return
      const host = meetingHost(meeting)
      if (host) this.open(host, this.origin, undefined, this.overview.hasMetadata(host), false)
      else if (meeting.mirror_host ?? meeting.recorder) void this.openFiber(meeting.fiber, meeting.mirror_host ?? meeting.recorder!)
    }, meeting => {
      const host = meetingHost(meeting)
      return (host?.id ?? meeting.fiber)?.split('/').at(-1) ?? host?.name
    })
    this.dock.setVerdictQueue((card, verdict) => this.queueVerdict(card, verdict))
    this.themes = new ChannelThemes(opts.shuttleBase)
    this.overview = new Overview({
      shuttleBase: opts.shuttleBase,
      themes: this.themes,
      cards: opts.cards,
      onOpen: (card, doc) => this.open(card, 'Board', doc, this.overview.hasMetadata(card)),
      onEscapeHome: opts.onEscapeHome,
      onConversation: card => { this.dock.openConversation(card) },
      hasConversation: card => !!this.dock.workerPillFor(card)?.matches('a[href],button'),
      onOrder: () => { this.reader?.refreshChannels(); this.picker?.refresh(); if (this.barPicker?.isOpen) this.barPicker.refresh() },
      focusFind: () => opts.focusFind?.() ?? false,
      readLately: () => this.readLatelyCards(),
    })
    const pickerOptions = {
      cards: () => {
        const ordered = this.overview.orderedCards()
        return [...ordered, ...opts.cards().filter(card => !ordered.some(row => (row.uid ?? row.id) === (card.uid ?? card.id) && row.originId === card.originId))]
      },
      files: (card: KanbanCard) => this.overview.fileNames(card),
      onOpen: (card: KanbanCard) => {
        this.clearFind()
        this.open(card, this.isActive ? this.origin : opts.origin(), undefined, this.overview.hasMetadata(card), false)
      },
    }
    this.picker = new ConstitutionPicker(pickerOptions)
    this.barPicker = new ConstitutionPicker({
      ...pickerOptions, find: opts.find, active: () => this.barPicker.isOpen,
      supplement: opts.find ? new TranscriptResults(opts.shuttleBase) : undefined,
      onEscape: () => { this.clearFind(); opts.find?.blur(); (document.activeElement as HTMLElement | null)?.blur?.() },
    })
    const reviewTarget = (source: WorkspaceDocument) => changeReviewTarget(source, opts.cards())
    this.reader = new Reader({
      shuttleBase: opts.shuttleBase,
      themes: this.themes,
      cards: () => this.origin === 'Board' ? this.overview.orderedCards() : opts.cards(),
      threadIndex: () => opts.threadIndex?.() ?? new ThreadIndex(opts.cards()),
      switcherCards: () => this.sidebarCards(),
      pickerCards: () => this.overview.orderedCards(),
      sidebarBand: card => this.sidebarGroup(card),
      sidebarColumn: card => this.sidebarColumn(card),
      files: card => this.overview.fileNames(card),
      find: opts.find,
      onFind: () => opts.focusFind?.() ?? false,
      onExpand: expanded => opts.onExpand?.(expanded),
      onSelect: key => this.visit(key),
      onNavigate: (source, href) => this.openRelative(source, href),
      canReview: source => reviewTarget(source)?.live ?? false,
      reviewTarget: source => reviewTarget(source)?.label ?? 'no known fiber holding this bundle',
      onReview: async (source, message) => {
        const target = reviewTarget(source)
        if (!target) throw new Error('The fiber holding this bundle is no longer available. Your draft is saved.')
        await this.dock.sendReview(target.card, message)
      },
      onCrossing: travel => this.depth.cross(travel),
      onReturn: () => this.history.back(),
      onOpenDocument: key => this.visit(key),
      onRevisitDocument: key => this.revisit(key),
      workerPill: card => this.dock.workerPillFor(card),
      onVerdict: verdict => this.deferVerdict(verdict),
      onConversation: card => { this.dock.openConversation(this.mapSelection() ?? card) },
      onRest: (card, anchor) => this.opts.onRest?.(card, anchor),
      onEscapeLayer: () => this.controls(this.current)?.handleEscape() ?? false,
      onChannel: card => this.open(card, this.origin, undefined, this.overview.hasMetadata(card)),
      onScan: card => this.open(card, this.origin, undefined, this.overview.hasMetadata(card), true, true),
      onOrchestrator: () => this.openOrchestrator(),
      onTapestry: () => this.toggleMap(),
      onDrawing: () => this.cycleDrawing(),
      buildProse: doc => doc.kind === 'family' ? this.family() : this.prose(doc.key),
      onRefreshProse: async doc => {
        const state = [...this.channels.values()].find(s => proseDocument(s.channel)?.key === doc.key)
        if (!state) return
        await this.load(state)
        if (this.current === state && this.isActive) this.show(state)
      },
    })
    root.append(this.reader.el)
    this.history.start()
    this.overview.refresh()
    document.addEventListener('visibilitychange', this.visibility)
  }

  get isActive(): boolean { return this.reader.isActive }
  /**
   * The board bar's Find, routed by what it serves now: the open sidebar's
   * list in the reader, the sheet's folios on the Board, and otherwise a
   * list of constitutions hung beneath the field.
   */
  find(board: boolean): void {
    const input = this.opts.find
    if (!input) return
    if (this.isActive && this.reader.sidebarVisible) return
    if (!this.isActive && board) { this.overview.setQuery(input.value); return }
    if (!this.barPicker.isOpen) this.barPicker.show(this.root, input)
    else this.barPicker.refresh()
    this.overview.refresh()
  }
  /** Close the Find's list, if it hangs open. */
  closeFind(): void { this.barPicker.close() }
  /** Empty the bar's Find and lift whatever it filtered. */
  clearFind(): void {
    const input = this.opts.find
    this.barPicker.close()
    if (!input?.value) return
    input.value = ''
    this.overview.setQuery('')
    this.reader.refreshChannels()
  }
  /** Return from the reader to the view it was opened from, as Escape does. */
  returnToOrigin(): void {
    if (!this.isActive) return
    if (this.origin === 'Board') this.lastBoardRoute = null
    this.history.leave()
  }
  /** The header's close control returns to Desk, regardless of its origin view. */
  escapeHome(): void { this.history.view('#/desk') }
  /** Opens over the Desk without navigating or waking the reader. */
  findConstitution(): void {
    this.picker.show(this.root)
    this.overview.refresh()
  }
  /** A refused Desk launch enters the document channel and exposes its recovery form. */
  openStartPrompt(card: KanbanCard, failure: DispatchFailureBody): void {
    this.startPrompt = { card, failure }
    this.open(card)
  }

  /** A Question card leads with its report, even after a previous visit to prose. */
  openQuestion(card: KanbanCard): void {
    this.landOnLead(this.ensure(card))
    this.open(card)
  }
  private landOnLead(state: ChannelState): void {
    state.leadLanding = true
    state.selected = undefined
  }
  /**
   * A thread opened from the map arrives on its own lead page, the map one key
   * away; a sent file arrives on that file.
   */
  private openFromMap(card: KanbanCard, doc?: DocKey): void {
    const known = this.overview.hasMetadata(card), state = this.ensure(card, known)
    if (doc) { this.open(card, this.origin, doc, known); return }
    if (state === this.current) { this.visit(this.leadPage(state)); return }
    this.landOnLead(state)
    this.open(card, this.origin, undefined, known)
  }
  private leadPage(state: ChannelState): DocKey {
    return (channelLead(state.channel) ?? proseDocument(state.channel)!).key
  }

  /** The family's view among this card's pages, or none outside a family. */
  familyDocument(card: KanbanCard): DocKey | undefined {
    return this.inFamily(card) ? familyKey(card.originId, card.uid ?? card.id) : undefined
  }
  private refreshFamilyFeeds(): void {
    this.activity.refresh()
    this.opts.refreshSends?.()
  }
  /** The sent-file feed moved: the open map redraws. */
  sendsChanged(): void {
    if (this.current && this.isActive) this.current.familyPage?.update(this.current.card, this.graph())
  }
  private graph(): ThreadIndex { return this.opts.threadIndex?.() ?? new ThreadIndex(this.opts.cards()) }
  /** A fiber in a family of threads carries the family's view among its pages. */
  private inFamily(card: KanbanCard): boolean {
    const index = this.graph(), current = index.card(card)
    return index.children(index.family(current).root).length > 0
  }
  /** The constitution's own threads make the family's view its landing. */
  private familyLanding(state: ChannelState): DocKey | undefined {
    const index = this.graph()
    return index.children(index.card(state.card)).length ? familyKey(state.channel.owner, state.channel.uid) : undefined
  }

  /** The open thread's orchestrator; false outside a thread. */
  private orchestrator(card: KanbanCard): KanbanCard | undefined {
    const index = this.opts.threadIndex?.()
    return index?.parentOf(index.card(card))
  }
  openOrchestrator(): boolean {
    const parent = this.current && this.isActive ? this.orchestrator(this.current.card) : undefined
    if (!parent) return false
    this.open(parent, this.origin, undefined, this.overview.hasMetadata(parent))
    return true
  }

  /** The map's page to its report or constitution, any other page of the channel to the map. */
  private toggleMap(): boolean {
    const state = this.current
    const map = state && this.isActive ? this.familyDocument(state.card) : undefined
    if (!state || !map) return false
    const onMap = this.shown(state) === map
    this.visit(onMap ? this.leadPage(state) : map)
    return true
  }
  private cycleDrawing(): boolean {
    const state = this.current
    if (!state?.familyPage || !this.isActive || this.shown(state) !== this.familyDocument(state.card)) return false
    state.familyPage.cycle()
    return true
  }

  open(card: KanbanCard, origin = this.opts.origin(), doc?: DocKey, authoritative = true, fromDeskColumn = true, scan = false): void {
    const outsideColumn = this.isActive && this.column && !this.column.some(entry => cardIdentity(entry.card) === cardIdentity(card))
    if (!this.isActive || origin !== this.origin || outsideColumn || !fromDeskColumn) {
      const column = fromDeskColumn && !outsideColumn && origin === 'Desk' ? this.opts.deskColumn?.(card) : undefined
      this.column = column?.length ? column : null
      this.reader.captureSidebar(this.column ?? [])
    }
    this.origin = origin
    const id = cardIdentity(card)
    this.readLately = [id, ...this.readLately.filter(seen => seen !== id)].slice(0, READ_LATELY * 2)
    const state = this.ensure(card, authoritative)
    this.overview.opened(card, state.metadataKnown)
    this.history.enter(state.channel.uid, state.channel.owner, doc ?? state.selected, viewForOrigin(origin), scan)
  }

  /**
   * The sidebar is one grouped list wherever the reader was opened from, in
   * the Desk's reading order: Drafts, In flight's Your turn and Working bands,
   * Awaiting review, Roles, then Resting, each in the Desk's own order. j/k
   * walk it as one flow; J/K and the index strip step its columns.
   */
  private sidebarCards(): KanbanCard[] {
    return this.opts.deskRows()
  }
  /** Resolve a family page through its root, regardless of which thread leads its need. */
  private sidebarRoot(card: KanbanCard): KanbanCard {
    const index = this.opts.threadIndex?.()
    return index ? index.family(index.card(card)).root : card
  }
  private sidebarCaptionCard(card: KanbanCard): KanbanCard {
    const root = this.sidebarRoot(card), index = this.opts.threadIndex?.()
    const onDesk = (candidate: KanbanCard) => this.opts.deskRows().some(row => cardIdentity(row) === cardIdentity(candidate))
    const anchor = index ? sidebarAnchor(index, root) : root
    if (onDesk(anchor)) return anchor
    if (onDesk(root)) return root
    return index?.family(root).lead ?? root
  }
  /** Resolve the root's Desk column, or its lead's when the root is absent. */
  private sidebarPlace(card: KanbanCard): string {
    const root = this.sidebarCaptionCard(card)
    const column = this.opts.deskPlacement?.(root)?.column ?? deskColumn(root)
    return column === 'scheduled' ? 'resting' : column
  }
  /** A Desk row keeps its Desk caption; an unplaced current page gets its own run. */
  private sidebarGroup(card: KanbanCard): string {
    const root = this.sidebarCaptionCard(card)
    const placement = this.opts.deskPlacement?.(root)
    if (placement) return placement.group
    if (this.isOpenPage(card)) return 'Open'
    if (this.sidebarPlace(root) === 'inFlight') return IN_FLIGHT_BANDS.find(([band]) => band === inFlightBand(root))![1]
    return this.sidebarColumn(card)
  }
  /** A card's Desk column: In flight holds both its bands' groups. */
  private sidebarColumn(card: KanbanCard): string {
    const root = this.sidebarCaptionCard(card)
    const placement = this.opts.deskPlacement?.(root)
    if (!placement && this.isOpenPage(card)) return 'Open'
    const column = placement?.column ?? this.sidebarPlace(root)
    if (column === 'inFlight') return 'In flight'
    if (column === 'drafts') return 'Drafts'
    if (column === 'awaitingReview') return 'Awaiting review'
    if (column === 'roles') return 'Roles'
    if (column === 'resting') return 'Resting'
    return fiberPageKicker(card) || 'Reading'
  }
  /** The current Reader page is outside the drawn Desk projection. */
  private isOpenPage(card: KanbanCard): boolean {
    const current = this.current?.card
    if (!current || cardIdentity(current) !== cardIdentity(card)) return false
    const root = this.sidebarCaptionCard(card)
    if (this.opts.deskPlacement?.(root)) return false
    return !this.opts.deskRows().some(row => cardIdentity(row) === cardIdentity(root))
  }
  /** The constitutions opened in this session, most recent first, for the Board's Read lately shelf. */
  private readLatelyCards(): KanbanCard[] {
    const live = new Map(this.opts.cards().map(card => [cardIdentity(card), card]))
    return this.readLately.flatMap(id => {
      const card = live.get(id) ?? this.channels.get(id)?.card
      return card ? [card] : []
    }).slice(0, READ_LATELY)
  }

  mountOverview(host: HTMLElement): void {
    if (this.overview.el.parentElement !== host) host.append(this.overview.el)
    this.depth.setActive(true)
    this.overview.setVisible(!this.isActive)
    this.overview.refresh()
  }
  hideOverview(): void {
    this.overview.setVisible(false)
    this.depth.setActive(this.isActive)
  }
  handleOverviewEscapeLayer(): boolean { return this.overview.handleEscapeLayer() }

  /** View keys park the reader; Board restores its last unreturned channel. */
  suspend(view: 'desk' | 'chronicle'): void {
    this.history.view(`#/${view}`)
  }
  showBoard(): void {
    const remembered = this.lastBoardRoute
    this.history.view()
    this.origin = 'Board'
    if (remembered) this.history.enter(remembered.uid, remembered.owner, remembered.doc)
  }

  /** Keep worker metadata current without rebuilding live file instruments. */
  update(): void {
    if (!this.current || !this.isActive) {
      this.mentions.refresh()
      this.overview.cardsChanged()
      return
    }
    const cards = this.opts.cards()
    const revision = JSON.stringify([
      cards,
      cards.map(card => {
        const placement = this.opts.deskPlacement?.(card)
        return placement ? [placement.column, placement.group] : null
      }),
    ])
    const changed = revision !== this.lastUpdateRevision
    if (changed) this.lastUpdateRevision = revision
    const card = cards.find(c => (c.uid ?? c.id) === this.current?.channel.uid && c.originId === this.current.channel.owner)
    // A fiber outside the feed (a role, a note) keeps its card; a role page still follows its holds.
    if (!card) {
      this.mentions.refresh()
      this.overview.cardsChanged()
      if (changed) this.reader.refreshChannels()
      this.refreshProse(this.current)
      return
    }
    if (!changed) return
    this.mentions.refresh()
    this.overview.cardsChanged()
    if (threadFamilyRevision(card, this.opts.threadIndex?.() ?? new ThreadIndex(cards)) === this.lastRenderedFamilyRevision) {
      this.reader.refreshChannels()
      return
    }
    this.current.card = card
    this.current.channel = {
      ...this.current.channel, name: card.name, outcome: card.outcome ?? this.current.channel.outcome,
      documents: this.current.channel.documents.map(doc => doc.kind === 'fiber' ? { ...doc, modifiedAt: card.modifiedAt } : doc),
    }
    this.show(this.current)
  }

  private deferVerdict(verdict: Verdict): void {
    const state = this.current
    if (!state?.metadataKnown || !verdictReachable(state.card)) return
    this.queueVerdict(state.card, verdict)
  }
  /** Desk, plates, act-zone buttons and keys authorize the same delayed write.
   * Answers whether the verdict entered its undo window. */
  queueVerdict(requested: KanbanCard, verdict: Verdict): boolean {
    const uid = requested.uid ?? requested.id, owner = requested.originId
    const state = this.channels.get(channelId(uid, owner))
    const resolve = (): KanbanCard | undefined => this.opts.cards().find(card => (card.uid ?? card.id) === uid && card.originId === owner)
    const indexed = resolve()
    // Linked fibers can be outside the board index; cached metadata only labels the undo line.
    if (!indexed && !state?.metadataKnown) return false
    const card = indexed ?? requested
    if (verdict === 'awaitingReview' && !reviewReachable(card)) return false
    const review = deskColumn(card) === 'awaitingReview'
    // Ask while the gesture is fresh; the undo window carries the answer to the write.
    if (!confirmWorkerStop(card, verdict)) return false
    const workerStopConfirmed = hasWorkerToStop(card)
    this.verdicts.queue(card, verdict, async () => {
      let live = resolve()
      if (!live && !indexed) {
        try {
          live = cardFromCompositeEntry(await readFiber(this.opts.shuttleBase, uid, owner))
        } catch { /* An unreachable or missing identity cannot authorize a write. */ }
      }
      if (this.disposed) return
      if (!live || (live.uid ?? live.id) !== uid || live.originId !== owner) {
        showToast(`${card.name} is no longer available; verdict not written`, 'error')
        return
      }
      // A worker may start during the undo window; never stop it from a stale review.
      if (review && deskColumn(live) !== 'awaitingReview') {
        showToast(`${live.name} no longer awaits review; verdict not written`, 'error')
        return
      }
      if (verdict === 'awaitingReview' && !reviewReachable(live)) {
        showToast(`${live.name} is no longer in progress; not moved to review`, 'error')
        return
      }
      if (hasWorkerToStop(live) && !workerStopConfirmed) {
        showToast(`${live.name} has a worker now; verdict not written`, 'error')
        return
      }
      this.dock.commitVerdict(live, verdict)
    })
    return true
  }
  /** The band belongs to fibers on the Desk's lifecycle; a note or role has none. */
  private controls(state: ChannelState | null): Dock | undefined {
    if (!state?.metadataKnown || state.channel.uid.startsWith('other:') || !onDesk(state.card)) return undefined
    this.dock.open(state.card)
    return this.dock
  }
  /** Seat the band over the channel's pages, with its links. */
  private seatBand(state: ChannelState): void {
    const dock = this.controls(state)
    this.reader.setBand(dock?.el ?? null)
    if (!dock) return
    const ancestry: KanbanCard[] = []
    for (let parent = this.orchestrator(state.card); parent; parent = this.orchestrator(parent)) ancestry.unshift(parent)
    dock.openSettings = (content, opener) => this.reader.showSettings(content, opener)
    dock.closeSettings = after => this.reader.closeSettings(after)
    dock.openFile = (path, title, owner) => this.openFile(path, title, owner)
    dock.setNav({
      ancestry: ancestry.map(card => ({ name: card.name, open: () => this.reader.closeSettings(() => { if (this.isActive) this.open(card, this.origin, undefined, this.overview.hasMetadata(card)) }) })),
      desk: () => this.escapeHome(),
      constitution: () => { const page = proseDocument(state.channel); if (page) this.visit(page.key) },
    })
  }
  private holds(state: ChannelState): KanbanCard[] {
    const slug = roleSlug(state.card)
    return slug ? roleHolds(this.opts.cards(), slug) : []
  }
  private proseRevision(state: ChannelState): string {
    return JSON.stringify([state.channel.body, state.channel.outcome, state.channel.labels, state.channel.documents.map(d => d.key), state.card.status, state.card.tempered, state.card.workerState, state.card.effectiveHorizon, state.card.shuttleAgent, state.card.shuttleRole, state.card.shuttleSeat, holdsRevision(this.holds(state)), state.error, state.loaded, state.metadataKnown])
  }
  private prose(key: DocKey): HTMLElement {
    const state = [...this.channels.values()].find(s => proseDocument(s.channel)?.key === key)
    if (!state) return document.createElement('div')
    this.proseRevisions.set(key, this.proseRevision(state))
    const page = buildFiberProse(state.card, state.channel, {
      shuttleBase: this.opts.shuttleBase,
      onFiber: id => { void this.openFiber(id, state.card.originId) },
      onFile: (path, title, owner?: string) => this.openFile(path, title, owner),
      holds: this.holds(state),
      onCard: card => { void this.openFiber(card.uid ?? card.id, card.originId) },
    })
    if (!state.loaded || state.error) {
      const note = document.createElement('p')
      note.className = 'ws-body-status'
      note.textContent = state.error ? `${state.error}${state.loaded ? ' — showing last loaded copy' : ''}` : 'Loading fiber body…'
      if (state.error) {
        const retry = document.createElement('button')
        retry.type = 'button'; retry.textContent = 'Retry'
        retry.addEventListener('click', () => { void this.load(state).then(() => { if (this.current === state && this.isActive) this.show(state) }) })
        note.append(' ', retry)
      }
      page.querySelector('.ws-prose')?.append(note)
    }
    return page
  }
  /** On the family's map, the thread it has selected. */
  private mapSelection(): KanbanCard | undefined {
    const state = this.current
    return state && state.selected === familyKey(state.channel.owner, state.channel.uid) ? state.familyPage?.selection : undefined
  }
  private family(): HTMLElement {
    const state = this.current!
    state.familyPage ??= new FamilyPage((card, doc) => this.openFromMap(card, doc), card => { this.dock.openConversation(card) }, {
      marks: card => this.activity.of(card.uid ?? card.id),
      files: card => (this.opts.sends?.(card) ?? []).map(send => ({ key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp) })),
      refresh: () => this.refreshFamilyFeeds(),
    }, () => { state.familyPage = undefined })
    state.familyPage.update(state.card, this.graph())
    return state.familyPage.el
  }
  private refreshProse(state: ChannelState): void {
    const key = proseDocument(state.channel)?.key
    if (!key || this.proseRevisions.get(key) === this.proseRevision(state) || !this.reader.host.get(key)?.viewer) return
    this.reader.host.updateProse(key, this.prose(key))
  }

  private ensure(card: KanbanCard, metadataKnown = true): ChannelState {
    const uid = card.uid ?? card.id
    const key = channelId(uid, card.originId)
    let state = this.channels.get(key)
    if (!state) {
      state = {
        card,
        channel: buildChannel({ uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: '', outcome: card.outcome, isConstitution: card.shuttleKind !== undefined, family: this.inFamily(card), modifiedAt: card.modifiedAt }),
        links: [], fileModifiedAt: new Map(), loaded: false, runFinal: false, metadataKnown,
      }
      this.channels.set(key, state)
    } else { state.card = card; state.metadataKnown ||= metadataKnown }
    return state
  }
  private fiberPath(card: KanbanCard): string {
    if (card.fiberDir) return `${card.fiberDir}/${card.path.endsWith('.md') ? card.path.split('/').at(-1) : `${card.id.split('/').at(-1)}.md`}`
    return card.path.startsWith('/') ? card.path : `${card.feltStore ?? ''}/${card.path}`
  }
  private async applyRoute(route: WorkspaceRoute): Promise<void> {
    const epoch = ++this.routeEpoch
    this.picker.close()
    this.barPicker.close()
    if (route.kind === 'overview') {
      const hash = route.hash ?? window.location.hash
      const view = VIEW_HASHES[hash] ?? this.history.originView
      if (view === 'desk' && this.origin === 'Desk' && this.current && this.isActive) this.opts.onReturnCard?.(this.current.card)
      this.reader.hide(view !== 'board')
      if (view === 'board') this.lastBoardRoute = null
      this.origin = VIEW_LABELS[view]
      this.opts.onView?.(view)
      this.overview.setVisible(view === 'board')
      this.depth.setActive(view === 'board')
      this.opts.onVisibility(false)
      this.opts.onVoiceCard?.(null)
      this.stopTimer()
      return
    }
    const originView = this.history.originView
    this.origin = VIEW_LABELS[originView]
    this.opts.onView?.(originView)
    let state = this.channels.get(channelId(route.uid, route.owner))
    if (!state) {
      const card = this.opts.cards().find(c => (c.uid ?? c.id) === route.uid && c.originId === route.owner)
      if (card) state = this.ensure(card)
      else state = this.ensure({
        id: route.uid, uid: route.uid, name: route.uid, path: '', originId: route.owner,
        status: '', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null,
      }, false)
    }
    const sameChannel = this.current === state && this.isActive
    if (sameChannel && state.loaded && state.runFinal && route.doc && state.channel.documents.some(doc => doc.key === route.doc)) {
      this.select(route.doc)
      this.reader.setBackDestination(this.history.backLabel)
      this.startTimer()
      return
    }
    this.current = state
    this.opts.onVoiceCard?.(state.card)
    for (const key of route.doc ? [route.doc] : []) {
      const file = parseDocKey(key)
      if (file && !state.links.some(link => link.path === file.path && (link.owner ?? state.card.originId) === file.owner)) state.links.push(file)
    }
    if (route.doc) this.rebuild(state)
    if (this.origin === 'Board') this.lastBoardRoute = route
    // Document navigation shares an in-flight channel read without starting another.
    const bodyRead = sameChannel ? this.loads.get(channelId(route.uid, route.owner)) ?? Promise.resolve() : this.load(state)
    // The sidebar and switcher list the overview's rows, so a channel entry reads them too.
    if (!sameChannel) {
      this.overview.opened(state.card, state.metadataKnown)
      this.overview.refresh()
    }
    this.overview.setVisible(false)
    // Selection resolves before the first paint; data arriving later never moves it.
    // A constitution with threads lands on their view; any other on its report.
    const wanted = route.doc ?? state.selected ?? (state.leadLanding ? channelLead(state.channel)?.key : this.familyLanding(state)) ?? this.knownReport(state)
    const loadedBefore = state.loaded && state.runFinal
    if (wanted) this.intend(state, wanted)
    this.opts.onVisibility(true)
    this.depth.setActive(true)
    this.show(state)
    const prompt = this.startPrompt
    if (prompt && (prompt.card.uid ?? prompt.card.id) === state.channel.uid && prompt.card.originId === state.channel.owner) {
      this.startPrompt = null
      this.dock.openStartPrompt(prompt.card, prompt.failure)
      if (!window.matchMedia('(max-width: 600px)').matches) this.dock.el.querySelector<HTMLElement>('.kbn-start-prompt input')?.focus({ preventScroll: true })
    }
    await bodyRead
    if (this.disposed || epoch !== this.routeEpoch || this.current !== state || !this.isActive) return
    if (state.leadLanding) {
      state.leadLanding = false
      state.selected = channelLead(state.channel)?.key
    }
    this.show(state, loadedBefore)
    this.startTimer()
  }
  /**
   * Hold a wanted page as the selection. A page the channel has not listed yet
   * gets a provisional frame now, so the reader starts on it rather than
   * jumping to it when the channel's documents arrive.
   */
  private intend(state: ChannelState, key: DocKey): void {
    state.selected = key
    if (state.channel.documents.some(d => d.key === key) || !parseDocKey(key)) return
    state.routedFile = key
    this.rebuild(state)
  }
  /** The report the Board's receipt feed already names for this channel, before the channel's own reads return. */
  private knownReport(state: ChannelState): DocKey | undefined {
    const card = state.card
    const receipts = this.overview.unfiledReceipts(state.channel.uid).filter(file => (file.host ?? card.originId) === card.originId)
    const report = leadReceipt(receipts, card.fiberDir, file => file.fullPath)
    return report ? docKey(card.originId, report.fullPath, card.originId, card.fiberDir) : undefined
  }
  /** The page on screen: the selection when the channel lists it, else the fiber's own page. */
  private shown(state: ChannelState): DocKey {
    const documents = state.channel.documents
    return state.selected && documents.some(d => d.key === state.selected) ? state.selected : proseDocument(state.channel)?.key ?? documents[0].key
  }
  private show(state: ChannelState, animate = true): void {
    const cards = this.opts.cards()
    this.lastRenderedFamilyRevision = threadFamilyRevision(state.card, this.opts.threadIndex?.() ?? new ThreadIndex(cards))
    if (state.channel.documents.some(doc => doc.kind === 'family') !== this.inFamily(state.card)) this.rebuild(state)
    state.familyPage?.update(state.card, this.graph())
    const ch = state.channel
    const selected = this.shown(state)
    this.refreshProse(state)
    this.namePage(state, selected)
    this.reader.setBackDestination(this.history.backLabel)
    this.reader.show(ch, selected, this.origin, state.card, animate, state.loaded && state.runFinal, state.runFinal)
    if (selected === this.familyDocument(state.card)) this.focusMap(state)
    if (this.origin === 'Board') this.lastBoardRoute = { kind: 'channel', uid: ch.uid, owner: ch.owner, doc: selected }
    this.seatBand(state)
  }
  /** The map takes the keys as it lands, unless a control in the reader already holds them. */
  private focusMap(state: ChannelState): void {
    const active = document.activeElement
    if (!active || active === document.body || active.matches('.ws-return, .ws-document-back') || active.closest('[inert]')) state.familyPage?.focus()
  }
  private namePage(state: ChannelState, key: DocKey): void {
    const doc = state.channel.documents.find(doc => doc.key === key)!
    this.history.name(state.channel.name, pageLabel(doc), key)
  }
  private visit(key: DocKey): void {
    const doc = this.current?.channel.documents.find(doc => doc.key === key)
    if (doc) this.history.openDocument(key, pageLabel(doc))
  }
  private revisit(key: DocKey): void {
    const doc = this.current?.channel.documents.find(doc => doc.key === key)
    if (doc) this.history.revisitDocument(key, pageLabel(doc))
  }
  private select(key: DocKey): void {
    const state = this.current
    if (!state || !state.channel.documents.some(d => d.key === key)) return
    state.selected = key
    state.routedFile = undefined
    this.reader.select(key)
    if (key === this.familyDocument(state.card)) this.focusMap(state)
    this.namePage(state, key)
    if (this.origin === 'Board') this.lastBoardRoute = { kind: 'channel', uid: state.channel.uid, owner: state.channel.owner, doc: key }
  }
  private isBodyFile(state: ChannelState, key: DocKey): boolean {
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown(state.channel.body, { basePath: state.card.fiberDir, originId: state.card.originId, projectDir: state.card.shuttleProjectDir })
    return Array.from(template.content.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')).some(link =>
      [link.dataset.filePath, link.dataset.filePathAlt].some(path => path && docKey(state.card.originId, path, state.card.originId, state.card.fiberDir) === key))
  }

  private openRelative(source: WorkspaceDocument, href: string): void {
    if (!href) return
    const route = parseRoute(href)
    if (route?.kind === 'channel') { this.history.enter(route.uid, route.owner, route.doc); return }
    if (route?.kind === 'overview' || href === '#/desk' || href === '#/chronicle') { this.history.view(href); return }
    if (href.startsWith('#')) return
    let path: string, hash: string, owner = source.owner
    try {
      const url = new URL(href, window.location.href)
      const explicit = url.pathname === '/api/v1/file' && url.searchParams.has('path')
      if (explicit) {
        path = url.searchParams.get('path')!
        owner = url.searchParams.get('origin') || owner
      } else {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return
        path = decodeURIComponent(href.split(/[?#]/)[0])
      }
      hash = url.hash
    } catch { return }
    if (!path || path.includes('\0') || path.includes('\\')) return
    this.openFile(normalizeAbsolutePath(path, source.path.slice(0, source.path.lastIndexOf('/'))), undefined, owner, hash)
  }

  private openFile(path: string, title?: string, owner = this.current?.card.originId, hash = ''): void {
    const state = this.current
    if (!state) return
    const key = docKey(owner ?? state.card.originId, path, state.card.originId, state.card.fiberDir)
    if (!state.links.some(link => docKey(link.owner ?? state.card.originId, link.path, state.card.originId, state.card.fiberDir) === key)) state.links.push({ path, title, owner })
    this.rebuild(state)
    this.reader.show(state.channel, this.shown(state), this.origin, state.card, false, state.loaded, state.runFinal)
    this.reader.openDocument(key)
    if (hash) this.reader.host.navigateFragment(key, hash)
    void this.readFileMetadata(state).then(() => {
      if (this.current === state && this.isActive && !this.disposed) { this.rebuild(state); this.show(state, false) }
    })
  }
  /** Show a fiber unless the reader already shows it. */
  follow(id: string, owner: string): void {
    const card = this.current?.card
    if (this.isActive && card && card.originId === owner && (card.uid === id || card.id === id)) return
    void this.openFiber(id, owner)
  }
  async openFiber(id: string, owner: string): Promise<void> {
    this.column = null
    this.reader.captureSidebar([])
    const epoch = this.routeEpoch
    const known = this.opts.cards().find(c => (c.id === id || c.uid === id) && c.originId === owner)
      ?? this.opts.cards().find(c => c.uid === id)
    if (known) { this.open(known, this.origin); return }
    try {
      const entry = await readFiber(this.opts.shuttleBase, id, owner, undefined, 'discover')
      if (!this.disposed && epoch === this.routeEpoch) this.open(cardFromCompositeEntry(entry), this.origin)
    } catch { showToast(`Couldn’t open ${id} on ${owner}`, 'error') }
  }

  private readReceipts(state: ChannelState): Promise<void> {
    const key = channelId(state.channel.uid, state.channel.owner)
    const pending = this.receiptsRead.get(key)
    if (pending) return pending
    const cached = this.receipts.get(key)
    const query = `uid=${encodeURIComponent(state.channel.uid)}&origin=${encodeURIComponent(state.channel.owner)}`
    const promise = (async () => {
      try {
        const res = await fetch(`${this.opts.shuttleBase}/api/v1/sent-files?${query}`, {
          cache: 'no-store',
          headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
          signal: AbortSignal.timeout(25000),
        })
        if (res.status === 304) return
        if (!res.ok) throw new Error('Receipt feed unavailable')
        const raw: unknown = await res.json()
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { files?: unknown }).files)) {
          throw new Error('Invalid receipt feed')
        }
        const files = normalizeShelfFiles(raw).map(file => ({
          ...file,
          uid: file.uid ?? state.channel.uid,
          host: file.host ?? state.channel.owner,
        }))
        this.receipts.set(key, { files, etag: res.headers.get('ETag') ?? undefined })
      } catch { /* A failed read keeps the last receipt set. */ }
    })().finally(() => { this.receiptsRead.delete(key) })
    this.receiptsRead.set(key, promise)
    return promise
  }
  /** A periodic refresh re-reads the body in the slow lane; an open reads it at once. */
  private load(state: ChannelState, refresh = false): Promise<void> {
    if (state.channel.uid.startsWith('other:')) {
      state.loaded = true
      state.runFinal = true
      state.channel.body = `Files sent on ${state.channel.owner} without a filed fiber.`
      this.rebuild(state)
      return Promise.resolve()
    }
    const key = channelId(state.channel.uid, state.channel.owner)
    const pending = this.loads.get(key)
    if (pending) return pending
    this.overview.resolving(state.channel.uid, true)
    const promise = (async () => {
      const controller = new AbortController()
      let timeout = 0
      const receiptRead = this.readReceipts(state)
      const wasLoaded = state.loaded
      const read = () => {
        timeout = window.setTimeout(() => controller.abort(), 25000)
        return readFiber(this.opts.shuttleBase, state.card.id, state.channel.owner, controller.signal)
      }
      try {
        const entry = await (refresh ? inLane('slow', read) : read())
        if (entry) {
          // Body reads carry document metadata; the composite feed owns live workers.
          const feed = this.opts.cards().find(c => (c.uid ?? c.id) === state.channel.uid && c.originId === state.channel.owner)
          const live = feed ?? state.card
          const metadata = cardFromCompositeEntry({ ...entry, origin: state.channel.owner })
          for (const key of ['workerState', 'workerAgent', 'tmuxSession', 'terminalBackend', 'runtimePhase', 'lastActivityAt', 'workerStartedAt', 'sessionLink', 'launchError'] as const) {
            metadata[key] = live[key] as never
          }
          // The feed owns office metadata between body reads.
          if (feed) {
            metadata.orchestrator = feed.orchestrator
            metadata.threadSummary = feed.threadSummary
            metadata.shuttleRole = feed.shuttleRole
            metadata.shuttleSeat = feed.shuttleSeat
          }
          if (live.workerState) metadata.sessionUuid = live.sessionUuid
          state.card = metadata
          if (this.current === state && this.isActive) this.opts.onVoiceCard?.(metadata)
          state.metadataKnown = true
          this.overview.resolved(metadata)
        }
        // A body the run has not held yet reorders it, so the strip waits for the receipts too.
        if (!wasLoaded) state.runFinal = false
        state.channel = { ...state.channel, body: entry.fiber.body ?? '', outcome: entry.fiber.outcome ?? state.card.outcome }
        state.loaded = true
        state.error = undefined
      } catch (error) {
        state.error = error instanceof Error && /^(Fiber not found on |.+ is unreachable$)/.test(error.message)
          ? error.message : `${state.card.originId} is unreachable`
      } finally { window.clearTimeout(timeout) }
      // The body (or its failure) shows as soon as it lands; the run's order waits for the receipts.
      if (!wasLoaded && this.current === state && this.isActive && !this.disposed) this.show(state, false)
      await receiptRead
      if (this.disposed) return
      const fiberDir = state.card.fiberDir
      if (fiberDir) {
        void (async () => {
          for (const name of ['tapestry.html', 'artifact.html', 'report.html']) {
            const path = `${fiberDir}/${name}`
            if (state.channel.documents.some(d => d.path === path)) return
            const result = await head(fileBytesUrl(this.opts.shuttleBase, path, state.card.originId), RESOURCE_PRIORITY.neighbour, { fresh: true })
            if (this.disposed) return
            if (result?.exists) {
              if (!state.links.some(link => link.path === path)) {
                state.links.push({ path }); this.rebuild(state)
                if (this.current === state && this.isActive) this.show(state, false)
              }
              return
            }
          }
        })()
      }
      state.runFinal = true
      this.rebuild(state)
      this.refreshProse(state)
      void this.readFileMetadata(state).then(changed => {
        if (!changed || this.disposed) return
        this.rebuild(state)
        this.refreshProse(state)
        if (this.current === state && this.isActive) this.show(state, false)
      })
    })().finally(() => { this.loads.delete(key); this.overview.resolving(state.channel.uid, false) })
    this.loads.set(key, promise)
    return promise
  }
  /**
   * Owner file times mark rewritten documents fresh. They follow the channel
   * rather than gate it: the reads wait in the quiet request lane, never
   * download a body, and resolve true when any time moved.
   */
  private readFileMetadata(state: ChannelState): Promise<boolean> {
    if (state.metadataRead) return state.metadataRead
    const files = state.channel.documents.filter(d => !isDrawn(d))
    let changed = false
    const read = Promise.all(files.map(async doc => {
      const info = await head(fileBytesUrl(this.opts.shuttleBase, doc.path, doc.owner), RESOURCE_PRIORITY.neighbour, { fresh: true })
      // An unreachable owner keeps its last known metadata.
      if (!info || this.disposed) return
      if (!info.exists) changed = true
      const before = state.fileModifiedAt.get(doc.key)
      if (info.modifiedAt) state.fileModifiedAt.set(doc.key, info.modifiedAt)
      else state.fileModifiedAt.delete(doc.key)
      if (state.fileModifiedAt.get(doc.key) !== before) changed = true
    })).then(() => changed).finally(() => { state.metadataRead = undefined })
    state.metadataRead = read
    return read
  }
  private rebuild(state: ChannelState): void {
    const before = state.channel
    const card = state.card
    const routed = state.routedFile
    // A routed page holds its provisional frame until the run is final, receipts included.
    if (state.loaded && state.runFinal && state.routedFile) {
      const file = parseDocKey(state.routedFile)
      if (file && this.isBodyFile(state, state.routedFile)) state.links.push({ path: file.path, owner: file.owner })
      state.routedFile = undefined
    }
    const provisional = state.routedFile ? parseDocKey(state.routedFile) : null
    const receipts = state.channel.uid.startsWith('other:') ? this.overview.unfiledReceipts(state.channel.uid)
      : this.receipts.get(channelId(state.channel.uid, state.channel.owner))?.files ?? []
    const sent = receipts.map(f => ({ path: f.fullPath, owner: f.host ?? card.originId, session: f.sessionId, time: f.timestamp }))
    state.channel = buildChannel({
      uid: before.uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: before.body, outcome: before.outcome, isConstitution: card.shuttleKind !== undefined, family: this.inFamily(card),
      sent, links: state.links, routed: provisional ? [provisional] : undefined, previous: before, modifiedAt: card.modifiedAt, fileModifiedAt: state.fileModifiedAt,
    })
    const awaitsFeed = state.selected === familyKey(state.channel.owner, state.channel.uid) && !this.opts.cards().length
    if (state.selected && !awaitsFeed && !state.channel.documents.some(d => d.key === state.selected)) {
      // A routed page the loaded channel does not hold goes to the report, else the fiber's page.
      state.selected = state.selected === routed ? defaultSelection(state.channel)
        : fallbackSelection(before.documents.map(d => d.key), state.channel.documents.map(d => d.key), state.selected)
    }
  }
  private startTimer(): void {
    this.stopTimer()
    if (document.hidden) return
    this.timer = window.setTimeout(() => {
      this.timer = null
      const state = this.current
      if (!state || !this.isActive) return
      void this.load(state, true).then(() => {
        if (this.current === state && this.isActive && !this.disposed) { this.show(state); this.startTimer() }
      })
    }, 15000)
  }
  private stopTimer(): void { if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null }
  private readonly visibility = (): void => { if (document.hidden) this.stopTimer(); else if (this.isActive) this.startTimer() }
  dispose(): void {
    this.mentions.dispose()
    this.disposed = true
    this.routeEpoch++
    this.stopTimer()
    document.removeEventListener('visibilitychange', this.visibility)
    this.history.dispose()
    this.verdicts.dispose()
    this.dock.setVerdictQueue(undefined)
    this.dock.reset()
    this.picker.dispose()
    this.barPicker.dispose()
    this.reader.dispose()
    this.overview.dispose()
    this.themes.dispose()
    this.depth.dispose()
  }
}
