import type { KanbanCard } from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'
import { coarsePointer, isMobileViewport } from './mobile.js'
import { getDaemonJson, postDaemonJson } from './daemonApi.js'

/** How long a view must hold before voice follows it, so a pan does not flap. */
const SIGHT_MS = 350
/** A voice write unanswered this long fails, so the writes queued behind it still go. */
const WRITE_MS = 15_000

export interface VoiceStatus {
  /** The audio recorder, not the target card's origin. */
  recorder?: string
  available: boolean
  enabled: boolean
  muted: boolean
  state: 'off' | 'starting' | 'listening' | 'failed'
  follow: boolean
  system_audio: boolean
  words?: number
  quiet_seconds?: number
  pinned_quiet_seconds?: number
  sources: Array<'desktop' | 'phone'>
  source: 'desktop' | 'phone'
  launch: string | null
  /** Where live voice goes; `source` names what set it, when that was not a board or Rex. A pushed route carries its `cold`. */
  target: VoiceDestination & { source?: string } | null
  last: { fiber_id: string; at: string; status: 'delivered' | 'unconfirmed' | 'failed'; detail?: string } | null
  error: string | null
  /** Whether Listen follows the view, stays pinned to a card, or records a meeting there. */
  mode?: 'off' | 'following' | 'pinned' | 'meeting'
  /** Where words go right now. */
  destination?: VoiceDestination | null
  paused?: boolean
}

/** The constitution a card's page speaks to: the card itself, or the nearest constitution above it by path on the same host. */
export const constitutionFor = (card: KanbanCard, cards: readonly KanbanCard[]): KanbanCard => {
  if (isAgentCard(card)) return card
  const parts = card.id.split('/')
  for (let n = parts.length - 1; n > 0; n--) {
    const id = parts.slice(0, n).join('/')
    const found = cards.find(c => c.id === id && c.originId === card.originId && isAgentCard(c))
    if (found) return found
  }
  return card
}

export const voicePollDelay = (visible: boolean, success: boolean, status: VoiceStatus | null): number | null =>
  !visible ? null : success && status?.enabled && status.state !== 'failed' ? 2_000 : 15_000

/** The worker Rex moved to. */
export interface RexMove {
  fiber_id: string
  origin: string
  name: string
}

/** A card Listen sends to. `cold`: it has no live worker, so words stay in the transcript unless they end with “send”. */
export interface VoiceDestination extends RexMove {
  cold?: boolean
}

/** The card Listen's words reach now. */
export const voiceDestination = (voice: VoiceStatus | null): VoiceDestination | null =>
  voice?.destination ?? voice?.target ?? null

/** A page of a fiber a session asked the board to show (`POST /api/v1/board/open`). */
export interface BoardOpen {
  fiber_id: string
  origin: string
  page: 'constitution' | 'tapestry' | 'files'
}

const observing = (status: VoiceStatus | null): boolean => !!status?.enabled
const sightKey = (card: KanbanCard | null): string => card ? `${card.originId}\u0000${card.uid ?? card.id}` : ''

export interface VoiceUpdate {
  enabled?: boolean
  muted?: boolean
  follow?: boolean
  /** true starts a meeting on `target`, unmuted; false ends one and follows again. */
  meeting?: boolean
  words?: number
  quiet_seconds?: number
  pinned_quiet_seconds?: number
  source?: 'desktop' | 'phone'
  target?: RexMove
}

/**
 * One visible-tab poll, one ordered write stream and one event stream per
 * board, the stream open only while the tab is visible. It carries the voice
 * target and, on a desktop, `onRex`, the board's one signal that Rex's worker
 * changed, voice on or off, and `onOpen`, a page a session asked for, on any
 * screen. A tab coming back moves nothing.
 * Whichever of Rex and the board moved last holds the target: Rex takes it by coming to the front
 * or changing worker, and the board when the human clicks something it shows, or sets voice from
 * the board, while it has the keyboard. Returning to the board's window takes nothing, and nor
 * does voice coming on from anywhere else.
 */
