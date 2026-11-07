/** The worker Rex moved to. */
export interface RexFocusEvent {
  fiber_id: string
  origin: string
  name: string
}

/** The board's one signal that Rex's worker changed, with voice on or off. Handling it never writes back: Rex moves the board, not the reverse. */
export class RexFocus {
  private events: EventSource | null = null
  private timer: number | null = null
  private mounted = false
  private readonly base: string
  private readonly moved: (focus: RexFocusEvent) => void
  constructor(base: string, moved: (focus: RexFocusEvent) => void) { this.base = base; this.moved = moved }
  mount(): void {
    this.mounted = true
    this.open()
  }
  /** A stream refused outright, as by a daemon still booting after a deploy, is reopened after 5 s. */
  private open = (): void => {
    this.timer = null
    if (!this.mounted || typeof EventSource === 'undefined') return
    const events = new EventSource(`${this.base}/api/v1/rex/focus`)
    events.addEventListener('focus', event => this.moved(JSON.parse((event as MessageEvent<string>).data) as RexFocusEvent))
    events.addEventListener('error', () => {
      if (this.events === events && events.readyState === EventSource.CLOSED && this.timer === null)
        this.timer = window.setTimeout(this.open, 5_000)
    })
    this.events = events
  }
  dispose(): void {
    this.mounted = false
    this.events?.close()
    this.events = null
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }
}
