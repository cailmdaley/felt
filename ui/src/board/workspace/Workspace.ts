import { slug } from '../threadOutline.js'
import { ThreadIndex, cardNamed } from '../threads.js'
import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import type { ConsoleOptions, Dock } from './Dock.js'
import { Verdicts, confirmWorkerStop, type Verdict } from './Verdicts.js'
import { onDesk, reviewReachable, verdictReachable } from './fiberPageState.js'
import { type Charter, charters, holdsRevision, mayBeCharter, roleHolds, roleSlug } from './RolePage.js'
import { isAgentCard } from '../KanbanModalShared.js'
import { readFiber } from './fiberSource.js'
import { inLane } from '../requestLanes.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import { normalizeSentFiles, type SentFile } from '../sentFiles.js'
import { fileBytesUrl, renderMarkdown, showToast } from '../utils.js'
import type { DeskPlacement } from '../deskOrdering.js'
import { head, RESOURCE_PRIORITY } from '../documentResources.js'
import { COMPANION_NAMES, documentActivity, familyKey, fiberKey, isBaked, isDrawn, leadReceipt, buildChannel, normalizeAbsolutePath, defaultSelection, docKey, fallbackSelection, parseDocKey, proseDocument, type Channel, type DocKey, type WorkspaceDocument } from './documents.js'
import { conversationDevice } from '../conversationOpening.js'
import { selectWorker } from '../sessionHistory.js'
import { buildFiberProse } from './FiberProse.js'
import { bindConstitutionMentions } from './bodyLinks.js'
import { frameBridge } from './DocumentBridge.js'
import './mentions.css'
import { Reader } from './Reader.js'
import { WorkspaceDepth } from './Depth.js'
import { SearchPanel } from '../search/SearchPanel.js'
import type { FindScope, ListScope } from '../search/scope.js'
import { channelsSection, constitutionsSection, filesSection, saidSection, transcriptsSection } from '../search/sections.js'
import { Library } from './Library.js'
import { FamilyPage, type ViewFeeds } from './FamilyPage.js'
import { BoardFeed, type BoardRecord } from '../boardFeed.js'
import { wantOf } from '../attention.js'
import { composeChannels, fiberOf as channelFiber, type Channel as BoardChannel } from '../channels.js'
import type { GlobeHost } from '../globe/GlobeStage.js'
import type { MapFile } from '../family/model.js'
import { FamilyActivity } from './familyActivity.js'
import { markSeen, unseenSince } from './DocumentSeen.js'
import { FiberSends } from '../fiberSends.js'
import { constitutionFor, type BoardOpen } from '../voice.js'
import { parseRoute, viewOfHash, WorkspaceHistory, type WorkspaceOriginView, type WorkspaceRoute } from './route.js'
import { ChannelThemes } from './ChannelThemes.js'
import { changeReviewTarget } from './changeReviewTarget.js'
import { daemonFetch } from '../daemonApi.js'
import type { SwipeSignal } from './PhoneGestures.js'

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
  /** The constitution the board looks at, or none: voice follows it (`Workspace.look`). */
  onSight?(card: KanbanCard | null): void
  onReturnCard?(card: KanbanCard): void
  onEscapeHome?(): void
  /** A history entry addressed a board view or channel origin; switch to it without pushing. */
  onView?(view: WorkspaceView): void
  dock: Dock
  /** A console of its own for a surface beside the reader (a Channels pane), built as the reader's is. */
  console(options: ConsoleOptions): Dock
  /** The board bar's Find field, shared by every view on the desktop. */
  find?: HTMLInputElement
  /** The chip in the bar's Find that names where it searches. */
  findChip?: HTMLButtonElement
  /** Where the view on show has the bar's Find search; none searches the whole board. */
  findScope?(): FindScope | undefined
  /** Brings Channels up on a channel, a hidden one back to the rail, and the line `item` marked in its stream. */
  openChannel?(target: { channel: string; item?: string }): void
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
/** Rex moves at most once in this span; looks within it wait, and only the last of them moves Rex. */
const REX_HOLD_MS = 350
/** A look's identity: the constitution and the worker it has, so a worker that starts later is still reached. */
const rexKey = (card: KanbanCard | null): string =>
  card ? [card.originId, card.uid ?? card.id, card.shuttleHost ?? '', card.tmuxSession ?? ''].join('\u0000') : ''
