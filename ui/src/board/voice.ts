import type { KanbanCard } from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'
import { isMobileViewport } from './mobile.js'

/** Words spoken to a constitution with no live worker, waiting for its next voice message. */
export interface VoiceHeld {
  fiber_id: string
  text: string
}

export interface VoiceStatus {
  /** The audio recorder, not the target card's origin. */
  recorder?: string
  available: boolean
  enabled: boolean
  muted: boolean
  state: 'off' | 'starting' | 'listening' | 'yielded' | 'failed'
  target: { fiber_id: string; origin: string; name: string } | null
  last: { fiber_id: string; at: string; status: 'delivered' | 'unconfirmed' | 'failed'; detail?: string } | null
  error: string | null
  held?: VoiceHeld[]
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

type VoiceTarget = NonNullable<VoiceStatus['target']>

/** One visible-tab poll and one ordered write stream per board. A target Rex moves to is handed to `onFollow`, so the board shows it. */
export class Voice {
  status: VoiceStatus | null = null
  onFollow: ((target: VoiceTarget) => void) | null = null
  /** The target last read from the daemon; undefined until the first read. */
  private seen: string | null | undefined = undefined
  private followed: VoiceTarget | null = null
  private revealed = ''
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
  private notify(): void { this.listeners.forEach(fn => fn()) }
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
    if (!this.mounted || typeof EventSource === 'undefined') return
    const events = new EventSource(`${this.base}/api/v1/voice/events`)
    events.addEventListener('target', this.pushed)
    events.addEventListener('error', () => {
      if (this.events === events && events.readyState === EventSource.CLOSED && this.eventsTimer === null)
        this.eventsTimer = window.setTimeout(this.openEvents, 5_000)
    })
    this.events = events
  }
  dispose(): void {
    this.mounted = false
    document.removeEventListener('visibilitychange', this.visibility)
    window.removeEventListener('shuttle-voice-settings-saved', this.settingsSaved)
    this.events?.close()
    this.events = null
    if (this.eventsTimer !== null) window.clearTimeout(this.eventsTimer)
    this.eventsTimer = null
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.read?.abort()
    this.read = null
  }
  /** A newly opened constitution's worker shows in Rex, which routes the mic from there. A card opened to follow Rex is already there. */
  select(card: KanbanCard | null): void {
    const agent = card && isAgentCard(card) ? card : null
    const key = agent ? JSON.stringify([agent.uid ?? agent.id, agent.originId]) : ''
    const followed = this.followed
    this.followed = null
    if (agent && followed && agent.originId === followed.origin && [agent.uid, agent.id].includes(followed.fiber_id)) {
      this.revealed = key
      return
    }
    if (key === this.revealed) return
    this.revealed = key
    if (!agent || !this.status?.enabled || document.hidden || isMobileViewport()) return
    const body = { fiber_id: agent.uid ?? agent.id, origin: agent.originId }
    void fetch(`${this.base}/api/v1/voice/reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {})
  }
  /** A pushed route follows at once; a read already in flight is stale and dropped. */
  private pushed = (event: Event): void => {
    if (!this.status) return
    this.revision++
    this.status = { ...this.status, target: JSON.parse((event as MessageEvent<string>).data) as VoiceStatus['target'] }
    this.notify()
    this.follow(this.status)
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
      if (this.timer !== null) window.clearTimeout(this.timer)
      this.timer = null
      this.read?.abort()
    } else {
      if (this.read) {
        this.read.abort()
        this.read = null
      }
      void this.poll()
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
  private follow(status: VoiceStatus): void {
    const key = status.target ? JSON.stringify([status.target.fiber_id, status.target.origin]) : null
    const known = this.seen
    this.seen = key
    if (known === undefined || key === known || !status.enabled || !status.target || isMobileViewport()) return
    this.followed = status.target
    this.onFollow?.(status.target)
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
        this.follow(status)
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
