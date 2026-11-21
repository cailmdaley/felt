import { BoardFeed } from '../board/boardFeed.js'
import { daemonErrorMessage, daemonFetch, isDaemonBooting } from '../board/daemonApi.js'
import { FiberSends } from '../board/fiberSends.js'
import { parseCompositeFeed } from '../board/KanbanComposite.js'
import { buildKanbanResponseFromComposite } from '../board/KanbanReadModel.js'
import { boardCards, cardNamed, ThreadIndex } from '../board/threads.js'
import type { KanbanCard } from '../board/KanbanTypes.js'

/** How often a visible page reads the board again. */
export const POLL_MS = 15_000
/** How often a visible page reads sent files again so new `show` items arrive promptly. */
export const SENDS_POLL_MS = 10_000

/** A tempered or discarded fiber, which a page lists nowhere. */
const archived = (card: KanbanCard): boolean => card.column === 'tempered' || card.column === 'composted'

/**
 * What a page knows of the fleet: the board's cards and their thread graph,
 * read from `/api/v1/fibers/composite` with `If-None-Match` every
 * {@link POLL_MS} while the document is visible and at once when it shows
 * again, classified by the board's own read model; the family's board records
 * (posts and waits); and the fleet's sent files. Tempered and discarded fibers
 * are left out, all but the page's own.
 */
export class PageFeed {
  cards: KanbanCard[] = []
  index = new ThreadIndex([])
  /** The last read's failure, in words; null once a read lands. */
  failure: string | null = null
  /** Whether a read has landed. */
  loaded = false
  readonly board: BoardFeed
  readonly sends: FiberSends
  private etag: string | null = null
  private timer: number | undefined
  private sendsTimer: number | undefined
  private stopped = false
  private readonly listeners = new Set<() => void>()
  private readonly base: string
  private readonly own: { uid: string; host: string } | undefined

  constructor(base: string, own?: { uid: string; host: string }) {
    this.base = base
    this.own = own
    this.board = new BoardFeed(base)
    this.sends = new FiberSends(base, { intervalMs: SENDS_POLL_MS })
    this.board.subscribe(() => this.changed())
    this.sends.subscribe(() => this.changed())
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private changed(): void { for (const listener of this.listeners) listener() }

  /** Starts reading: now if the document is visible, and on every tick and every return to sight after. */
  start(): void {
    this.stopped = false
    document.addEventListener('visibilitychange', this.onVisibility)
    this.wake()
    this.pollSends(false)
  }
  stop(): void {
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    clearTimeout(this.timer)
    clearTimeout(this.sendsTimer)
  }
  /** The page's own card, as the last read has it. */
  card(): KanbanCard | undefined {
    return this.own && cardNamed(this.cards, this.own.uid, this.own.host)
  }

  private readonly onVisibility = (): void => {
    this.wake()
    this.pollSends(true)
  }

  private readonly wake = (): void => {
    clearTimeout(this.timer)
    if (this.stopped || document.visibilityState !== 'visible') return
    void this.read().finally(() => {
      if (this.stopped || document.visibilityState !== 'visible') return
      clearTimeout(this.timer)
      this.timer = window.setTimeout(this.wake, POLL_MS)
    })
  }

  private pollSends(force: boolean): void {
    clearTimeout(this.sendsTimer)
    if (this.stopped || document.visibilityState !== 'visible') return
    void this.sends.refresh(Date.now(), force).catch(() => {}).finally(() => {
      if (this.stopped || document.visibilityState !== 'visible') return
      clearTimeout(this.sendsTimer)
      this.sendsTimer = window.setTimeout(() => this.pollSends(true), SENDS_POLL_MS)
    })
  }

  private async read(): Promise<void> {
    try {
      const headers = new Headers()
      if (this.etag) headers.set('If-None-Match', this.etag)
      const res = await daemonFetch(`${this.base}/api/v1/fibers/composite`, { headers })
      if (res.status !== 304) {
        if (!res.ok) throw new Error(`The daemon answered ${res.status}`)
        this.etag = res.headers.get('ETag')
        const all = boardCards(buildKanbanResponseFromComposite(parseCompositeFeed(await res.json())))
        const own = this.own && cardNamed(all, this.own.uid, this.own.host)
        this.cards = all.filter(card => card === own || !archived(card))
        this.index = new ThreadIndex(this.cards)
        this.loaded = true
      }
      this.failure = null
      const card = this.card()
      if (card) { const root = this.index.rootOf(card); this.board.read([root.uid ?? root.id]) }
    } catch (error) {
      this.failure = isDaemonBooting(error) ? 'The daemon is starting…' : daemonErrorMessage(error)
    }
    this.changed()
  }
}
