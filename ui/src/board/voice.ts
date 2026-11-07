import type { KanbanCard } from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'
import { coarsePointer, isMobileViewport } from './mobile.js'

/** How long a view must hold before voice follows it, so a pan does not flap. */
const SIGHT_MS = 350

export interface VoiceStatus {
  /** The audio recorder, not the target card's origin. */
  recorder?: string
  available: boolean
  enabled: boolean
  muted: boolean
  state: 'off' | 'starting' | 'listening' | 'yielded' | 'failed'
  /** Where live voice goes; `source` names what set it, when that was not a board or Rex. */
  target: (RexMove & { source?: string }) | null
  last: { fiber_id: string; at: string; status: 'delivered' | 'unconfirmed' | 'failed'; detail?: string } | null
  error: string | null
  /** What holds the mic: following the card in view, a meeting joined to one card, or nothing. */
  mode?: 'off' | 'following' | 'meeting'
  /** Where words go right now. */
  destination?: RexMove | null
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

const following = (status: VoiceStatus | null): boolean => !!status?.enabled && status.state !== 'yielded'

/**
 * One visible-tab poll, one ordered write stream and one event stream per
 * board, the stream open only while the tab is visible. It carries the voice
 * target and, on a desktop, `onRex`, the board's one signal that Rex's worker
 * changed, voice on or off. A tab coming back moves nothing.
 * Whichever of Rex and the board had focus last holds the target: Rex takes it by coming to the front
 * or changing worker, and the board by showing something or regaining focus,
 * while it has the keyboard.
 */
export class Voice {
  status: VoiceStatus | null = null
  onRex: ((move: RexMove) => void) | null = null
  /** The card the inbox last set the target to, null for none; undefined before the first status, which moves nothing. */
  private inboxOpened: string | null | undefined
  /** The constitution the board shows, once it speaks to one. */
  private sighted: KanbanCard | null = null
  private sightTimer: number | null = null
  private couldClaim = false
  private events: EventSource | null = null
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
    this.followInbox()
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
    window.addEventListener('focus', this.claim)
    void this.poll()
    this.openEvents()
  }
  /** A stream refused outright, as by a daemon still booting after a deploy, is reopened after 5 s. */
  private openEvents = (): void => {
    this.eventsTimer = null
    if (!this.mounted || this.events || document.hidden || typeof EventSource === 'undefined') return
    const events = new EventSource(`${this.base}/api/v1/voice/events${coarsePointer() ? '' : '?rex=1'}`)
    events.addEventListener('target', this.pushed)
    events.addEventListener('focus', this.rexMoved)
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
    window.removeEventListener('focus', this.claim)
    if (this.sightTimer !== null) window.clearTimeout(this.sightTimer)
    this.sightTimer = null
    this.closeEvents()
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.read?.abort()
    this.read = null
  }
  /** The board now shows `card`, or no fiber at all. Voice follows once the view holds. */
  see(card: KanbanCard | null): void {
    this.sighted = card
    if (this.sightTimer !== null) window.clearTimeout(this.sightTimer)
    this.sightTimer = window.setTimeout(() => { this.sightTimer = null; this.claim() }, SIGHT_MS)
  }
  /** What the board shows takes the target, while the board has the keyboard. */
  private claim = (): void => {
    const card = this.sighted, status = this.status
    if (!card || !isAgentCard(card) || !following(status) || !document.hasFocus() || isMobileViewport()) return
    if (status?.target?.origin === card.originId && [card.uid, card.id].includes(status.target.fiber_id)) return
    const target = { fiber_id: card.uid ?? card.id, origin: card.originId, name: card.name }
    this.revision++
    const task = this.writes.then(async () => {
      const response = await fetch(`${this.base}/api/v1/voice/target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target) })
      if (!response.ok) throw new Error(`Voice request failed (${response.status})`)
      this.revision++
      this.status = await response.json() as VoiceStatus
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
    this.status = { ...this.status, target: JSON.parse((event as MessageEvent<string>).data) as VoiceStatus['target'] }
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
  async set(values: { enabled?: boolean; muted?: boolean }): Promise<void> {
    const task = this.writes.then(async () => {
      const response = await fetch(`${this.base}/api/v1/voice`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values) })
      if (!response.ok) throw new Error(`Voice request failed (${response.status})`)
      this.revision++
      this.status = await response.json() as VoiceStatus
      this.notify()
    })
    this.writes = task.catch(() => {})
    return task
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
      const response = await fetch(`${this.base}/api/v1/voice`, { signal: controller.signal })
      if (!response.ok) throw new Error('voice unavailable')
      const status = await response.json() as VoiceStatus
      if (!controller.signal.aborted && revision === this.revision) {
        this.status = status
        if (this.expectedEnabled === status.enabled) this.expectedEnabled = null
        this.notify()
        // Following returning, or focus landing in a report's frame, which fires no window focus.
        const canClaim = following(status) && document.hasFocus()
        if (canClaim && !this.couldClaim) this.claim()
        this.couldClaim = canClaim
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
