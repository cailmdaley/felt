import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import type { Dock } from './Dock.js'
import { Verdicts, confirmWorkerStop, type Verdict } from './Verdicts.js'
import { fiberPageColumn, verdictReachable } from './fiberPageState.js'
import type { DispatchFailureBody } from '../KanbanModalShared.js'
import { readFiber } from './fiberSource.js'
import { inLane } from '../requestLanes.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import { normalizeShelfFiles } from '../views/shelfData.js'
import type { ShelfFile } from '../views/shelfData.js'
import { fileInfoUrl, renderMarkdown, showToast } from '../utils.js'
import { buildChannel, defaultSelection, docKey, fallbackSelection, parseDocKey, type Channel, type DocKey } from './documents.js'
import { buildFiberProse } from './FiberProse.js'
import { Reader } from './Reader.js'
import { WorkspaceDepth } from './Depth.js'
import { cardIdentity, type SidebarEntry } from './SidebarFlight.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'
import { Overview } from './Overview.js'
import { WorkspaceHistory, type WorkspaceOriginView, type WorkspaceRoute } from './route.js'
import { ChannelThemes } from './ChannelThemes.js'

export interface WorkspaceOptions {
  shuttleBase: string
  cards(): KanbanCard[]
  origin(): string
  onVisibility(active: boolean): void
  deskColumn?(card: KanbanCard): SidebarEntry[]
  onReturnCard?(card: KanbanCard): void
  /** A history entry addressed a board view or channel origin; switch to it without pushing. */
  onView?(view: WorkspaceView): void
  dock: Dock
}
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
  metadataKnown: boolean
  error?: string
}
export type WorkspaceView = WorkspaceOriginView
const VIEW_HASHES: Record<string, WorkspaceView> = { '#/desk': 'desk', '#/chronicle': 'chronicle', '#/board': 'board' }
const VIEW_LABELS: Record<WorkspaceView, string> = { desk: 'Desk', chronicle: 'Chronicle', board: 'Board' }
const viewForOrigin = (origin: string): WorkspaceOriginView => origin === 'Desk' ? 'desk' : origin === 'Chronicle' ? 'chronicle' : 'board'
const channelId = (uid: string, owner: string): string => JSON.stringify([owner, uid])

/** Routes, owner-addressed sources and per-channel selection for one reader. */
export class Workspace {
  readonly reader: Reader
  readonly overview: Overview
  readonly dock: Dock
  private readonly verdicts = new Verdicts()
  private readonly picker: ConstitutionPicker
  private readonly themes: ChannelThemes
  private readonly root: HTMLElement
  private readonly depth: WorkspaceDepth
  private readonly opts: WorkspaceOptions
  private readonly history: WorkspaceHistory
  private readonly channels = new Map<string, ChannelState>()
  private readonly proseRevisions = new Map<DocKey, string>()
  private current: ChannelState | null = null
  private column: SidebarEntry[] | null = null
  private origin = 'Board'
  private readonly receipts = new Map<string, { files: ShelfFile[]; etag?: string }>()
  private readonly receiptsRead = new Map<string, Promise<void>>()
  private readonly loads = new Map<string, Promise<void>>()
  private timer: number | null = null
  private disposed = false
  private routeEpoch = 0
  private lastBoardRoute: Extract<WorkspaceRoute, { kind: 'channel' }> | null = null
  private startPrompt: { card: KanbanCard; failure: DispatchFailureBody } | null = null

