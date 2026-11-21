import { getDaemonJson, postDaemonJson } from './daemonApi.js'

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
  /** Where live voice goes; `source` names what set it, when that was not Rex. A pushed route carries its `cold`. */
  target: VoiceDestination & { source?: string } | null
  last: { fiber_id: string; at: string; status: 'delivered' | 'unconfirmed' | 'failed'; detail?: string } | null
  error: string | null
  /** Whether Listen follows Rex, stays pinned to a card, or records a meeting there. */
  mode?: 'off' | 'following' | 'pinned' | 'meeting'
  /** Where words go right now. */
  destination?: VoiceDestination | null
  paused?: boolean
}

export const voicePollDelay = (visible: boolean, success: boolean, status: VoiceStatus | null): number | null =>
  !visible ? null : success && status?.enabled && status.state !== 'failed' ? 2_000 : 15_000

/** A card Listen sends to. `cold`: it has no live worker, so words stay in the transcript unless they end with “send”. */
export interface VoiceDestination {
  fiber_id: string
  origin: string
  name: string
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
  target?: Pick<VoiceDestination, 'fiber_id' | 'origin' | 'name'>
}

/**
 * One visible-tab poll, one ordered write stream and one event stream per
 * board, the stream open only while the tab is visible. It carries the voice
 * target and `onOpen`, a page a session asked for.
 */
export class Voice {
  status: VoiceStatus | null = null
  onOpen: ((open: BoardOpen) => void) | null = null
  private events: EventSource | null = null
  private eventsRecorder: string | undefined
  private recorder: string | undefined
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
    if (this.status && this.eventsRecorder !== this.status.recorder) {
      this.closeEvents()
      this.openEvents()
    }
    this.listeners.forEach(fn => fn())
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
    if (this.eventsRecorder) query.set('recorder', this.eventsRecorder)
    const events = new EventSource(`${this.base}/api/v1/voice/events${query.size ? `?${query}` : ''}`)
    events.addEventListener('target', this.pushed)
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
    this.closeEvents()
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.read?.abort()
    this.read = null
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
