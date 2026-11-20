import type { KanbanCard } from '../KanbanTypes.js'
import { readFiber } from './fiberSource.js'
import { inLane } from '../requestLanes.js'
import { cardFromCompositeEntry } from '../KanbanReadModel.js'
import type { SentFile } from '../sentFiles.js'
import { FiberSends, SEND_WINDOW_MS } from '../fiberSends.js'
import { docKey, parseDocKey, type DocKey } from './documents.js'
import { watchDocumentTitles } from './DocumentTitles.js'

export interface LibraryOptions {
  shuttleBase: string
  /** The fleet's sent files; a library without one reads its own. */
  sends?: FiberSends
  cards(): KanbanCard[]
  onOpen(card: KanbanCard, doc?: DocKey): void
}
/** One sent document as the library files it: under its fiber's uid, addressed by its owner. */
export interface Receipt extends SentFile { key: DocKey; uid: string; owner: string }
interface Shelf { card: KanbanCard; receipts: Receipt[]; latest: number }
/** An unreachable owner's metadata read retries within this long. */
const RETRY_MS = 30000
const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0
const uidOf = (card: KanbanCard): string => card.uid ?? card.id

/**
 * The fleet's documents of the last thirty days, filed by fiber: every sent
 * file under the fiber that sent it, owner-aware and never path-deduped
 * across owners, and each fiber's card resolved, from the board when it holds
 * one and from its owner otherwise. A receipt sent outside any fiber files
 * under `other:<owner>`. Fibers opened this session are held too, with or
 * without documents. It draws nothing.
 */
export class Library {
  private readonly opts: LibraryOptions
  private readonly stopTitles: () => void
  private readonly sends: FiberSends
  private readonly stopSends: () => void
  private readonly shelves = new Map<string, Shelf>()
  private readonly fallbacks = new Map<string, KanbanCard>()
  private readonly openedCards = new Map<string, KanbanCard>()
  private readonly fetchedCards = new Map<string, KanbanCard>()
  private readonly cardLoads = new Map<string, { pending: Promise<KanbanCard | undefined>; promote: () => void }>()
  private readonly cardRetries = new Map<string, { attempts: number; at: number }>()
  private readonly missingCards = new Set<string>()
  private readonly provisionalOpened = new Set<string>()
  private readonly externalLoads = new Set<string>()
  private readonly cardControllers = new Set<AbortController>()
  private readonly listeners = new Set<() => void>()
  private retryTimer?: ReturnType<typeof setTimeout>
  private navigation = 0
  private order: KanbanCard[] = []
  private signature = ''
  private disposed = false

  constructor(opts: LibraryOptions) {
    this.opts = opts
    this.sends = opts.sends ?? new FiberSends(opts.shuttleBase)
    this.stopSends = this.sends.subscribe(() => { if (!this.disposed) this.reconcile() })
    this.stopTitles = watchDocumentTitles(() => { if (!this.disposed) this.notify() })
  }

  /** Called whenever what the library holds changes: a receipt, a resolved card, a declared title. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  /** True while the fleet's receipt feed cannot be read. */
  get failed(): boolean { return this.sends.failed }

  /** Board metadata is reconciled now; the fleet's sent files follow on their own throttle. */
  refresh(): void {
    if (this.disposed) return
    // A poll retries transient failures at once. A fiber its owner answered
    // "not found" for waits for the next visit: every such read asks each host in turn.
    for (const [uid, retry] of this.cardRetries) if (!this.missingCards.has(uid)) retry.at = 0
    this.reconcile()
    void this.sends.refresh()
  }
  /** A new look at the documents: even a fiber its owner said was missing is asked for again. */
  visit(): void {
    for (const retry of this.cardRetries.values()) retry.at = 0
    this.refresh()
  }
  /** Board metadata arrived or changed. */
  cardsChanged(): void { if (!this.disposed) this.reconcile() }