  constructor(root: HTMLElement, opts: WorkspaceOptions) {
    this.opts = opts
    this.root = root
    this.depth = new WorkspaceDepth(root)
    this.origin = opts.origin()
    this.history = new WorkspaceHistory(route => { void this.applyRoute(route) })
    this.dock = opts.dock
    this.dock.setVerdictQueue((card, verdict) => this.queueVerdict(card, verdict))
    this.themes = new ChannelThemes(opts.shuttleBase)
    this.overview = new Overview({
      shuttleBase: opts.shuttleBase,
      themes: this.themes,
      cards: opts.cards,
      onOpen: (card, doc) => this.open(card, 'Board', doc, this.overview.hasMetadata(card)),
      onOrder: () => { this.reader?.refreshChannels(); this.picker?.refresh() },
    })
    this.picker = new ConstitutionPicker({
      cards: () => {
        const ordered = this.overview.orderedCards()
        return [...ordered, ...opts.cards().filter(card => !ordered.some(row => (row.uid ?? row.id) === (card.uid ?? card.id) && row.originId === card.originId))]
      },
      files: card => this.overview.fileNames(card),
      onOpen: card => this.open(card, 'Desk', undefined, this.overview.hasMetadata(card), false),
    })
    this.reader = new Reader({
      shuttleBase: opts.shuttleBase,
      themes: this.themes,
      cards: () => this.origin === 'Board' ? this.overview.orderedCards() : opts.cards(),
      switcherCards: () => this.sidebarCards(),
      pickerCards: () => this.overview.orderedCards(),
      sidebarBand: card => this.column?.find(entry => cardIdentity(entry.card) === cardIdentity(card))?.band,
      files: card => this.overview.fileNames(card),
      onSelect: key => this.select(key),
      onCrossing: travel => this.depth.cross(travel),
      onReturn: () => {
        if (this.origin === 'Board') this.lastBoardRoute = null
        if (this.current) this.opts.onReturnCard?.(this.current.card)
        this.history.leave()
      },
      workerPill: card => this.dock.workerPillFor(card),
      onVerdict: verdict => this.deferVerdict(verdict),
      onCompose: () => this.focusComposer(),
      onConversation: card => { this.dock.openConversation(card) },
      onEscapeLayer: () => this.controls(this.current)?.handleEscape() ?? false,
      onChannel: card => this.open(card, this.origin, undefined, this.overview.hasMetadata(card)),
      buildProse: doc => this.prose(doc.key),
      onRefreshProse: async doc => {
        const state = [...this.channels.values()].find(s => s.channel.documents[0]?.key === doc.key)
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
  /** Opens over the Desk without navigating or waking the reader. */
  findConstitution(): void {
    this.picker.show(this.root)
    this.overview.refresh()
  }
  /** A refused Desk launch enters the document channel and exposes its recovery form. */
  openStartPrompt(card: KanbanCard, failure: DispatchFailureBody): void {
    this.startPrompt = { card, failure }
    this.open(card, this.opts.origin(), this.ensure(card).channel.documents[0].key)
  }

  open(card: KanbanCard, origin = this.opts.origin(), doc?: DocKey, authoritative = true, fromDeskColumn = true): void {
    const outsideColumn = this.isActive && this.column && !this.column.some(entry => cardIdentity(entry.card) === cardIdentity(card))
    if (!this.isActive || origin !== this.origin || outsideColumn || !fromDeskColumn) {
      const column = fromDeskColumn && !outsideColumn && origin === 'Desk' ? this.opts.deskColumn?.(card) : undefined
      this.column = column?.length ? column : null
      this.reader.captureSidebar(this.column ?? [])
    }
    this.origin = origin
    const state = this.ensure(card, authoritative)
    this.overview.opened(card, state.metadataKnown)
    this.history.enter(state.channel.uid, state.channel.owner, doc ?? state.selected, viewForOrigin(origin))
  }

  private sidebarCards(): KanbanCard[] {
    if (this.column) {
      const live = new Map(this.opts.cards().map(card => [cardIdentity(card), card]))
      return this.column.map(entry => live.get(cardIdentity(entry.card)) ?? entry.card)
    }
    return this.origin === 'Board' ? this.overview.orderedCards() : this.overview.recentCards()
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
    this.overview.cardsChanged()
    if (!this.current || !this.isActive) return
    const card = this.opts.cards().find(c => (c.uid ?? c.id) === this.current?.channel.uid && c.originId === this.current.channel.owner)
    if (!card) return
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
  /** Desk, plates, act-zone buttons and keys authorize the same delayed write. */
  queueVerdict(requested: KanbanCard, verdict: Verdict): void {
    const uid = requested.uid ?? requested.id, owner = requested.originId
    const state = this.channels.get(channelId(uid, owner))
    const resolve = (): KanbanCard | undefined => this.opts.cards().find(card => (card.uid ?? card.id) === uid && card.originId === owner)
    const indexed = resolve()
    // Linked fibers can be outside the board index; cached metadata only labels the toast.
    if (!indexed && !state?.metadataKnown) return
    const card = indexed ?? requested
    const review = fiberPageColumn(card) === 'awaitingReview'
    // Ask while the gesture is fresh; the undo window carries the answer to the write.
    if (!confirmWorkerStop(card, verdict)) return
    const workerStopConfirmed = hasWorkerToStop(card)
    const material = this.current?.channel.uid === uid && this.current.channel.owner === owner ? this.themes.material(this.reader.el) : undefined
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
      if (review && fiberPageColumn(live) !== 'awaitingReview') {
        showToast(`${live.name} no longer awaits review; verdict not written`, 'error')
        return
      }
      if (hasWorkerToStop(live) && !workerStopConfirmed) {
        showToast(`${live.name} has a worker now; verdict not written`, 'error')
        return
      }
      this.dock.commitVerdict(live, verdict)
    }, material)
  }
  private focusComposer(): void {
    const state = this.current
    if (!state) return
    const key = state.channel.documents[0]?.key
    if (key) this.select(key)
    this.controls(state)?.focusComposer()
  }

  private controls(state: ChannelState | null): Dock | undefined {
    return state?.metadataKnown && !state.channel.uid.startsWith('other:') ? this.dock.bandFor(state.card) : undefined
  }
  private proseRevision(state: ChannelState): string {
    return JSON.stringify([state.channel.body, state.channel.outcome, state.channel.labels, state.channel.documents.map(d => d.key), state.card.status, state.card.tempered, state.card.workerState, state.card.effectiveHorizon, state.card.shuttleAgent, state.error, state.loaded, state.metadataKnown])
  }
  private prose(key: DocKey): HTMLElement {
    const state = [...this.channels.values()].find(s => s.channel.documents[0]?.key === key)
    if (!state) return document.createElement('div')
    this.proseRevisions.set(key, this.proseRevision(state))
    const page = buildFiberProse(state.card, state.channel, {
      controls: this.controls(state)?.el,
      acts: this.controls(state)?.head,
      shuttleBase: this.opts.shuttleBase,
      onFiber: id => { void this.openFiber(id, state.card.originId) },
      onFile: (path, title) => this.openFile(path, title),
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
  private refreshProse(state: ChannelState): void {
    const key = state.channel.documents[0]?.key
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
        channel: buildChannel({ uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: '', outcome: card.outcome, isConstitution: card.shuttleKind !== undefined, modifiedAt: card.modifiedAt }),
        links: [], fileModifiedAt: new Map(), loaded: false, metadataKnown,
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
    if (route.kind === 'overview') {
      const hash = route.hash ?? window.location.hash
      const view = VIEW_HASHES[hash] ?? this.history.originView
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
        status: '', createdAt: '', effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null,
      }, false)
    }
    this.current = state
    if (this.origin === 'Board') this.lastBoardRoute = route
    // Reserve the body read before the receipt feed can preload this same fiber.
    const bodyRead = this.load(state)
    // The sidebar and switcher list the overview's rows, so a direct entry reads them too.
    this.overview.opened(state.card, state.metadataKnown)
    this.overview.refresh()
    this.overview.setVisible(false)
    // Selection resolves before the first paint; data arriving later never moves it.
    const wanted = route.doc ?? state.selected ?? this.knownReport(state)
    const loadedBefore = state.loaded
    if (wanted) this.intend(state, wanted)
    this.opts.onVisibility(true)
    this.depth.setActive(true)
    this.show(state)
    const prompt = this.startPrompt
    if (prompt && (prompt.card.uid ?? prompt.card.id) === state.channel.uid && prompt.card.originId === state.channel.owner) {
      this.startPrompt = null
      const band = this.dock.bandFor(prompt.card)
      band.openStartPrompt(prompt.card, prompt.failure)
      if (!window.matchMedia('(max-width: 600px)').matches) band.el.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true })
    }
    await bodyRead
    if (this.disposed || epoch !== this.routeEpoch || this.current !== state || !this.isActive) return
    this.show(state, loadedBefore)
    this.history.select(this.shown(state))
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
    const report = this.overview.unfiledReceipts(state.channel.uid).find(file => (file.host ?? card.originId) === card.originId && file.fullPath.split('/').at(-1)?.toLowerCase() === 'report.html')
    return report ? docKey(card.originId, report.fullPath, card.originId, card.fiberDir) : undefined
  }
  /** The page on screen: the selection when the channel lists it, else the fiber's own page. */
  private shown(state: ChannelState): DocKey {
    const documents = state.channel.documents
    return state.selected && documents.some(d => d.key === state.selected) ? state.selected : documents[0].key
  }
  private show(state: ChannelState, animate = true): void {
    const ch = state.channel
    const selected = this.shown(state)
    this.refreshProse(state)
    this.reader.show(ch, selected, this.origin, state.card, animate, state.loaded)
    if (this.origin === 'Board') this.lastBoardRoute = { kind: 'channel', uid: ch.uid, owner: ch.owner, doc: selected }
    this.dock.syncRuntime(state.card)
  }
  private select(key: DocKey): void {
    const state = this.current
    if (!state || !state.channel.documents.some(d => d.key === key)) return
    state.selected = key
    state.routedFile = undefined
    this.reader.select(key)
    this.history.select(key)
    if (this.origin === 'Board') this.lastBoardRoute = { kind: 'channel', uid: state.channel.uid, owner: state.channel.owner, doc: key }
  }
  private isBodyFile(state: ChannelState, key: DocKey): boolean {
    const template = document.createElement('template')
    template.innerHTML = renderMarkdown(state.channel.body, { basePath: state.card.fiberDir, originId: state.card.originId, projectDir: state.card.shuttleProjectDir })
    return Array.from(template.content.querySelectorAll<HTMLAnchorElement>('a[data-file-path]')).some(link =>
      [link.dataset.filePath, link.dataset.filePathAlt].some(path => path && docKey(state.card.originId, path, state.card.originId, state.card.fiberDir) === key))
  }

  private openFile(path: string, title?: string): void {
    const state = this.current
    if (!state) return
    const key = docKey(state.card.originId, path, state.card.originId, state.card.fiberDir)
    if (!state.links.some(link => docKey(link.owner ?? state.card.originId, link.path, state.card.originId, state.card.fiberDir) === key)) state.links.push({ path, title })
    this.rebuild(state)
    state.selected = key
    this.show(state)
    this.history.select(key)
    void this.readFileMetadata(state).then(() => {
      if (this.current === state && this.isActive && !this.disposed) { this.rebuild(state); this.show(state, false) }
    })
  }
  private async openFiber(id: string, owner: string): Promise<void> {
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
      const read = () => {
        timeout = window.setTimeout(() => controller.abort(), 25000)
        return readFiber(this.opts.shuttleBase, state.card.id, state.channel.owner, controller.signal)
      }
      try {
        const entry = await (refresh ? inLane('slow', read) : read())
        if (entry) {
          // Body reads carry document metadata; the composite feed owns live workers.
          const live = this.opts.cards().find(c => (c.uid ?? c.id) === state.channel.uid && c.originId === state.channel.owner) ?? state.card
          const metadata = cardFromCompositeEntry({ ...entry, origin: state.channel.owner })
          for (const key of ['workerState', 'workerSurface', 'workerAgent', 'tmuxSession', 'runtimePhase', 'lastActivityAt', 'workerStartedAt', 'sessionLink', 'desktopLink', 'launchError'] as const) {
            metadata[key] = live[key] as never
          }
          if (live.workerState) metadata.sessionUuid = live.sessionUuid
          state.card = metadata
          state.metadataKnown = true
          this.overview.resolved(metadata)
        }
        state.channel = { ...state.channel, body: entry.fiber.body ?? '', outcome: entry.fiber.outcome ?? state.card.outcome }
        state.loaded = true
        state.error = undefined
      } catch (error) {
        state.error = error instanceof Error && /^(Fiber not found on |.+ is unreachable$)/.test(error.message)
          ? error.message : `${state.card.originId} is unreachable`
      } finally { window.clearTimeout(timeout) }
      await receiptRead
      if (this.disposed) return
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
    const files = state.channel.documents.filter(d => d.kind !== 'fiber')
    let changed = false
    const read = Promise.all(files.map(doc => inLane('quiet', async () => {
      if (this.disposed) return
      try {
        const response = await fetch(fileInfoUrl(this.opts.shuttleBase, doc.path, doc.owner), { cache: 'no-store', signal: AbortSignal.timeout(8000) })
        if (!response.ok) return
        const info = await response.json()
        const time = typeof info.modified_at === 'number' ? info.modified_at * 1000 : typeof info.modified_at === 'string' ? Date.parse(info.modified_at) : NaN
        const before = state.fileModifiedAt.get(doc.key)
        if (info.exists && Number.isFinite(time)) state.fileModifiedAt.set(doc.key, new Date(time).toISOString())
        else state.fileModifiedAt.delete(doc.key)
        if (state.fileModifiedAt.get(doc.key) !== before) changed = true
      } catch { /* An unreachable owner keeps its last known metadata. */ }
    }, { rank: 1 }))).then(() => changed).finally(() => { state.metadataRead = undefined })
    state.metadataRead = read
    return read
  }
  private rebuild(state: ChannelState): void {
    const before = state.channel
    const card = state.card
    const routed = state.routedFile
    if (state.loaded && state.routedFile) {
      const file = parseDocKey(state.routedFile)
      if (file && this.isBodyFile(state, state.routedFile)) state.links.push({ path: file.path, owner: file.owner })
      state.routedFile = undefined
    }
    const provisional = state.routedFile ? parseDocKey(state.routedFile) : null
    const links = provisional ? [...state.links, { path: provisional.path, owner: provisional.owner }] : state.links
    const receipts = state.channel.uid.startsWith('other:') ? this.overview.unfiledReceipts(state.channel.uid)
      : this.receipts.get(channelId(state.channel.uid, state.channel.owner))?.files ?? []
    const sent = receipts.map(f => ({ path: f.fullPath, owner: f.host ?? card.originId, session: f.sessionId, time: f.timestamp }))
    state.channel = buildChannel({
      uid: before.uid, owner: card.originId, name: card.name, path: this.fiberPath(card), fiberDir: card.fiberDir ?? '', body: before.body, outcome: before.outcome, isConstitution: card.shuttleKind !== undefined,
      sent, links, previous: before, modifiedAt: card.modifiedAt, fileModifiedAt: state.fileModifiedAt,
    })
    if (state.selected && !state.channel.documents.some(d => d.key === state.selected)) {
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
        if (this.current === state && this.isActive && !this.disposed) { this.show(state); this.history.select(this.shown(state)); this.startTimer() }
      })
    }, 15000)
  }
  private stopTimer(): void { if (this.timer !== null) window.clearTimeout(this.timer); this.timer = null }
  private readonly visibility = (): void => { if (document.hidden) this.stopTimer(); else if (this.isActive) this.startTimer() }
  dispose(): void {
    this.disposed = true
    this.routeEpoch++
    this.stopTimer()
    document.removeEventListener('visibilitychange', this.visibility)
    this.history.dispose()
    this.verdicts.dispose()
    this.dock.setVerdictQueue(undefined)
    this.dock.reset()
    this.picker.dispose()
    this.reader.dispose()
    this.overview.dispose()
    this.themes.dispose()
    this.depth.dispose()
  }
}
