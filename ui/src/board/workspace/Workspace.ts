import { slug } from '../threadOutline.js'
import { ThreadIndex, cardNamed } from '../threads.js'
import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import type { Dock } from './Dock.js'
import { Verdicts, confirmWorkerStop, type Verdict } from './Verdicts.js'
import { fiberPageKicker, onDesk, reviewReachable, verdictReachable } from './fiberPageState.js'
import { holdsRevision, roleHolds, roleSlug } from './RolePage.js'
import type { DispatchFailureBody } from '../KanbanModalShared.js'
import { readFiber } from './fiberSource.js'
import { inLane } from '../requestLanes.js'
import { cardFromCompositeEntry, isQuestion } from '../KanbanReadModel.js'
import { ownColumn } from '../deskColumn.js'
import { DESK_COLUMN_TITLE } from '../KanbanSurfaces.js'
import { normalizeSentFiles, type SentFile } from '../sentFiles.js'
import { fileBytesUrl, renderMarkdown, showToast } from '../utils.js'
import { deskCardKey, type DeskPlacement } from '../deskOrdering.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { COMPANION_NAMES, channelLead, documentActivity, familyKey, fiberKey, isDrawn, leadReceipt, buildChannel, normalizeAbsolutePath, defaultSelection, docKey, fallbackSelection, parseDocKey, proseDocument, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'
import { conversationDevice } from '../conversationOpening.js'
import { selectWorker } from '../sessionHistory.js'
import { buildFiberProse } from './FiberProse.js'
import { buildFileViewer, disposeFileViewer } from '../FileViewerPanel.js'
import { bindConstitutionMentions } from './bodyLinks.js'
import { forwardDocumentKey, frameBridge } from './DocumentBridge.js'
import './mentions.css'
import { Reader } from './Reader.js'
import { WorkspaceDepth } from './Depth.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'
import { TranscriptResults } from './TranscriptResults.js'
import { Overview } from './Overview.js'
import { FamilyPage, placeAt, type EmbeddedDocument, type FamilyFeeds, type MapPlace } from './FamilyPage.js'
import type { GlobeHost } from '../globe/GlobeStage.js'
import type { MapFile } from '../family/model.js'
import { FamilyActivity } from './familyActivity.js'
import { markSeen, unseenSince } from './DocumentSeen.js'
import { FiberSends } from '../fiberSends.js'
import type { BoardOpen } from '../voice.js'
import { parseRoute, WorkspaceHistory, type WorkspaceOriginView, type WorkspaceRoute } from './route.js'
import { ChannelThemes } from './ChannelThemes.js'
import { changeReviewTarget } from './changeReviewTarget.js'
import { daemonFetch } from '../daemonApi.js'

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
  /** The fiber the page shows, which voice follows. */
  onSight?(card: KanbanCard | null): void
  onReturnCard?(card: KanbanCard): void
  onEscapeHome?(): void
  /** A history entry addressed a board view or channel origin; switch to it without pushing. */
  onView?(view: WorkspaceView): void
  dock: Dock
  /** The board bar's Find field, shared by every view on the desktop. */
  find?: HTMLInputElement
  /** Focus the board bar's Find; false where the bar has none (the phone). */
  focusFind?(): boolean
  /** Brings the view standing behind the stage to a fiber Find picked; false when it holds no place for it, and the fiber's page opens. */
  reveal?(card: KanbanCard): boolean
  /** Expand has taken, or given back, the whole window. */
  onExpand?(expanded: boolean): void
  onRest?(card: KanbanCard, anchor: HTMLElement): void
  /** The fleet's sent files; a workspace without one reads its own. */
  sends?: FiberSends
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
  /** Where its family's map stands, kept across the page's frames. */
  mapPlace: MapPlace
  /** The run is final: body and receipts are both in, or the body read failed. The strip waits for it. */
  runFinal: boolean
  metadataKnown: boolean
  error?: string
}
type WorkspaceView = WorkspaceOriginView
const VIEW_HASHES: Record<string, WorkspaceView> = { '#/desk': 'desk', '#/chronicle': 'chronicle', '#/board': 'board', '#/globe': 'globe' }
const VIEW_LABELS: Record<WorkspaceView, string> = { desk: 'Desk', chronicle: 'Chronicle', board: 'Board', globe: 'Globe' }
const viewForOrigin = (origin: string): WorkspaceOriginView => origin === 'Desk' ? 'desk' : origin === 'Chronicle' ? 'chronicle' : origin === 'Globe' ? 'globe' : 'board'
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
  private readonly sends: FiberSends
  private readonly stopSends: () => void
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
  private origin = 'Board'
  private readonly receipts = new Map<string, { files: SentFile[]; etag?: string }>()
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
  private readonly mapFeeds: FamilyFeeds
  /** What a surface over the whole fleet reaches through the board: the map's feeds, and its pages and conversations. */
  readonly globeHost: GlobeHost

  constructor(root: HTMLElement, opts: WorkspaceOptions) {
    this.opts = opts
    this.root = root
    this.sends = opts.sends ?? new FiberSends(opts.shuttleBase)
    this.stopSends = this.sends.subscribe(() => this.sendsChanged())
    this.activity = new FamilyActivity(opts.shuttleBase, () => {
      if (this.current && this.isActive) this.current.familyPage?.update(this.current.card, this.graph())
      this.globeHost.onFeeds?.()
    })
    this.mapFeeds = {
      marks: card => this.activity.of(card.uid ?? card.id),
      reach: () => this.activity.reach(),
      files: card => this.mapFiles(card),
      refresh: () => this.refreshFamilyFeeds(),
      lead: card => this.mapLead(card),
      embed: (card, doc) => this.embed(card, doc),
      seen: files => markSeen(files),
    }
    this.globeHost = {
      feeds: this.mapFeeds,
      openDocument: (card, doc) => this.openFromMap(card, doc),
      converse: card => this.reach(card),
      constitutionKey: card => fiberKey(card.originId, card.uid ?? card.id),
      shuttleBase: opts.shuttleBase,
      see: card => this.opts.onSight?.(card),
    }
    this.mentions = bindConstitutionMentions(root, opts.cards, (id, origin) => { void this.openFiber(id, origin) }, {
      shuttleBase: opts.shuttleBase, frameActive: frame => frameBridge(frame)?.active ?? null,
    })
    this.depth = new WorkspaceDepth(root)
    this.origin = opts.origin()
    this.history = new WorkspaceHistory(route => { void this.applyRoute(route) })
    this.dock = opts.dock
    this.dock.setFiberSlug((fiber, origin) => {
      const cards = this.opts.cards().filter(card => card.id === fiber || card.uid === fiber)
      const card = cards.find(card => card.originId === origin) ?? cards[0]
      return card && slug(card)
    })
    this.dock.setVerdictQueue((card, verdict) => this.queueVerdict(card, verdict))
    this.themes = new ChannelThemes(opts.shuttleBase)
    this.overview = new Overview({
      shuttleBase: opts.shuttleBase,
      sends: this.sends,
      themes: this.themes,
      cards: opts.cards,
      onOpen: (card, doc) => this.open(card, 'Board', doc, this.overview.hasMetadata(card)),
      onEscapeHome: opts.onEscapeHome,
      onConversation: card => { this.dock.openConversation(card) },
      hasConversation: card => this.dock.canOpenConversation(card),
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
        if (!this.isActive && opts.reveal?.(card)) { opts.find?.blur(); return }
        this.open(card, this.isActive ? this.origin : opts.origin(), undefined, this.overview.hasMetadata(card))
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
      deskCards: () => this.opts.deskRows(),
      pickerCards: () => this.overview.orderedCards(),
      deskStop: card => this.deskStop(card),
      files: card => this.overview.fileNames(card),
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
      actionCard: card => this.actionCard(card),
      onVerdict: verdict => this.deferVerdict(verdict),
      onConversation: card => { this.dock.openConversation(card) },
      onRest: (card, anchor) => this.opts.onRest?.(card, anchor),
      onEscapeLayer: () => this.controls(this.current)?.handleEscape() || (this.mapPage(this.current)?.foldOut() ?? false),
      onChannel: card => this.open(card, this.origin, undefined, this.overview.hasMetadata(card)),
      onScan: card => this.open(card, this.origin, undefined, this.overview.hasMetadata(card), true),
      onOrchestrator: () => this.openOrchestrator(),
      onTapestry: () => this.toggleMap(),
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
   * The board bar's Find, routed by what it serves now: the sheet's folios on
   * the Board, and otherwise a list of constitutions hung beneath the field.
   */
  find(board: boolean): void {
    const input = this.opts.find
    if (!input) return
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
  /** A file opens on its thread's channel, leaving the constitution's page where it stands. */
  private openFromMap(card: KanbanCard, doc?: DocKey): void {
    this.open(card, this.origin, doc, this.overview.hasMetadata(card))
  }
  /** One of a fiber's pages, opened from the view on show. */
  openPage(card: KanbanCard, doc: DocKey): void {
    this.open(card, this.opts.origin(), doc, this.overview.hasMetadata(card))
  }
  /** A Desk or Chronicle click lands on the fiber's map, at its body, and reaches its worker. */
  openFromDesk(card: KanbanCard): void {
    const map = this.landOnMap(card)
    if (map) this.open(card, undefined, map)
    else if (card.status === 'active' && isQuestion(card)) this.openQuestion(card)
    else this.open(card)
    void this.reach(card)
  }
  /** Readies a fiber of a family to land on its constitution's page, at its row, and names the page; undefined for a fiber with none. */
  private landOnMap(card: KanbanCard): DocKey | undefined {
    if (!this.landsOnPage(card)) return undefined
    const state = this.ensure(card)
    if (!state.familyPage?.flyTo(card)) Object.assign(state.mapPlace, placeAt(card), { open: state.mapPlace.open })
    return familyKey(state.channel.owner, state.channel.uid)
  }
  /** The map, while it is what the reader shows. */
  private mapPage(state: ChannelState | null): FamilyPage | undefined {
    return state && this.isActive && this.shown(state) === this.familyDocument(state.card) ? state.familyPage : undefined
  }
  /** A card's sent files, and the open channel's other documents, newest first. */
  private mapFiles(card: KanbanCard): MapFile[] {
    const files = new Map(this.sends.sends(card).map(send => [send.key, { key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp) }]))
    const documents = this.channels.get(channelId(card.uid ?? card.id, card.originId))?.channel.documents ?? []
    for (const doc of documents) {
      const at = documentActivity(doc)
      if (!isDrawn(doc) && at !== undefined && !files.has(doc.key)) files.set(doc.key, { key: doc.key, name: doc.name, at, unread: unseenSince(doc.key, at) })
    }
    return [...files.values()].sort((a, b) => b.at - a.at)
  }
  /** The first companion page a fiber's directory holds, skipping past any `listed` already names, which ends the search. */
  private async companion(fiberDir: string, owner: string, listed: (path: string) => boolean = () => false): Promise<{ path: string; name: string; modifiedAt?: string } | undefined> {
    for (const file of COMPANION_NAMES) {
      const path = `${fiberDir}/${file}`
      if (listed(path)) return undefined
      const result = await head(fileBytesUrl(this.opts.shuttleBase, path, owner), RESOURCE_PRIORITY.neighbour, { fresh: true })
      if (this.disposed) return undefined
      if (result?.exists) return { path, name: file[0].toUpperCase() + file.slice(1, -5), modifiedAt: result.modifiedAt ?? undefined }
    }
    return undefined
  }
  /** A thread's tapestry or report, by its fiber's directory. */
  private async mapLead(card: KanbanCard): Promise<MapFile | undefined> {
    if (!card.fiberDir) return undefined
    const found = await this.companion(card.fiberDir, card.originId)
    if (!found) return undefined
    const key = docKey(card.originId, found.path, card.originId, card.fiberDir), at = Date.parse(found.modifiedAt ?? '') || 0
    return { key, name: found.name, at, unread: at > 0 && unseenSince(key, at) }
  }

  /** The map among this card's pages, or none for a fiber with no map. */
  familyDocument(card: KanbanCard): DocKey | undefined {
    return this.hasMap(card) ? familyKey(card.originId, card.uid ?? card.id) : undefined
  }
  private refreshFamilyFeeds(): void {
    this.activity.refresh()
    void this.sends.refresh()
  }
  /** The sent-file feed moved: the open map redraws. */
  private sendsChanged(): void {
    if (this.current && this.isActive) this.current.familyPage?.update(this.current.card, this.graph())
    this.globeHost.onFeeds?.()
  }
  private graph(): ThreadIndex { return this.opts.threadIndex?.() ?? new ThreadIndex(this.opts.cards()) }
  /** A fiber in a family of threads carries the map among its pages, and so does a constitution alone, past its draft. */
  private hasMap(card: KanbanCard): boolean {
    const index = this.graph(), current = index.card(card)
    return index.children(index.family(current).root).length > 0 || (current.shuttleKind !== undefined && index.state(current) !== 'drafts')
  }
  /** A fiber of a family lands on its constitution's page, except a draft, which opens on its own to be written. */
  private landsOnPage(card: KanbanCard): boolean {
    const index = this.graph()
    return this.hasMap(card) && index.state(index.card(card)) !== 'drafts'
  }
  /** A fiber that lands on its constitution's page opens there. */
  private familyLanding(state: ChannelState): DocKey | undefined {
    return this.landsOnPage(state.card) ? familyKey(state.channel.owner, state.channel.uid) : undefined
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

  /** The map to its focused thread's tapestry or newest file, else the channel's; any other page of the channel to the map. */
  private toggleMap(): boolean {
    const state = this.current
    const map = state && this.isActive ? this.familyDocument(state.card) : undefined
    if (!state || !map) return false
    if (this.shown(state) !== map) { this.visit(map); return true }
    state.familyPage?.toggleLead()
    return true
  }

  open(card: KanbanCard, origin = this.opts.origin(), doc?: DocKey, authoritative = true, scan = false): void {
    this.origin = origin
    const id = deskCardKey(card)
    this.readLately = [id, ...this.readLately.filter(seen => seen !== id)].slice(0, READ_LATELY * 2)
    const state = this.ensure(card, authoritative)
    this.overview.opened(card, state.metadataKnown)
    this.history.enter(state.channel.uid, state.channel.owner, doc ?? state.selected, viewForOrigin(origin), scan)
  }

  /** The family's Desk row: its root's, or its lead's while the root itself rests. */
  private deskAnchor(card: KanbanCard): KanbanCard {
    const index = this.opts.threadIndex?.()
    if (!index) return card
    const { root, lead } = index.family(index.card(card))
    const onDesk = (candidate: KanbanCard) => this.opts.deskRows().some(row => deskCardKey(row) === deskCardKey(candidate))
    return [ownColumn(root) ? root : lead, root].find(onDesk) ?? lead
  }
  /**
   * The Desk column a card stands in, whichever view opened the reader:
   * Drafts, In flight, Awaiting review, Resting, then Roles. A page outside
   * the Desk gets its own stop.
   */
  private deskStop(card: KanbanCard): string {
    const root = this.deskAnchor(card)
    const placement = this.opts.deskPlacement?.(root)
    if (!placement && this.isOpenPage(card)) return 'Open'
    const column = placement?.column ?? root.column
    if (column !== 'tempered' && column !== 'composted' && !root.isCycle) return DESK_COLUMN_TITLE[column]
    return fiberPageKicker(card) || 'Reading'
  }
  /** The current Reader page is outside the drawn Desk projection. */
  private isOpenPage(card: KanbanCard): boolean {
    const current = this.current?.card
    if (!current || deskCardKey(current) !== deskCardKey(card)) return false
    return !this.opts.deskRows().some(row => deskCardKey(row) === deskCardKey(this.deskAnchor(card)))
  }
  /** The constitutions opened in this session, most recent first, for the Board's Read lately shelf. */
  private readLatelyCards(): KanbanCard[] {
    const live = new Map(this.opts.cards().map(card => [deskCardKey(card), card]))
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
  suspend(view: 'desk' | 'chronicle' | 'globe'): void {
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
    if (!state?.metadataKnown) return
    const card = this.actionCard(state.card)
    if (!verdictReachable(card)) return
    this.queueVerdict(card, verdict)
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
    const review = card.column === 'awaitingReview'
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
      if (review && live.column !== 'awaitingReview') {
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
    this.dock.setActionCard(this.actionCard(state.card))
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
  private drawProse(state: ChannelState, embedded = false): HTMLElement {
    return buildFiberProse(state.card, state.channel, {
      embedded,
      shuttleBase: this.opts.shuttleBase,
      onFiber: id => { void this.openFiber(id, state.card.originId) },
      onFile: (path, title, owner?: string) => this.openFile(path, title, owner),
      holds: this.holds(state),
      onCard: card => { void this.openFiber(card.uid ?? card.id, card.originId) },
    })
  }
  /**
   * One of a thread's documents for its constitution's page to unfold under the
   * thread's row: the constitution as its drawn prose, a file at its full height.
   * A key the file passes up acts for its thread, as on the thread's row.
   */
  private embed(card: KanbanCard, doc: DocKey): EmbeddedDocument {
    const box = document.createElement('div')
    box.className = 'ws-embedded'
    const file = parseDocKey(doc)
    if (!file) {
      const state = this.ensure(card)
      const draw = (): void => { box.replaceChildren(this.drawProse(state, true)) }
      draw()
      if (!state.loaded) void this.load(state).then(draw)
      return { el: box, dispose: () => {} }
    }
    const viewer = buildFileViewer(this.opts.shuttleBase, file.path, file.owner, undefined, undefined, {
      active: true, fit: true, onNavigate: href => this.openRelative(file, href),
      onDocumentKey: key => { this.mapPage(this.current)?.choose(card); forwardDocumentKey(box, key, box.querySelector('iframe')) },
    })
    box.append(viewer)
    return { el: box, dispose: () => disposeFileViewer(viewer) }
  }
  private prose(key: DocKey): HTMLElement {
    const state = [...this.channels.values()].find(s => proseDocument(s.channel)?.key === key)
    if (!state) return document.createElement('div')
    this.proseRevisions.set(key, this.proseRevision(state))
    const page = this.drawProse(state)
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
  /**
   * What every click on a thread does to Rex: voice follows the thread, and Rex
   * moves quietly to the window its live worker already has. Nothing opens, is
   * created or resumed, so a thread without one leaves Rex be; opening is `c`
   * or Open in Rex (`Dock.openConversation`). Resolves true if Rex moved.
   */
  reach(card: KanbanCard): Promise<boolean> {
    this.opts.onSight?.(card)
    if (!card.tmuxSession || !conversationDevice().desktop) return Promise.resolve(false)
    return selectWorker(this.opts.shuttleBase, card.tmuxSession, card.shuttleHost)
  }
  /** Voice follows the page: on a constitution's page, the thread it has selected; anywhere else, the page's fiber. */
  private sight(state: ChannelState): void {
    this.opts.onSight?.(this.mapPage(state)?.settled ?? state.card)
  }
  /** Lifecycle and conversation acts follow the highlighted thread, else the page's card. */
  private actionCard(card: KanbanCard): KanbanCard {
    return this.mapPage(this.current)?.selection ?? card
  }
  private family(): HTMLElement {
    const state = this.current!
    state.familyPage ??= new FamilyPage({ reach: card => this.reach(card) }, this.mapFeeds, state.mapPlace,
      () => { state.familyPage = undefined },
      () => { if (this.current === state) this.sight(state) },
      () => { if (this.current === state && this.isActive) this.dock.setActionCard(this.actionCard(state.card)) },
      (card, verb, anchor) => {
        if (verb === 'rest') this.opts.onRest?.(card, anchor)
        else this.queueVerdict(card, ({ review: 'awaitingReview', temper: 'tempered', discard: 'composted' } as const)[verb])
      }, !!this.opts.onRest)
    state.familyPage.leave ??= () => this.returnToOrigin()
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
        channel: buildChannel({ uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: '', outcome: card.outcome, isConstitution: card.shuttleKind !== undefined, family: this.hasMap(card), modifiedAt: card.modifiedAt }),
        links: [], fileModifiedAt: new Map(), loaded: false, runFinal: false, metadataKnown, mapPlace: placeAt(card),
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
        status: '', column: 'drafts', turn: 'none', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null,
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
    for (const key of route.doc ? [route.doc] : []) {
      const file = parseDocKey(key)
      if (file && !state.links.some(link => link.path === file.path && (link.owner ?? state.card.originId) === file.owner)) state.links.push(file)
    }
    if (route.doc) this.rebuild(state)
    if (this.origin === 'Board') this.lastBoardRoute = route
    // Document navigation shares an in-flight channel read without starting another.
    const bodyRead = sameChannel ? this.loads.get(channelId(route.uid, route.owner)) ?? Promise.resolve() : this.load(state)
    // The switcher lists the overview's rows, so a channel entry reads them too.
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
    if (state.channel.documents.some(doc => doc.kind === 'family') !== this.hasMap(state.card)) this.rebuild(state)
    state.familyPage?.update(state.card, this.graph())
    const ch = state.channel
    const selected = this.shown(state)
    this.refreshProse(state)
    this.namePage(state, selected)
    this.reader.show(ch, selected, this.origin, state.card, animate, state.loaded && state.runFinal, state.runFinal)
    this.reader.setBackDestination(this.history.backLabel)
    if (selected === this.familyDocument(state.card)) this.focusMap(state)
    if (this.origin === 'Board') this.lastBoardRoute = { kind: 'channel', uid: ch.uid, owner: ch.owner, doc: selected }
    this.seatBand(state)
    this.sight(state)
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
    this.dock.setActionCard(this.actionCard(state.card))
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

  private openRelative(source: Pick<WorkspaceDocument, 'owner' | 'path'>, href: string): void {
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
  /**
   * Rex's focus moved to a fiber. A fiber on the open map is flown to in place;
   * one on another map lands there; a page of the fiber's own channel stands;
   * anything else opens. None of these speaks back to Rex.
   */
  follow(id: string, owner: string): void {
    const state = this.current, known = cardNamed(this.opts.cards(), id, owner)
    if (known && this.mapPage(state)?.flyTo(known)) return
    const shown = state?.card
    if (this.isActive && shown && shown.originId === owner && (shown.uid === id || shown.id === id)) return
    const map = known && this.landOnMap(known)
    if (map) this.open(known, this.origin, map)
    else void this.openFiber(id, owner)
  }
  /** Opens a fiber, or one of its pages: its constitution, its tapestry, or its row on its constitution's page, unfolded to the files it holds. */
  async openFiber(id: string, owner: string, page?: BoardOpen['page']): Promise<void> {
    const epoch = this.routeEpoch
    let card = cardNamed(this.opts.cards(), id, owner)
    if (!card) {
      try { card = cardFromCompositeEntry(await readFiber(this.opts.shuttleBase, id, owner, undefined, 'discover')) } catch { showToast(`Couldn’t open ${id} on ${owner}`, 'error'); return }
      if (this.disposed || epoch !== this.routeEpoch) return
    }
    const { originId: home, fiberDir: dir } = card
    const companion = page === 'tapestry' && dir ? await this.companion(dir, home) : undefined
    if (this.disposed || epoch !== this.routeEpoch) return
    const doc = page === 'constitution' ? fiberKey(home, card.uid ?? card.id)
      : page === 'tapestry' ? companion && docKey(home, companion.path, home, dir)
      : page && this.landOnMap(card)
    this.open(card, this.origin, doc)
  }

  private readReceipts(state: ChannelState): Promise<void> {
    const key = channelId(state.channel.uid, state.channel.owner)
    const pending = this.receiptsRead.get(key)
    if (pending) return pending
    const cached = this.receipts.get(key)
    const query = `uid=${encodeURIComponent(state.channel.uid)}&origin=${encodeURIComponent(state.channel.owner)}`
    const promise = (async () => {
      try {
        const res = await daemonFetch(`${this.opts.shuttleBase}/api/v1/sent-files?${query}`, {
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
        const files = normalizeSentFiles(raw).map(file => ({
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
          // Body reads carry document metadata; the composite feed owns live
          // workers, and with them where the card stands and whose turn it is.
          const feed = this.opts.cards().find(c => (c.uid ?? c.id) === state.channel.uid && c.originId === state.channel.owner)
          const live = feed ?? state.card
          const metadata = cardFromCompositeEntry({ ...entry, origin: state.channel.owner })
          for (const key of ['workerState', 'workerAgent', 'tmuxSession', 'terminalBackend', 'runtimePhase', 'lastActivityAt', 'workerStartedAt', 'sessionLink', 'launchError', 'column', 'turn', 'nextLaunchAt', 'scheduleText'] as const) {
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
        void this.companion(fiberDir, state.card.originId, path => state.channel.documents.some(d => d.path === path)).then(found => {
          if (!found || state.links.some(link => link.path === found.path)) return
          state.links.push({ path: found.path }); this.rebuild(state)
          if (this.current === state && this.isActive) this.show(state, false)
        })
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
      uid: before.uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: before.body, outcome: before.outcome, isConstitution: card.shuttleKind !== undefined, family: this.hasMap(card),
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
    this.stopSends()
    this.themes.dispose()
    this.depth.dispose()
  }
}