  opened(card: KanbanCard, authoritative = true): void {
    if (this.disposed) return
    const uid = uidOf(card)
    this.openedCards.set(uid, card)
    if (authoritative) this.provisionalOpened.delete(uid)
    else this.provisionalOpened.add(uid)
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

  /** Every fiber the library holds, the one with the newest document first. */
  orderedCards(): KanbanCard[] { this.resolveCards(); return [...this.order] }
  /** A fiber's documents, newest first. */
  receipts(uid: string): Receipt[] { return this.shelves.get(uid)?.receipts ?? [] }
  /** Every document the library holds, each with its fiber's card, newest first. */
  documents(): Array<{ card: KanbanCard; receipt: Receipt }> {
    return [...this.shelves.values()].flatMap(shelf => shelf.receipts.map(receipt => ({ card: shelf.card, receipt })))
      .sort((a, b) => b.receipt.timestamp - a.receipt.timestamp || compare(a.receipt.key, b.receipt.key))
  }
  hasMetadata(card: KanbanCard): boolean {
    const uid = uidOf(card)
    return uid.startsWith('other:') || this.knownCards().get(uid)?.originId === card.originId
  }
  /** Resolves the fiber from its owner when the board does not hold it, then opens it at `key`. */
  async open(card: KanbanCard, key?: DocKey): Promise<void> {
    const navigation = ++this.navigation
    const uid = uidOf(card)
    let resolved = this.knownCards().get(uid)
    if (!resolved && !uid.startsWith('other:')) resolved = await this.queueCard(card, true)
    if (this.disposed || navigation !== this.navigation) return
    const target = resolved ?? (this.missingCards.has(uid) ? this.fallback(`other:${card.originId}`, card.originId) : card)
    this.opened(target, !!resolved || target.uid?.startsWith('other:'))
    this.opts.onOpen(target, key)
  }

  /** Drops any open still waiting on an owner's read: the surface that asked for it has gone. */
  cancelOpen(): void { this.navigation++ }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.navigation++
    this.stopTitles()
    clearTimeout(this.retryTimer)
    this.stopSends()
    for (const controller of this.cardControllers) controller.abort()
    this.listeners.clear()
  }

  private notify(): void { for (const listener of this.listeners) listener() }
  private get files(): SentFile[] {
    const since = Date.now() - SEND_WINDOW_MS
    return this.sends.files.filter(file => file.timestamp >= since)
  }
  private knownCards(): Map<string, KanbanCard> {
    const known = new Map(this.fetchedCards)
    for (const [uid, card] of this.openedCards) if (!this.provisionalOpened.has(uid)) known.set(uid, card)
    // The live board's chosen mirrored row owns fiber metadata, not the file's byte host.
    for (const card of this.opts.cards()) known.set(uidOf(card), card)
    return known
  }
  /** One stand-in per fiber and owner, so an unchanged library keeps its order. */
  private fallback(uid: string, owner: string): KanbanCard {
    const key = `${uid}\n${owner}`
    let card = this.fallbacks.get(key)
    if (!card) {
      card = { id: uid, uid, name: uid.startsWith('other:') ? `Unfiled · ${owner}` : `Resolving fiber · ${owner}`, path: '', originId: owner, status: '', column: 'drafts', turn: 'none', createdAt: '',
        effectiveHorizon: 'now', drifted: false, isCycle: false, cycleStart: null }
      this.fallbacks.set(key, card)
    }
    return card
  }
  private reconcile(): void {
    const known = this.knownCards()
    for (const uid of known.keys()) { this.missingCards.delete(uid); this.cardRetries.delete(uid) }
    const byUid = new Map<string, Map<DocKey, Receipt>>()
    for (const file of this.files) {
      const card = file.uid ? known.get(file.uid) : undefined
      const key = docKey(file.host ?? '', file.fullPath, card?.originId ?? 'local', card?.fiberDir)
      const parsed = parseDocKey(key)!
      // A receipt sent outside any fiber carries its session id in place of a fiber uid.
      const filed = file.uid && file.uid !== file.sessionId && !this.missingCards.has(file.uid)
      const uid = filed ? file.uid! : `other:${parsed.owner}`
      const receipt: Receipt = { ...file, fullPath: parsed.path, key, uid, owner: parsed.owner, host: parsed.owner }
      const documents = byUid.get(uid) ?? byUid.set(uid, new Map()).get(uid)!
      const prior = documents.get(key)
      if (!prior || receipt.timestamp > prior.timestamp || (receipt.timestamp === prior.timestamp && compare(receipt.sessionId ?? '', prior.sessionId ?? '') < 0)) documents.set(key, receipt)
    }
    for (const uid of this.openedCards.keys()) if (!byUid.has(uid)) byUid.set(uid, new Map())
    this.shelves.clear()
    for (const [uid, documents] of byUid) {
      const receipts = [...documents.values()].sort((a, b) => b.timestamp - a.timestamp || compare(a.key, b.key))
      const card = known.get(uid) ?? this.openedCards.get(uid) ?? this.fallback(uid, receipts[0]?.owner ?? 'local')
      this.shelves.set(uid, { card, receipts, latest: receipts[0]?.timestamp ?? 0 })
    }
    this.order = [...this.shelves].sort(([au, a], [bu, b]) => b.latest - a.latest || compare(au, bu) || compare(a.card.originId, b.card.originId)).map(([, shelf]) => shelf.card)
    const signature = JSON.stringify([...this.shelves].map(([uid, shelf]) => [uid, shelf.card.name, shelf.card.originId, shelf.receipts.map(r => [r.key, r.timestamp])]))
    if (signature !== this.signature) { this.signature = signature; this.notify() }
    this.resolveCards()
  }

