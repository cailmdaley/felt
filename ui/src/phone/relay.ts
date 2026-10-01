/**
 * The page's end of `/api/v1/meeting/audio`: at most one WebSocket at a time,
 * binary frames of PCM out, the relay's status frames in.
 *
 * Nothing is held for later. A chunk goes out only while the relay reports
 * `connected` (hark is listening) and the socket keeps up (`BUFFERED_LIMIT`);
 * anything else is dropped. Once hark has listened, a drop starts a loss
 * (`onLoss(since, null)`), and the next chunk that goes out ends it
 * (`onLoss(since, until)`), so the page can say what is missing. A drop that is
 * not one of the relay's terminal closes reconnects with backoff until
 * `close()`; a socket that never opens counts as a drop. Every callback checks
 * it belongs to the current socket, so a late event from an old one changes
 * nothing.
 */

import {
  BUFFERED_LIMIT,
  TERMINAL_LINKS,
  closeMeaning,
  parseRelayStatus,
  reconnectDelay,
  type LinkState,
  type RelayStatus,
} from './phoneState'

/** The slice of WebSocket the relay uses, so tests can stand one in. */
export interface SocketLike {
  binaryType: BinaryType
  readonly readyState: number
  readonly bufferedAmount: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: ArrayBuffer): void
  close(code?: number, reason?: string): void
}

const OPEN = 1
/** A socket that has not opened by now (a proxy that swallowed the upgrade) is retried. */
const OPEN_TIMEOUT_MS = 10_000

export interface RelayOptions {
  url: string
  onLink: (link: LinkState, reason: string | null) => void
  /** Audio stopped reaching hark at `since`; `until` is set once it flows again. */
  onLoss?: (since: number, until: number | null) => void
  createSocket?: (url: string) => SocketLike
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  now?: () => number
}

export class RelayLink {
  private socket: SocketLike | null = null
  private lastStatus: RelayStatus | null = null
  private attempt = 0
  private timer: unknown = null
  private closed = true
  /** hark has listened on this link at least once. */
  private listened = false
  private readonly options: RelayOptions
  private readonly createSocket: (url: string) => SocketLike
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly now: () => number
  link: LinkState = 'idle'
  lostSince: number | null = null

  constructor(options: RelayOptions) {
    this.options = options
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.now = options.now ?? Date.now
  }

  open(): void {
    if (!this.closed) return
    this.closed = false
    this.connect()
  }

  /** Send one chunk if hark is listening and the socket keeps up; drop it otherwise. */
  send(chunk: ArrayBuffer): void {
    if (this.closed) return
    const socket = this.socket
    if (
      socket &&
      socket.readyState === OPEN &&
      this.link === 'connected' &&
      socket.bufferedAmount + chunk.byteLength <= BUFFERED_LIMIT
    ) {
      socket.send(chunk)
      if (this.lostSince !== null) {
        const since = this.lostSince
        this.lostSince = null
        this.options.onLoss?.(since, this.now())
      }
      return
    }
    this.markLoss()
  }

  /** Reconnect now rather than at the next backoff tick (the tab came back). */
  nudge(): void {
    if (this.closed || this.socket || this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.dropSocket(1000, 'mic stopped')
    // A terminal state stays what the page reads; only a live link goes idle.
    if (!TERMINAL_LINKS.has(this.link)) this.setLink('idle', null)
  }

  private markLoss(): void {
    if (!this.listened || this.lostSince !== null) return
    this.lostSince = this.now()
    this.options.onLoss?.(this.lostSince, null)
  }

  private dropSocket(code?: number, reason?: string): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    socket.close(code, reason)
  }

  private connect(): void {
    if (this.closed || this.socket) return
    this.lastStatus = null
    this.setLink(this.attempt === 0 && !this.listened ? 'opening' : 'reconnecting', null)
    let socket: SocketLike
    try {
      socket = this.createSocket(this.options.url)
    } catch (error) {
      this.retry(`could not open the relay: ${(error as Error).message}`)
      return
    }
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    const openTimer = this.setTimer(() => {
      if (this.socket !== socket || socket.readyState === OPEN) return
      this.dropSocket()
      this.retry('the relay did not answer')
    }, OPEN_TIMEOUT_MS)
    socket.onopen = () => {
      if (this.socket !== socket) return
      this.clearTimer(openTimer)
      this.attempt = 0
    }
    socket.onmessage = (event) => {
      if (this.socket !== socket || typeof event.data !== 'string') return
      const status = parseRelayStatus(event.data)
      if (!status) return
      this.lastStatus = status
      if (status.state === 'connected') this.listened = true
      this.setLink(status.state, status.reason)
    }
    socket.onerror = () => {}
    socket.onclose = (event) => {
      this.clearTimer(openTimer)
      if (this.socket !== socket) return
      this.socket = null
      const meaning = closeMeaning(event.code, this.lastStatus)
      if (TERMINAL_LINKS.has(meaning)) {
        this.closed = true
        this.setLink(meaning, this.lastStatus?.reason ?? event.reason ?? null)
        return
      }
      this.markLoss()
      this.retry(event.reason || null)
    }
  }

  private retry(reason: string | null): void {
    if (this.closed || this.timer !== null) return
    this.setLink('reconnecting', reason)
    const delay = reconnectDelay(this.attempt)
    this.attempt += 1
    this.timer = this.setTimer(() => {
      this.timer = null
      this.connect()
    }, delay)
  }

  private setLink(link: LinkState, reason: string | null): void {
    this.link = link
    this.options.onLink(link, reason)
  }
}