export class Voice {
  status: VoiceStatus | null = null
  onRex: ((move: RexMove) => void) | null = null
  onOpen: ((open: BoardOpen) => void) | null = null
  /** The card the inbox last set the target to, null for none; undefined before the first status, which moves nothing. */
  private inboxOpened: string | null | undefined
  /** The constitution the board shows, once it speaks to one. */
  private sighted: KanbanCard | null = null
  private sightTimer: number | null = null
  private events: EventSource | null = null
  private eventsRecorder: string | undefined
  private recorder: string | undefined
  private observedView = ''
  private eventsTimer: number | null = null
  private timer: number | null = null
  private expectedEnabled: boolean | null = null
  private settingsRetries = 0
  private read: AbortController | null = null
  private revision = 0
  private writes = Promise.resolve()
  private listeners = new Set<() => void>()
  private mounted = false
  private base: string
  constructor(base: string) { this.base = base }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private notify(): void {
    this.recorder = this.status?.recorder ?? this.recorder
    this.followInbox()
    if (this.status && this.eventsRecorder !== this.status.recorder) {
      this.closeEvents()
      this.openEvents()
    }
    this.listeners.forEach(fn => fn())
  }
  /** A card the inbox opens moves the board as Rex does, from any status that shows it: the recorder's daemon may be another host's, whose stream this board does not hear. */
  private followInbox(): void {
    if (!this.status) return
    const target = this.status.target, opened = target?.source === 'inbox' ? `${target.origin}\u0000${target.fiber_id}` : null
    const fresh = opened !== this.inboxOpened && this.inboxOpened !== undefined
    this.inboxOpened = opened
    if (fresh && target && opened && !isMobileViewport()) this.onRex?.(target)
  }
  mount(): void {
    this.mounted = true
    document.addEventListener('visibilitychange', this.visibility)
    window.addEventListener('shuttle-voice-settings-saved', this.settingsSaved)
    void this.poll()
    this.openEvents()
  }
  /** A stream refused outright, as by a daemon still booting after a deploy, is reopened after 5 s. */
  private openEvents = (): void => {
    this.eventsTimer = null
    if (!this.mounted || this.events || document.hidden || typeof EventSource === 'undefined') return
    this.eventsRecorder = this.recorder
    const query = new URLSearchParams()
    if (!coarsePointer()) query.set('rex', '1')
    if (this.eventsRecorder) query.set('recorder', this.eventsRecorder)
    const events = new EventSource(`${this.base}/api/v1/voice/events${query.size ? `?${query}` : ''}`)
    events.addEventListener('target', this.pushed)
    events.addEventListener('focus', this.rexMoved)
    events.addEventListener('page', event => this.onOpen?.(JSON.parse((event as MessageEvent<string>).data) as BoardOpen))
    events.addEventListener('error', () => {
      if (this.events === events && events.readyState === EventSource.CLOSED && this.eventsTimer === null) {
        this.events = null
        this.eventsTimer = window.setTimeout(this.openEvents, 5_000)
      }
    })
    this.events = events
  }
  private closeEvents(): void {
    this.events?.close()
    this.events = null
    if (this.eventsTimer !== null) window.clearTimeout(this.eventsTimer)
    this.eventsTimer = null
  }
  dispose(): void {
    this.mounted = false
    document.removeEventListener('visibilitychange', this.visibility)
    window.removeEventListener('shuttle-voice-settings-saved', this.settingsSaved)
    if (this.sightTimer !== null) window.clearTimeout(this.sightTimer)
    this.sightTimer = null
    this.closeEvents()
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.read?.abort()
    this.read = null
  }
  /**
   * The board now shows `card`, or no fiber at all. Voice follows once the view
   * holds. A repaint of what the board already shows claims nothing: two boards
   * that each re-sighted their page whenever the other moved the target would
   * take it back and forth without end.
   */
  see(card: KanbanCard | null): void {
    const same = sightKey(card) === sightKey(this.sighted)
    this.sighted = card
    if (same) return
    if (this.sightTimer !== null) window.clearTimeout(this.sightTimer)
    this.sightTimer = window.setTimeout(() => { this.sightTimer = null; this.claim() }, SIGHT_MS)
  }
  /** What the board shows takes the target, while the board has the keyboard. */
  private claim = (): void => {
    const card = this.sighted, status = this.status
    if (!card || !isAgentCard(card) || !observing(status) || !document.hasFocus()) return
    const viewKey = JSON.stringify([status?.recorder, card.originId, card.uid ?? card.id])
    if (status?.follow && status.target?.origin === card.originId && [card.uid, card.id].includes(status.target.fiber_id)) return
    if (!status?.follow && this.observedView === viewKey) return
    const target = { fiber_id: card.uid ?? card.id, origin: card.originId, name: card.name, ...(status?.recorder ? { recorder: status.recorder } : {}) }
    this.revision++
    const task = this.writes.then(async () => {
      const status = await this.post('/api/v1/voice/target', target)
      this.revision++
      this.observedView = viewKey
      this.status = status
      this.notify()
    })
    this.writes = task.catch(() => {})
  }
  private rexMoved = (event: Event): void => {
    if (!isMobileViewport()) this.onRex?.(JSON.parse((event as MessageEvent<string>).data) as RexMove)
  }
  /** A pushed route shows at once; a read already in flight is stale and dropped. */
  private pushed = (event: Event): void => {
    if (!this.status) return
    this.revision++
    const target = JSON.parse((event as MessageEvent<string>).data) as VoiceStatus['target']
    this.status = { ...this.status, target, destination: this.status.enabled ? target : null }
    this.notify()
  }
  private settingsSaved = (event: Event): void => {
    this.expectedEnabled = (event as CustomEvent<boolean>).detail
    this.settingsRetries = 10
    this.read?.abort()
    this.read = null
    void this.poll()
  }
  private visibility = (): void => {
    if (document.hidden) {
      this.closeEvents()
      if (this.timer !== null) window.clearTimeout(this.timer)
      this.timer = null
      this.read?.abort()
    } else {
      if (this.read) {
        this.read.abort()
        this.read = null
      }
      void this.poll()
      this.openEvents()
    }
  }
  async set(values: VoiceUpdate): Promise<void> {
    const task = this.writes.then(async () => {
      // Let a phone start select its recorder; every later control stays there.
      const recorder = values.source === 'phone' && values.enabled ? undefined : this.status?.recorder ?? this.recorder
      const status = await this.post('/api/v1/voice', { ...values, ...(recorder ? { recorder } : {}) })
      this.revision++
      this.status = status
      this.notify()
      this.claim()
    })
    this.writes = task.catch(() => {})
    return task
  }
  /** One write, abandoned after WRITE_MS whether or not the fetch honours its abort. */
  private post(path: string, body: unknown): Promise<VoiceStatus> {
    const controller = new AbortController()
    let timer = 0
    const deadline = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => { controller.abort(); reject(new Error('Voice request timed out')) }, WRITE_MS)
    })
    const request = postDaemonJson<VoiceStatus>(this.base, path, body, 'Voice request failed', { signal: controller.signal })
    return Promise.race([request, deadline]).finally(() => window.clearTimeout(timer))
  }
  private async poll(): Promise<void> {
    if (!this.mounted || document.hidden || this.read) return
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
    const controller = new AbortController()
    this.read = controller
    const revision = this.revision
    let success = false
    try {
      const query = this.recorder ? `?${new URLSearchParams({ recorder: this.recorder })}` : ''
      const status = await getDaemonJson<VoiceStatus>(`${this.base}/api/v1/voice${query}`, 'Voice unavailable', { signal: controller.signal })
      if (!controller.signal.aborted && revision === this.revision) {
        this.status = status
        if (this.expectedEnabled === status.enabled) this.expectedEnabled = null
        this.notify()
      }
      success = true
    } catch {
      if (!controller.signal.aborted && revision === this.revision) {
        this.status = null
        this.notify()
      }
    }
    finally {
      if (this.read === controller) this.read = null
      if (!controller.signal.aborted) {
        let delay = voicePollDelay(this.mounted && !document.hidden, success, this.status)
        if (delay !== null && this.expectedEnabled !== null && this.settingsRetries-- > 0) delay = 2_000
        else if (this.settingsRetries <= 0) this.expectedEnabled = null
        if (delay !== null) this.timer = window.setTimeout(() => { this.timer = null; void this.poll() }, delay)
      }
    }
  }
}