  /** Fibers known only from their receipts are read from their owners, a few at a time. */
  private resolveCards(): void {
    if (this.disposed) return
    const known = this.knownCards()
    const candidates = [...this.shelves].filter(([uid]) => !known.has(uid) && !uid.startsWith('other:')).map(([, shelf]) => shelf.card)
    // Confirmed misses have moved to Unfiled, but their intrinsic ids remain retryable.
    for (const file of this.files) if (file.uid && this.missingCards.has(file.uid)) candidates.push(this.fallback(file.uid, file.host ?? 'local'))
    for (const card of candidates) {
      const uid = uidOf(card)
      if (!this.externalLoads.has(uid) && (this.cardRetries.get(uid)?.at ?? 0) <= Date.now()) void this.queueCard(card)
    }
    clearTimeout(this.retryTimer)
    const eligible = new Set(candidates.map(uidOf))
    const times = [...this.cardRetries].filter(([uid]) => eligible.has(uid) && !this.cardLoads.has(uid) && !this.externalLoads.has(uid)).map(([, retry]) => retry.at).filter(Number.isFinite)
    if (times.length) this.retryTimer = setTimeout(() => this.reconcile(), Math.max(1, Math.min(...times) - Date.now()))
  }

  /**
   * Preloads wait in the slow request lane, where one read can take many
   * seconds; an open reads at once, taking over its own queued preload. A
   * read already under way is shared, never duplicated or preempted.
   */
  private queueCard(card: KanbanCard, priority = false): Promise<KanbanCard | undefined> {
    const uid = uidOf(card)
    const prior = this.cardLoads.get(uid)
    if (prior) {
      if (priority) prior.promote()
      return prior.pending
    }
    let complete!: (card: KanbanCard | undefined) => void
    const pending = new Promise<KanbanCard | undefined>(resolve => { complete = resolve })
    let started = false
    const queued = new AbortController()
    const run = async (): Promise<void> => {
      started = true
      const resolved = this.disposed ? undefined : this.knownCards().get(uid) ?? await this.loadCard(card)
      this.cardLoads.delete(uid)
      complete(resolved)
      if (!this.disposed) this.reconcile()
    }
    const promote = (): void => {
      if (started) return
      queued.abort()
      void run()
    }
    this.cardLoads.set(uid, { pending, promote })
    if (priority) void run()
    else void inLane('slow', run, { signal: queued.signal }).catch(() => { /* Promoted to an open. */ })
    return pending
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
        const missing = error instanceof Error && error.message.startsWith('Fiber not found on ')
        if (missing) this.missingCards.add(uid)
        const attempts = (this.cardRetries.get(uid)?.attempts ?? 0) + 1
        // A fiber its owner says does not exist is asked for again only on the next visit.
        this.cardRetries.set(uid, { attempts, at: missing ? Infinity : Date.now() + Math.min(RETRY_MS, 1000 * 2 ** Math.min(attempts - 1, 5)) })
      }
      return undefined
    }
    finally { clearTimeout(timeout); this.cardControllers.delete(controller) }
  }
}