interface ChannelState {
  card: KanbanCard
  channel: Channel
  links: Array<{ path: string; owner?: string; title?: string }>
  fileModifiedAt: Map<DocKey, string>
  /** The owner file-time reads in flight, at most one per channel. */
  metadataRead?: Promise<boolean>
  selected?: DocKey
  routedFile?: DocKey
  loaded: boolean
  familyPage?: FamilyPage
  /** The page the reader showed last in this channel. */
  shown?: DocKey
  /** The run is final: body and receipts are both in, or the body read failed. The strip waits for it. */
  runFinal: boolean
  metadataKnown: boolean
  error?: string
}
type WorkspaceView = WorkspaceOriginView
const VIEW_LABELS: Record<WorkspaceView, string> = { desk: 'Desk', chronicle: 'Chronicle', globe: 'Globe', channels: 'Channels' }
const viewForOrigin = (origin: string): WorkspaceOriginView => origin === 'Desk' ? 'desk' : origin === 'Chronicle' ? 'chronicle' : origin === 'Globe' ? 'globe' : 'channels'
const channelId = (uid: string, owner: string): string => JSON.stringify([owner, uid])
const threadFamilyRevision = (card: KanbanCard, index: ThreadIndex): string => {
  const current = index.card(card)
  const ancestry = index.ancestry(current).flatMap(entry => entry.card ? [index.card(entry.card)] : [])
  const scope = ancestry[0] ?? current
  return JSON.stringify({ card: current, ancestry, family: [scope, ...index.subtree(scope)] })
}
/** Routes, owner-addressed sources and per-channel selection for one reader. */
export class Workspace {
  readonly reader: Reader
  readonly library: Library
  readonly dock: Dock
  private readonly verdicts = new Verdicts()
  private readonly activity: FamilyActivity
  private readonly sends: FiberSends
  private readonly stopSends: () => void
  /** The board bar's Find: the list it hangs beneath itself, or the view it answers in place. */
  private readonly barFind: SearchPanel
  /** The phone's Find, with a field of its own, in a sheet. */
  private readonly sheet = document.createElement('dialog')
  private readonly sheetFind: SearchPanel
  /** What had the focus when the sheet opened, which takes it back when the sheet closes. */
  private sheetReturn: HTMLElement | null = null
  private readonly themes: ChannelThemes
  private readonly root: HTMLElement
  private readonly depth: WorkspaceDepth
  private readonly opts: WorkspaceOptions
  private readonly history: WorkspaceHistory
  private readonly channels = new Map<string, ChannelState>()
  private readonly proseRevisions = new Map<DocKey, string>()
  private catalogue: Charter[] = []
  private current: ChannelState | null = null
  /** Constitutions opened in this session, most recent first. */
  private origin = 'Channels'
  private readonly receipts = new Map<string, { files: SentFile[]; etag?: string }>()
  private readonly receiptsRead = new Map<string, Promise<void>>()
  private readonly loads = new Map<string, Promise<void>>()
  private readonly mentions: ReturnType<typeof bindConstitutionMentions>
  private timer: number | null = null
  private disposed = false
  /** What the board last looked at, by its worker, and whether Rex moved there. */
  private looked: { key: string; moved: Promise<boolean> } = { key: '', moved: Promise.resolve(false) }
  /** A Rex move waiting out the hold after the last one, and how to settle its answer if a later look supersedes it. */
  private rexHold: { timer: number; resolve(moved: boolean): void } | null = null
  /** The last move posted to Rex: when, and to which look. */
  private rexMoved: { at: number; key: string; moved: Promise<boolean> } = { at: -Infinity, key: '', moved: Promise.resolve(false) }
  private routeEpoch = 0
  /** A route applied now is not a click: the board's load, or a session asking for a page. It moves neither Rex nor voice. */
  private quiet = false
  /** The complete board-card payload used by the reader's thread and runtime surfaces. */
  private lastUpdateRevision = ''
  private lastRenderedFamilyRevision = ''
  private readonly mapFeeds: ViewFeeds
  /** The family board's records, which a constitution's view and Channels read. */
  readonly board: BoardFeed
  /** The channels the board's cards make, as last composed, and each constitution's channel by fiber. */
  private composed: { cards: KanbanCard[]; channels: BoardChannel[]; of: Map<string, BoardChannel> } | null = null
  /** Each constitution's tapestry read, by fiber and its last write. */
  private readonly leadReads = new Map<string, { modified?: string; read: Promise<MapFile | undefined> }>()
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
    this.board = new BoardFeed(opts.shuttleBase)
    this.board.subscribe(() => {
      this.mentions.refresh()
      this.refreshFind()
      if (this.current && this.isActive) this.current.familyPage?.update(this.current.card, this.graph())
    })
    this.mapFeeds = {
      marks: card => this.activity.of(card.uid ?? card.id),
      reach: () => this.activity.reach(),
      files: card => this.mapFiles(card),
      refresh: () => this.refreshFamilyFeeds(),
      lead: card => this.mapLead(card),
      open: (card, doc) => this.openDocument(card, doc),
      link: (card, source, href) => this.openLink(card, source, href),
      said: card => this.said(card),
      view: (card, quiet) => this.openFromDesk(card, quiet),
      seen: file => markSeen([file]),
      waits: () => this.board.waiting,
      shuttleBase: opts.shuttleBase,
    }
    this.globeHost = {
      feeds: this.mapFeeds,
      openDocument: (card, doc) => this.openDocument(card, doc),
      converse: card => this.look(card),
      constitutionKey: card => fiberKey(card.originId, card.uid ?? card.id),
      shuttleBase: opts.shuttleBase,
    }
    this.mentions = bindConstitutionMentions(root, opts.cards, (id, origin) => { void this.openFiber(id, origin) }, {
      shuttleBase: opts.shuttleBase, frameActive: frame => frameBridge(frame)?.active ?? null, waits: () => this.board.waiting,
    })
    this.depth = new WorkspaceDepth(root)
    this.origin = opts.origin()
    this.history = new WorkspaceHistory((route, quiet) => { void this.applyRoute(route, quiet) })
    this.dock = this.wire(opts.dock)
    this.themes = new ChannelThemes(opts.shuttleBase)
    this.library = new Library({
      shuttleBase: opts.shuttleBase,
      sends: this.sends,
      cards: opts.cards,
      onOpen: (card, doc) => this.open(card, this.opts.origin(), doc, this.library.hasMetadata(card)),
    })
    this.library.subscribe(() => this.refreshFind())
    this.barFind = new SearchPanel({
      field: opts.find, chip: opts.findChip,
      scope: () => this.findScope(),
      board: () => this.boardScope(),
      onDone: () => opts.find?.blur(),
    })
    this.sheetFind = new SearchPanel({
      // The sheet covers the view, so a view that answers in place is searched as the whole board.
      scope: () => { const scope = this.findScope(); return 'inPlace' in scope ? this.boardScope() : scope },
      board: () => this.boardScope(),
      onDone: () => this.sheet.close(),
    })
    this.sheet.className = 'ws-find-sheet'
    this.sheet.setAttribute('aria-label', 'Find')
    this.sheet.append(this.sheetFind.el)
    this.sheet.addEventListener('close', () => {
      this.sheetFind.clear()
      this.sheet.remove()
      if (this.sheetReturn?.isConnected && !this.isActive) this.sheetReturn.focus({ preventScroll: true })
      this.sheetReturn = null
    })
    this.sheet.addEventListener('click', event => { if (event.target === this.sheet) this.sheet.close() })
    const reviewTarget = (source: WorkspaceDocument) => changeReviewTarget(source, opts.cards())
    this.reader = new Reader({
      shuttleBase: opts.shuttleBase,
      themes: this.themes,
      cards: opts.cards,
      threadIndex: () => opts.threadIndex?.() ?? new ThreadIndex(opts.cards()),
      deskCards: () => this.opts.deskRows(),
      deskStop: card => this.deskStop(card),
      onFind: () => { if (!opts.focusFind?.()) this.findConstitution() },
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
      onReturn: () => this.history.leave(),
      onSwipe: signal => this.swipeBeneath?.(signal) ?? false,
      onVerdict: verdict => this.deferVerdict(verdict),
      onConversation: card => { this.dock.openConversation(card) },
      onRest: (card, anchor) => this.opts.onRest?.(card, anchor),
      onEscapeLayer: () => this.controls(this.current)?.handleEscape() ?? false,
      onChannel: card => this.open(card, this.origin, undefined, this.library.hasMetadata(card)),
      // A step to the next constitution is a scan, not a look: it moves neither voice nor Rex.
      onScan: card => this.quietly(() => this.open(card, this.origin, undefined, this.library.hasMetadata(card), true)),
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
    this.quietly(() => this.history.start())
    this.library.refresh()
    document.addEventListener('visibilitychange', this.visibility)
  }

  get isActive(): boolean { return this.reader.isActive }
  /** The view beneath the reader, when it owns the page swipe (Channels: the swipe brings its rail); true when it took the swipe. */
  swipeBeneath: ((signal: SwipeSignal) => boolean) | null = null
  /** The board bar's Find, answering where the board stands (the reader's constitution, the view's scope, else the whole board). */
  find(): void {
    const input = this.opts.find
    if (!input) return
    this.barFind.show(this.root, input.closest('label') ?? input)
    this.library.refresh()
  }
  /** Empty the bar's Find and put away whatever it did. */
  clearFind(): void { this.barFind.clear() }
  /** Where Find stands: in the reader, its constitution; else where the view on show says; else the whole board. */
  private findScope(): FindScope {
    if (this.isActive && this.current) return this.threadScope(this.current.card)
    return this.opts.findScope?.() ?? this.boardScope()
  }
  private refreshFind(): void {
    this.barFind?.refresh()
    this.sheetFind?.refresh()
  }
  /** A constitution Find picked: the view behind the stage shows it where it can, else its page opens. */
  private pickCard(card: KanbanCard): void {
    if (!this.isActive && this.opts.reveal?.(card)) return
    this.open(card, this.isActive ? this.origin : this.opts.origin(), undefined, this.library.hasMetadata(card))
  }
  /** The board's cards by uid and by id. */
  private cardOf(ref: string): KanbanCard | undefined {
    return this.opts.cards().find(card => card.uid === ref || card.id === ref)
  }
  /** Every family top-level the board's cards belong to. */
  private families(): string[] {
    const index = this.graph()
    return [...new Set(this.opts.cards().map(card => { const root = index.rootOf(card); return root.uid ?? root.id }))]
  }
  /**
   * What was said to the human, for Find: the family board's records over
   * `families`, and each open question a worker asked with no record of it,
   * under the id the stream draws it by.
   */
  private saidRecords(families: string[], cards = this.opts.cards()): BoardRecord[] {
    const asks = cards.flatMap((card): BoardRecord[] => {
      const want = card.status === 'active' && card.ask ? wantOf(card, this.board.waiting) : undefined
      const uid = card.uid ?? card.id
      return want?.kind === 'ask' && !want.line ? [{ id: `ask:${uid}:${want.at}`, kind: 'asked', timestamp: want.at, fiber: uid, to: { label: 'you' }, text: want.text }] : []
    })
    return [...this.board.records(families), ...asks]
  }
  /** A line Find picked: Channels opens at it, marked; a fiber in no channel opens its page. */
  private openSaid(card: KanbanCard, item: string): void {
    const channel = this.channelOf(card)
    if (channel && this.opts.openChannel) this.opts.openChannel({ channel: channel.key, item })
    else this.pickCard(card)
  }
  /** The whole board: constitutions, channels, what was said, files, and transcripts when asked. */
  boardScope(): ListScope {
    const recent = (): KanbanCard[] => {
      const ordered = this.library.orderedCards()
      return [...ordered, ...this.opts.cards().filter(card => !ordered.some(row => (row.uid ?? row.id) === (card.uid ?? card.id) && row.originId === card.originId))]
    }
    return {
      sections: [
        constitutionsSection({
          shuttleBase: this.opts.shuttleBase, cards: this.opts.cards, recent, pick: hit => hit.card && this.pickCard(hit.card),
          current: card => this.isActive && (card.uid ?? card.id) === this.current?.channel.uid && card.originId === this.current.channel.owner,
        }),
        ...this.opts.openChannel ? [channelsSection({ channels: () => this.boardChannels(), open: channel => this.opts.openChannel!({ channel: channel.key }) })] : [],
        saidSection({ records: () => this.saidRecords(this.families()), cardOf: uid => this.cardOf(uid), channelOf: card => this.channelOf(card), open: (card, record) => this.openSaid(card, record.id) }),
        filesSection({ documents: () => this.library.documents(), open: (card, key) => this.openDocument(card, key) }),
        transcriptsSection({ shuttleBase: this.opts.shuttleBase, cardOf: id => this.cardOf(id), open: card => this.pickCard(card), ask: true }),
      ],
      open: () => this.board.read(this.families()),
    }
  }
  /** One constitution: what it said, its files, and its own transcripts. */
  private threadScope(card: KanbanCard): ListScope {
    const uid = card.uid ?? card.id, root = this.graph().rootOf(card), family = root.uid ?? root.id
    return {
      chip: `in ${card.name}`,
      sections: [
        saidSection({ records: () => this.saidRecords([family], [card]).filter(record => record.fiber === uid || record.fiber === card.id), cardOf: () => card, open: (_, record) => this.openSaid(card, record.id) }),
        filesSection({ documents: () => this.library.documents().filter(doc => (doc.card.uid ?? doc.card.id) === uid && doc.card.originId === card.originId), open: (each, key) => this.openDocument(each, key) }),
        transcriptsSection({ shuttleBase: this.opts.shuttleBase, fiber: card.id, cardOf: id => this.cardOf(id), open: each => this.pickCard(each), title: 'Its transcripts' }),
      ],
      open: () => this.board.read([family]),
    }
  }
  /** Return from the reader to the view it was opened from, as Escape does. */
  returnToOrigin(): void {
    if (!this.isActive) return
    this.history.leave()
  }
  /** The header's close control returns to Desk, regardless of its origin view. */
  escapeHome(): void { this.history.view('#/desk') }
  /** The phone's Find: a sheet with a field of its own, over the board or the reader. */
  findConstitution(): void {
    if (this.sheet.open) { this.sheetFind.field.focus(); return }
    this.sheetReturn = document.activeElement as HTMLElement | null
    this.root.append(this.sheet)
    this.sheet.showModal()
    this.sheetFind.serve()
    this.sheetFind.field.focus({ preventScroll: true })
    this.library.refresh()
  }
  /** One of a constitution's pages, opened from its view or a channel: a deliberate look at it. */
  private openDocument(card: KanbanCard, doc: DocKey): void {
    if (this.isActive) this.open(card, this.origin, doc, this.library.hasMetadata(card))
    else this.openPage(card, doc)
  }
  /** One of a fiber's pages, or its own page, opened from the view on show. */
  openPage(card: KanbanCard, doc?: DocKey): void {
    void this.library.open(card, doc)
  }
  /** A click on a constitution, from any surface: its view opens, and Rex and voice follow it; a `quiet` opening moves neither. */
  openFromDesk(clicked: KanbanCard, quiet = false): void {
    const card = this.live(clicked), view = this.familyDocument(card)
    const open = (): void => { this.open(card, this.isActive ? this.origin : this.opts.origin(), view) }
    if (quiet) { this.quietly(open); return }
    open()
    void this.look(card)
  }
  /** What a constitution last posted: its newest post, question or close note the family board holds, its open question, or its review note; never its outcome. */
  said(card: KanbanCard): { text: string; at: number } | undefined {
    const index = this.graph(), root = index.rootOf(card), uid = card.uid ?? card.id, outcome = card.outcome?.trim()
    this.board.read([root.uid ?? root.id])
    // A closing post's line carries the outcome as its text.
    const posts = this.board.records([root.uid ?? root.id])
      .filter(record => record.fiber === uid && ['post', 'asked', 'closed'].includes(record.kind) && record.text?.trim() && !(record.kind === 'closed' && record.text.trim() === outcome))
      .map(record => ({ text: record.text!.trim(), at: record.timestamp }))
    if (card.ask && card.status === 'active') posts.push({ text: card.ask.text, at: Date.parse(card.ask.at) || 0 })
    if (index.state(card) === 'to-review' && card.reviewMark?.note) posts.push({ text: card.reviewMark.note, at: Date.parse(card.reviewMark.at) || 0 })
    return posts.sort((a, b) => a.at - b.at).at(-1)
  }
  /** The channel chair's slug, as the console names it, or in the catch-all its family's top-level's; undefined for a card in no channel. */
  channelHandle(card: KanbanCard): string | undefined {
    const channel = this.channelOf(card)
    if (!channel) return undefined
    // In the catch-all, which has no chair, a constitution goes by its family's top-level.
    return slug(channel.seat ?? this.graph().rootOf(card))
  }
  /** The channel a constitution speaks in, as the board's cards make them. */
  private channelOf(card: KanbanCard): BoardChannel | undefined { return this.channelsComposed().of.get(channelFiber(card)) }
  /** Every channel the board's cards make, hidden ones too. */
  private boardChannels(): BoardChannel[] { return this.channelsComposed().channels }
  private channelsComposed(): { channels: BoardChannel[]; of: Map<string, BoardChannel> } {
    const cards = this.opts.cards()
    if (this.composed?.cards !== cards) {
      const index = this.graph(), of = new Map<string, BoardChannel>()
      const channels = composeChannels({ cards, parentOf: each => index.parentOf(each), dismissed: [], pinned: new Map(), waits: new Map(), now: Date.now() })
      for (const channel of channels) for (const member of channel.everyone) of.set(channelFiber(member), channel)
      this.composed = { cards, channels, of }
    }
    return this.composed
  }
  /** A card's sent files, and the open channel's other documents, newest first. */
  private mapFiles(card: KanbanCard): MapFile[] {
    const files = new Map(this.sends.sends(card).map((send): [string, MapFile] => [send.key, { key: send.key, name: send.basename, at: send.timestamp, unread: unseenSince(send.key, send.timestamp), caption: send.caption }]))
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
  /** A constitution's tapestry or report, read once and again when its card's file changes. */
  private mapLead(card: KanbanCard): Promise<MapFile | undefined> {
    const key = `${card.originId}:${card.uid ?? card.id}`, known = this.leadReads.get(key)
    if (known && known.modified === card.modifiedAt) return known.read
    const read = this.readLead(card)
    this.leadReads.set(key, { modified: card.modifiedAt, read })
    return read
  }
  private async readLead(card: KanbanCard): Promise<MapFile | undefined> {
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
  /** A fiber has a view when it is on the lifecycle, a draft included (its acts live there), or has threads. */
  private hasMap(card: KanbanCard): boolean {
    const index = this.graph(), current = index.card(card)
    return index.children(current).length > 0 || (isAgentCard(current) && !current.isCycle)
  }

  /** The open thread's orchestrator; false outside a thread. */
  private orchestrator(card: KanbanCard): KanbanCard | undefined {
    const index = this.opts.threadIndex?.()
    return index?.parentOf(index.card(card))
  }
  /** `b`: the orchestrator's view opens. */
  openOrchestrator(): boolean {
    const parent = this.current && this.isActive ? this.orchestrator(this.current.card) : undefined
    if (!parent) return false
    this.openFromDesk(parent)
    return true
  }

  /** `t`: from the view, its tapestry (else its newest sent file); from any other page of the channel, the view. */
  private toggleMap(): boolean {
    const state = this.current
    const map = state && this.isActive ? this.familyDocument(state.card) : undefined
    if (!state || !map) return false
    if (this.shown(state) !== map) { this.visit(map); return true }
    state.familyPage?.openLead()
    return true
  }

  /** Opens a fiber at one of its pages; with none named, it comes back to the page it was left on, else its view. */
  open(card: KanbanCard, origin = this.opts.origin(), doc?: DocKey, authoritative = true, scan = false): void {
    this.origin = origin
    const state = this.ensure(card, authoritative)
    this.library.opened(card, state.metadataKnown)
    this.history.enter(state.channel.uid, state.channel.owner, doc ?? state.selected, viewForOrigin(origin), scan)
  }

  /** The Desk column a card stands in, its family's when it is not drawn itself; a page off the Desk is Open. */
  private deskStop(card: KanbanCard): string {
    const index = this.opts.threadIndex?.()
    const placement = this.opts.deskPlacement?.(card) ?? (index && this.opts.deskPlacement?.(index.rootOf(card)))
    return placement?.group ?? 'Open'
  }

  /** View keys park the reader. */
  suspend(view: WorkspaceOriginView): void {
    this.history.view(`#/${view}`)
  }

  /** Keep worker metadata current without rebuilding live file instruments. */
  update(): void {
    if (!this.current || !this.isActive) {
      this.mentions.refresh()
      this.library.cardsChanged()
      return
    }
    const cards = this.opts.cards()
    const revision = JSON.stringify([
      cards,
      cards.map(card => {
        const placement = this.opts.deskPlacement?.(card)
        return placement ? [placement.section, placement.group] : null
      }),
    ])
    const changed = revision !== this.lastUpdateRevision
    if (changed) this.lastUpdateRevision = revision
    const card = cards.find(c => (c.uid ?? c.id) === this.current?.channel.uid && c.originId === this.current.channel.owner)
    // A fiber outside the feed (a role, a note) keeps its card; a role page still follows its holds.
    if (!card) {
      this.mentions.refresh()
      this.library.cardsChanged()
      if (changed) this.refreshFind()
      this.refreshProse(this.current)
      return
    }
    if (!changed) return
    this.mentions.refresh()
    this.library.cardsChanged()
    if (threadFamilyRevision(card, this.opts.threadIndex?.() ?? new ThreadIndex(cards)) === this.lastRenderedFamilyRevision) {
      this.refreshFind()
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
    const card = state.card
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
    // Closed work awaiting a review, the human's or a thread's orchestrator's.
    const awaitsReview = (c: KanbanCard): boolean => c.column === 'awaitingReview' || c.column === 'orchestratorReview'
    const review = awaitsReview(card)
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
      if (review && !awaitsReview(live)) {
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
  /** A console for a surface beside the reader: its voice names fibers and its verdicts wait out the undo window as the reader's do. */
  console(options: ConsoleOptions): Dock { return this.wire(this.opts.console(options)) }
  private wire(dock: Dock): Dock {
    dock.setFiberSlug((fiber, origin) => {
      const cards = this.opts.cards().filter(card => card.id === fiber || card.uid === fiber)
      const card = cards.find(card => card.originId === origin) ?? cards[0]
      return card && slug(card)
    })
    dock.setVerdictQueue((card, verdict) => this.queueVerdict(card, verdict))
    dock.setChannelOf(card => this.channelHandle(card))
    return dock
  }
  /** The band belongs to fibers on the Desk's lifecycle; a note or role has none. */
  private controls(state: ChannelState | null): Dock | undefined {
    if (!state?.metadataKnown || state.channel.uid.startsWith('other:') || !onDesk(state.card)) return undefined
    this.dock.open(state.card)
    return this.dock
  }
  /** The reader's way back names the view it returns to. */
  private nameBack(): void {
    this.reader.setBackDestination(this.history.backLabel)
  }
  /** Seat the band over the channel's pages, with its links. */
  private seatBand(state: ChannelState): void {
    const dock = this.controls(state)
    this.reader.setBand(dock?.el ?? null)
    // With no band, nothing a row's ⚙ could open stands behind it.
    this.dock.setSeated(!!dock)
    if (!dock) return
    const ancestry: KanbanCard[] = []
    for (let parent = this.orchestrator(state.card); parent; parent = this.orchestrator(parent)) ancestry.unshift(parent)
    dock.openSettings = (content, opener) => this.reader.showSettings(content, opener, dock.el)
    dock.closeSettings = after => this.reader.closeSettings(after)
    dock.setNav({
      ancestry: ancestry.map(card => ({ name: slug(card), open: () => this.reader.closeSettings(() => { if (this.isActive) this.open(card, this.origin, undefined, this.library.hasMetadata(card)) }) })),
      constitution: () => { const page = proseDocument(state.channel); if (page) this.visit(page.key) },
    })
  }
  /** On a charter's page, the office's holds; absent on any other page. */
  private holds(state: ChannelState): KanbanCard[] | undefined {
    const slug = roleSlug(state.card, this.catalogue)
    return slug ? roleHolds(this.opts.cards(), slug) : undefined
  }
  /** Read the charter catalogue for a page that may be a charter, redrawing it once known. */
  private readCatalogue(state: ChannelState): void {
    if (!mayBeCharter(state.card)) return
    void charters(this.opts.shuttleBase).then(catalogue => {
      this.catalogue = catalogue
      if (!this.disposed && this.current) this.refreshProse(this.current)
    }, () => {})
  }
  private proseRevision(state: ChannelState): string {
    return JSON.stringify([state.channel.body, state.channel.outcome, state.channel.labels, state.channel.documents.map(d => d.key), state.card.status, state.card.tempered, state.card.workerState, state.card.effectiveHorizon, state.card.shuttleAgent, state.card.shuttleRole, state.card.shuttlePerson, state.card.shuttleSeat, roleSlug(state.card, this.catalogue), holdsRevision(this.holds(state) ?? []), state.error, state.loaded, state.metadataKnown])
  }
  private drawProse(state: ChannelState): HTMLElement {
    this.readCatalogue(state)
    return buildFiberProse(state.card, state.channel, {
      shuttleBase: this.opts.shuttleBase,
      onFiber: id => { void this.openFiber(id, state.card.originId) },
      onFile: (path, title, owner?: string) => this.openFile(path, title, owner),
      holds: this.holds(state),
      onCard: card => { void this.openFiber(card.uid ?? card.id, card.originId) },
    })
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
   * The board looks at `card`, or at no fiber: the one act every surface that
   * changes what is looked at goes through. Its constitution is the target:
   * voice follows it, and on the desktop Rex moves quietly to the window its
   * live worker already has. Nothing opens, is created or resumed, so a target
   * without a live worker leaves Rex be; opening is `c` or Open in Rex
   * (`Dock.openConversation`). Looking again at the same target moves nothing;
   * looks in quick succession, like paging with `j`, move Rex once, to the
   * last of them; and Rex is left alone while the board lacks the keyboard.
   * Resolves true if Rex moved.
   */
  look(card: KanbanCard | null): Promise<boolean> {
    const target = card && constitutionFor(this.live(card), this.opts.cards())
    this.opts.onSight?.(target)
    const key = rexKey(target)
    if (key === this.looked.key) return this.looked.moved
    this.dropRexHold()
    if (key === this.rexMoved.key && Date.now() - this.rexMoved.at < REX_HOLD_MS) {
      this.looked = { key, moved: this.rexMoved.moved }
      return this.looked.moved
    }
    if (!target?.tmuxSession || !conversationDevice().desktop) {
      this.looked = { key, moved: Promise.resolve(false) }
      return this.looked.moved
    }
    // Rex is the human's while the board is behind it: a look without the keyboard moves nothing.
    if (!document.hasFocus()) {
      this.looked = { key: '', moved: Promise.resolve(false) }
      return this.looked.moved
    }
    const { tmuxSession, shuttleHost } = target
    const move = (): Promise<boolean> => {
      const moved = selectWorker(this.opts.shuttleBase, tmuxSession, shuttleHost)
      this.rexMoved = { at: Date.now(), key, moved }
      return moved
    }
    const wait = this.rexMoved.at + REX_HOLD_MS - Date.now()
    const moved = wait <= 0 ? move() : new Promise<boolean>(resolve => {
      this.rexHold = { resolve, timer: window.setTimeout(() => { this.rexHold = null; resolve(move()) }, wait) }
    })
    this.looked = { key, moved }
    return moved
  }
  /** The board's current copy of a card a surface drew earlier: its worker may have started or stopped since. */
  private live(card: KanbanCard): KanbanCard {
    return cardNamed(this.opts.cards(), card.uid ?? card.id, card.originId) ?? card
  }
  /** A later look supersedes a move still waiting out its hold: it never posts, and answers that Rex did not move. */
  private dropRexHold(): void {
    if (!this.rexHold) return
    window.clearTimeout(this.rexHold.timer)
    this.rexHold.resolve(false)
    this.rexHold = null
  }
  /** Rex moved itself to this fiber's worker: looking at it now moves nothing. */
  rexAt(id: string, owner: string): void {
    const card = cardNamed(this.opts.cards(), id, owner)
    if (card) this.looked = { key: rexKey(constitutionFor(card, this.opts.cards())), moved: Promise.resolve(true) }
  }
  private family(): HTMLElement {
    const state = this.current!
    state.familyPage ??= new FamilyPage(this.mapFeeds, () => { state.familyPage = undefined }, target => this.dock.actsFor(target))
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
        channel: buildChannel({ uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: '', outcome: card.outcome, isConstitution: card.shuttleKind !== undefined, family: this.hasMap(card), change: !!card.shuttleProjectDir, changePRs: card.shuttleChangePRs, modifiedAt: card.modifiedAt }),
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
  /** Applies a route; a `quiet` one, or one applied inside {@link quietly}, moves neither voice nor Rex. */
  private async applyRoute(route: WorkspaceRoute, quietRoute = false): Promise<void> {
    const quiet = quietRoute || this.quiet
    const epoch = ++this.routeEpoch
    this.barFind.close()
    if (this.sheet.open) this.sheet.close()
    if (route.kind === 'overview') {
      const view = viewOfHash(route.hash ?? window.location.hash) ?? this.history.originView
      if (view === 'desk' && this.origin === 'Desk' && this.current && this.isActive) this.opts.onReturnCard?.(this.current.card)
      this.reader.hide(true)
      this.origin = VIEW_LABELS[view]
      this.opts.onView?.(view)
      this.depth.setActive(false)
      this.opts.onVisibility(false)
      if (!quiet) void this.look(null)
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
      this.nameBack()
      this.startTimer()
      return
    }
    this.current = state
    for (const key of route.doc ? [route.doc] : []) {
      const file = parseDocKey(key)
      if (file && !state.links.some(link => link.path === file.path && (link.owner ?? state.card.originId) === file.owner)) state.links.push(file)
    }
    if (route.doc) this.rebuild(state)
    // Document navigation shares an in-flight channel read without starting another.
    const bodyRead = sameChannel ? this.loads.get(channelId(route.uid, route.owner)) ?? Promise.resolve() : this.load(state)
    // The switcher lists the library's fibers, so a channel entry reads them too.
    if (!sameChannel) {
      this.library.opened(state.card, state.metadataKnown)
      this.library.refresh()
    }
    // Selection resolves before the first paint; data arriving later never moves it.
    // A constitution with threads lands on their view; any other on its report.
    const wanted = route.doc ?? state.selected ?? this.familyDocument(state.card) ?? this.knownReport(state)
    const loadedBefore = state.loaded && state.runFinal
    if (wanted) this.intend(state, wanted)
    this.opts.onVisibility(true)
    this.depth.setActive(true)
    this.show(state)
    // Opening a page is a deliberate look at its fiber; nothing that redraws it looks again.
    if (!quiet) void this.look(state.card)
    await bodyRead
    if (this.disposed || epoch !== this.routeEpoch || this.current !== state || !this.isActive) return
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
  /** The report the library's receipt feed already names for this channel, before the channel's own reads return. */
  private knownReport(state: ChannelState): DocKey | undefined {
    const card = state.card
    const receipts = this.library.receipts(state.channel.uid).filter(file => (file.host ?? card.originId) === card.originId)
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
    this.arrive(state, selected)
    this.refreshProse(state)
    this.history.name(selected)
    this.reader.show(ch, selected, state.card, animate, state.loaded && state.runFinal, state.runFinal)
    this.nameBack()
    if (selected === this.familyDocument(state.card)) this.focusMap(state)
    this.seatBand(state)
    this.echo(state, selected)
  }
  /** Over a constitution's view, whose head carries its pages and acts, the console does not repeat them. */
  private echo(state: ChannelState, key: DocKey): void {
    this.dock.setEchoed(key === this.familyDocument(state.card))
  }
  /** The map takes the keys as it lands, unless a control in the reader already holds them. */
  private focusMap(state: ChannelState): void {
    const active = document.activeElement
    if (!active || active === document.body || active.matches('.ws-return, .ws-document-back') || active.closest('[inert]')) state.familyPage?.focus()
  }
  /** The reader shows `key`. Back on the view from a file it opened full screen, the view's unfolded file is the one last read there. */
  private arrive(state: ChannelState, key: DocKey): void {
    if (key === this.familyDocument(state.card) && state.shown && state.shown !== key) state.familyPage?.follow(state.shown)
    state.shown = key
  }
  private visit(key: DocKey): void {
    if (this.current?.channel.documents.some(doc => doc.key === key)) this.history.show(key)
  }
  private select(key: DocKey): void {
    const state = this.current
    if (!state || !state.channel.documents.some(d => d.key === key)) return
    state.selected = key
    state.routedFile = undefined
    this.arrive(state, key)
    this.reader.select(key)
    this.echo(state, key)
    if (key === this.familyDocument(state.card)) this.focusMap(state)
    this.history.name(key)
  }
  private isBodyFile(state: ChannelState, key: DocKey): boolean {
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown(state.channel.body, { basePath: state.card.fiberDir, originId: state.card.originId, projectDir: state.card.shuttleProjectDir })
    return Array.from(template.content.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')).some(link =>
      [link.dataset.filePath, link.dataset.filePathAlt].some(path => path && docKey(state.card.originId, path, state.card.originId, state.card.fiberDir) === key))
  }

  /**
   * A link followed in a page a view unfolded in place, routed as the reader
   * routes its own: a board route moves the board, and a file beside the page
   * opens in the reader as one of `card`'s pages. False when the link goes
   * nowhere the board is not already.
   */
  openLink(card: KanbanCard, source: DocKey, href: string): boolean {
    const from = parseDocKey(source), before = window.location.hash
    if (!from) return false
    return this.openRelative(from, href, card) || window.location.hash !== before
  }
  /**
   * Follows a link from a document: `holder` is the constitution whose page a
   * file opens as, the one on show when absent. True when it opened a file.
   */
  private openRelative(source: Pick<WorkspaceDocument, 'owner' | 'path'>, href: string, holder?: KanbanCard): boolean {
    if (!href) return false
    const route = parseRoute(href)
    if (route?.kind === 'channel') { this.history.enter(route.uid, route.owner, route.doc); return false }
    if (route?.kind === 'overview' || (viewOfHash(href) && !route)) { this.history.view(href); return false }
    if (href.startsWith('#')) return false
    let path: string, hash: string, owner = source.owner
    try {
      const url = new URL(href, window.location.href)
      const explicit = url.pathname === '/api/v1/file' && url.searchParams.has('path')
      if (explicit) {
        path = url.searchParams.get('path')!
        owner = url.searchParams.get('origin') || owner
      } else {
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return false
        path = decodeURIComponent(href.split(/[?#]/)[0])
      }
      hash = url.hash
    } catch { return false }
    if (!path || path.includes('\0') || path.includes('\\')) return false
    const file = normalizeAbsolutePath(path, source.path.slice(0, source.path.lastIndexOf('/')))
    if (holder) {
      const key = docKey(owner, file, holder.originId, holder.fiberDir)
      this.openDocument(holder, key)
      if (hash) this.reader.host.navigateFragment(key, hash)
    } else this.openFile(file, undefined, owner, hash)
    return true
  }

  private openFile(path: string, title?: string, owner = this.current?.card.originId, hash = ''): void {
    const state = this.current
    if (!state) return
    const key = docKey(owner ?? state.card.originId, path, state.card.originId, state.card.fiberDir)
    if (!state.links.some(link => docKey(link.owner ?? state.card.originId, link.path, state.card.originId, state.card.fiberDir) === key)) state.links.push({ path, title, owner })
    this.rebuild(state)
    this.reader.show(state.channel, this.shown(state), state.card, false, state.loaded, state.runFinal)
    this.reader.openDocument(key)
    if (hash) this.reader.host.navigateFragment(key, hash)
    void this.readFileMetadata(state).then(() => {
      if (this.current === state && this.isActive && !this.disposed) { this.rebuild(state); this.show(state, false) }
    })
  }
  /**
   * Rex's focus moved to a fiber: a page of the fiber's own channel stands;
   * otherwise its view opens. Rex is already there, so the look moves nothing.
   */
  follow(id: string, owner: string): void {
    const shown = this.current?.card
    if (this.isActive && shown && shown.originId === owner && (shown.uid === id || shown.id === id)) return
    const known = cardNamed(this.opts.cards(), id, owner)
    if (known) this.open(known, this.origin, this.familyDocument(known))
    else void this.openFiber(id, owner)
  }
  /** Runs `act` with its routes applied quietly. */
  private quietly(act: () => void): void {
    this.quiet = true
    try { act() } finally { this.quiet = false }
  }
  /**
   * Opens a fiber, or one of its pages: its constitution, its tapestry, or its
   * view. A `quiet` open, a session asking for a page, moves neither Rex nor voice.
   */
  async openFiber(id: string, owner: string, page?: BoardOpen['page'], quiet = false): Promise<void> {
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
      : this.familyDocument(card)
    if (quiet) this.quietly(() => this.open(card, this.origin, doc))
    else this.open(card, this.origin, doc)
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
    this.library.resolving(state.channel.uid, true)
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
          for (const key of ['workerState', 'workerAgent', 'tmuxSession', 'terminalBackend', 'rexSession', 'runtimePhase', 'lastActivityAt', 'quietSince', 'workerStartedAt', 'sessionLink', 'launchError', 'column', 'turn', 'nextLaunchAt', 'scheduleText'] as const) {
            metadata[key] = live[key] as never
          }
          // The feed owns office metadata between body reads.
          if (feed) {
            metadata.orchestrator = feed.orchestrator
            metadata.shuttleRole = feed.shuttleRole
            metadata.shuttlePerson = feed.shuttlePerson
            metadata.shuttleSeat = feed.shuttleSeat
          }
          if (live.workerState) metadata.sessionUuid = live.sessionUuid
          state.card = metadata
          state.metadataKnown = true
          this.library.resolved(metadata)
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
    })().finally(() => { this.loads.delete(key); this.library.resolving(state.channel.uid, false) })
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
    const files = state.channel.documents.filter(d => !isDrawn(d) && !isBaked(d))
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
    const receipts = state.channel.uid.startsWith('other:') ? this.library.receipts(state.channel.uid)
      : this.receipts.get(channelId(state.channel.uid, state.channel.owner))?.files ?? []
    const sent = receipts.map(f => ({ path: f.fullPath, owner: f.host ?? card.originId, session: f.sessionId, time: f.timestamp, caption: f.caption }))
    state.channel = buildChannel({
      uid: before.uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: before.body, outcome: before.outcome, isConstitution: card.shuttleKind !== undefined, family: this.hasMap(card), change: !!card.shuttleProjectDir, changePRs: card.shuttleChangePRs,
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
    this.dropRexHold()
    this.disposed = true
    this.routeEpoch++
    this.stopTimer()
    document.removeEventListener('visibilitychange', this.visibility)
    this.history.dispose()
    this.verdicts.dispose()
    this.dock.setVerdictQueue(undefined)
    this.dock.reset()
    this.barFind.dispose()
    this.sheetFind.dispose()
    this.sheet.remove()
    this.reader.dispose()
    this.library.dispose()
    this.stopSends()
    this.themes.dispose()
    this.depth.dispose()
  }
}
