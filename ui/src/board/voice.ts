import type { KanbanCard } from './KanbanTypes.js'
import { isAgentCard } from './KanbanModalShared.js'
import { isMobileViewport } from './mobile.js'

export interface VoiceHeld {
  id: string
  fiber_id: string
  origin: string
  through: number
  text: string
}

export class VoiceRequestError extends Error {
  readonly status: number
  constructor(status: number) {
    super(status === 409 ? 'These voice words have already been sent. The composer has been refreshed.' : `Voice request failed (${status})`)
    this.status = status
  }
}

export interface VoiceStatus {
  available: boolean
  enabled: boolean
  muted: boolean
  state: 'off' | 'starting' | 'listening' | 'yielded' | 'failed'
  target: { fiber_id: string; origin: string; name: string } | null
  pending: { fiber_id: string; words: number; text: string } | null
  preview?: { fiber_id: string; origin: string; text: string } | null
  last: { fiber_id: string; at: string; status: 'delivered' | 'unconfirmed' | 'failed'; detail?: string } | null
  error: string | null
  cold?: boolean
  held?: VoiceHeld[]
}

export const voicePollDelay = (visible: boolean, success: boolean, status: VoiceStatus | null): number | null =>
  !visible ? null : success && status?.enabled && status.state !== 'failed' ? 2_000 : 15_000

/** One visible-tab poll and one ordered write stream per board. */
export class Voice {
  status: VoiceStatus | null = null
  private card: KanbanCard | null = null
  private lastTarget = ''
  private timer: number | null = null
  private focusTimer: number | null = null
  private expectedEnabled: boolean | null = null
  private settingsRetries = 0
  private read: AbortController | null = null
  private revision = 0
  private enabledIntent: boolean | null = null
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
    window.addEventListener('focus', this.focus)
    window.addEventListener('shuttle-voice-settings-saved', this.settingsSaved)
    void this.poll()
  }
  dispose(): void {
    this.mounted = false
    document.removeEventListener('visibilitychange', this.visibility)
    window.removeEventListener('focus', this.focus)
    window.removeEventListener('shuttle-voice-settings-saved', this.settingsSaved)
    if (this.timer !== null) window.clearTimeout(this.timer)
    if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
    this.focusTimer = null
    this.read?.abort()
    this.read = null
  }
  select(card: KanbanCard | null): void {
    this.card = card && isAgentCard(card) ? card : null
    if (!this.card) this.lastTarget = ''
    this.target(false)
  }
  private focus = (): void => {
    if (document.hidden || this.focusTimer !== null) return
    this.focusTimer = window.setTimeout(() => { this.focusTimer = null; this.target(true) }, 50)
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
      if (this.focusTimer !== null) window.clearTimeout(this.focusTimer)
      this.focusTimer = null
      this.read?.abort()
    } else {
      this.focus()
      if (this.read) {
        this.read.abort()
        this.read = null
      }
      void this.poll()
    }
  }
  private target(force: boolean): void {
    if (!this.status?.enabled || this.enabledIntent === false || !this.card || document.hidden || isMobileViewport()) return
    const id = this.card.uid ?? this.card.id
    const key = JSON.stringify([id, this.card.originId])
    if (!force && key === this.lastTarget) return
    this.lastTarget = key
    void this.post('/target', { fiber_id: id, origin: this.card.originId }, () => this.enabledIntent !== false).catch(() => { this.lastTarget = '' })
  }
  async set(values: { enabled?: boolean; muted?: boolean }): Promise<void> {
    if (values.enabled !== undefined) this.enabledIntent = values.enabled
    try {
      await this.post('', values)
      if (values.enabled) this.target(true)
    } finally {
      if (values.enabled !== undefined && this.enabledIntent === values.enabled) this.enabledIntent = null
    }
  }
  editHeld(held: Pick<VoiceHeld, 'id' | 'through'>, text: string): Promise<void> {
    return this.post('/draft', { id: held.id, through: held.through, text })
  }
  releaseHeld(held: Pick<VoiceHeld, 'id' | 'through'>): Promise<void> {
    return this.post('/release', { id: held.id, through: held.through })
  }
  private async post(path: string, body: object, allowed: () => boolean = () => true): Promise<void> {
    const task = this.writes.then(async () => {
      if (!allowed()) return
      const response = await fetch(`${this.base}/api/v1/voice${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!response.ok) {
        if (response.status === 409 && (path === '/draft' || path === '/release')) {
          try {
            const fresh = await fetch(`${this.base}/api/v1/voice`)
            if (fresh.ok) {
              this.revision++
              this.status = await fresh.json() as VoiceStatus
              this.notify()
            }
          } catch { /* the claim conflict remains authoritative if refresh fails */ }
        }
        throw new VoiceRequestError(response.status)
      }
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
        const wasEnabled = this.status?.enabled
        this.status = status
        if (this.expectedEnabled === status.enabled) this.expectedEnabled = null
        this.notify()
        if (!wasEnabled && status.enabled) this.target(true)
      }
      success = true
    } catch {
      if (!controller.signal.aborted && revision === this.revision) {
        this.status = null
        this.lastTarget = ''
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
