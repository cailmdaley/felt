/**
 * A read the board asks for far more often than it needs: on every poll, every
 * render, every view mount. One read runs at a time, a new one starts at most
 * once per `intervalMs`, and a failed read may run again at the next ask.
 */
export class ThrottledRead {
  private readAt = -Infinity
  private inflight: Promise<void> | null = null
  private readonly intervalMs: number
  private readonly read: () => Promise<void>

  constructor(intervalMs: number, read: () => Promise<void>) {
    this.intervalMs = intervalMs
    this.read = read
  }

  /** Start the read unless one is running or ran within the interval; `force` skips the interval. */
  run(force = false, nowMs = Date.now()): Promise<void> {
    if (this.inflight) return this.inflight
    if (!force && nowMs - this.readAt < this.intervalMs) return Promise.resolve()
    this.readAt = nowMs
    this.inflight = this.read()
      .catch(() => { this.readAt = -Infinity })
      .finally(() => { this.inflight = null })
    return this.inflight
  }
}
