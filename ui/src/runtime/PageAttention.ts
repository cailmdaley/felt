export type PageAttentionState = 'hidden' | 'visible-unfocused' | 'active'

export const UNFOCUSED_VISIBLE_FRAME_MS = 100
export const MIN_UNFOCUSED_POLL_INTERVAL_MS = 60_000

interface VisiblePollSchedulerOptions {
  intervalMs: number
  poll: () => void | Promise<void>
}

interface VisiblePollSchedulerStartOptions {
  immediate?: boolean
}

export function getPageAttention(): PageAttentionState {
  if (document.hidden) return 'hidden'
  if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
    return 'visible-unfocused'
  }
  return 'active'
}

export function isPageVisible(): boolean {
  return getPageAttention() !== 'hidden'
}

export function nextVisiblePollIntervalMs(activeIntervalMs: number): number {
  return Math.max(activeIntervalMs * 2, MIN_UNFOCUSED_POLL_INTERVAL_MS)
}

export function shouldRunVisiblePoll(
  lastRunAtMs: number | null,
  nowMs: number,
  activeIntervalMs: number,
): boolean {
  const attention = getPageAttention()
  if (attention === 'hidden') return false
  if (lastRunAtMs === null) return true
  const interval = attention === 'active'
    ? activeIntervalMs
    : nextVisiblePollIntervalMs(activeIntervalMs)
  return nowMs - lastRunAtMs >= interval
}

export class VisiblePollScheduler {
  private readonly intervalMs: number
  private readonly poll: () => void | Promise<void>
  private timeoutId: number | null = null
  private running = false
  private pollInFlight = false
  private lastPollStartedAtMs: number | null = null

  constructor(options: VisiblePollSchedulerOptions) {
    this.intervalMs = options.intervalMs
    this.poll = options.poll
  }

  start(options: VisiblePollSchedulerStartOptions = {}): void {
    if (this.running) return
    this.running = true
    document.addEventListener('visibilitychange', this.onAttentionChanged)
    window.addEventListener('focus', this.onAttentionChanged)
    this.scheduleNext(options.immediate ?? true)
  }

  stop(): void {
    if (!this.running) return
    this.running = false
    this.clearTimer()
    document.removeEventListener('visibilitychange', this.onAttentionChanged)
    window.removeEventListener('focus', this.onAttentionChanged)
  }

  requestNow(): void {
    if (!this.running) return
    this.clearTimer()
    this.scheduleNext(true)
  }

  private readonly onAttentionChanged = (): void => {
    if (!this.running) return
    this.scheduleNext()
  }

  private scheduleNext(immediate = false): void {
    this.clearTimer()
    if (!this.running || getPageAttention() === 'hidden') return

    const delayMs = immediate ? 0 : this.nextDelayMs(Date.now())
    this.timeoutId = window.setTimeout(() => {
      this.timeoutId = null
      void this.runPoll()
    }, delayMs)
  }

  private async runPoll(): Promise<void> {
    if (!this.running) return
    if (getPageAttention() === 'hidden') {
      this.scheduleNext()
      return
    }
    if (this.pollInFlight) {
      this.scheduleNext()
      return
    }

    this.pollInFlight = true
    this.lastPollStartedAtMs = Date.now()
    try {
      await this.poll()
    } finally {
      this.pollInFlight = false
      this.scheduleNext()
    }
  }

  private nextDelayMs(nowMs: number): number {
    if (this.lastPollStartedAtMs === null) return 0
    const intervalMs = getPageAttention() === 'active'
      ? this.intervalMs
      : nextVisiblePollIntervalMs(this.intervalMs)
    return Math.max(0, this.lastPollStartedAtMs + intervalMs - nowMs)
  }

  private clearTimer(): void {
    if (this.timeoutId === null) return
    window.clearTimeout(this.timeoutId)
    this.timeoutId = null
  }
}
