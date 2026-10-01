/**
 * The page's end of `/api/v1/meeting/audio`: one WebSocket at a time, binary
 * frames of PCM out, the relay's status frames in. Audio sent while the
 * socket is down is held (`ChunkQueue`) and flushed on reopen. A drop that is
 * not one of the relay's terminal closes reconnects with backoff until
 * `close()`. A socket that never opens counts as a drop.
 */

import {
  ChunkQueue,
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
  createSocket?: (url: string) => SocketLike
  setTimer?: (run: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  queue?: ChunkQueue
}

export class RelayLink {
  private socket: SocketLike | null = null
  private lastStatus: RelayStatus | null = null
  private attempt = 0
  private timer: unknown = null
  private closed = false
  private readonly queue: ChunkQueue
  private readonly createSocket: (url: string) => SocketLike
  private readonly setTimer: (run: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly options: RelayOptions
  link: LinkState = 'idle'

  constructor(options: RelayOptions) {
    this.options = options
    this.queue = options.queue ?? new ChunkQueue()
    this.createSocket = options.createSocket ?? ((url) => new WebSocket(url))
    this.setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  open(): void {
    this.closed = false
    this.connect()
  }

  /** Send one chunk now, or hold it until the socket is open. */
  send(chunk: ArrayBuffer): void {
    if (this.closed) return
    if (this.socket?.readyState === OPEN) {
      this.flush()
      this.socket.send(chunk)
    } else {
      this.queue.push(chunk)
    }
  }

  /** Reconnect now rather than at the next backoff tick (the tab came back). */
  nudge(): void {
    if (this.closed || this.link !== 'reconnecting') return
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.connect()
  }

  close(): void {
    this.closed = true
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.close(1000, 'mic stopped')
    }
    this.queue.drain()
    // A terminal state stays what the page reads; only a live link goes idle.
    if (!TERMINAL_LINKS.has(this.link)) this.setLink('idle', null)
  }

  private connect(): void {
    this.lastStatus = null
    this.setLink(this.attempt === 0 ? 'opening' : 'reconnecting', null)
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
      this.socket = null
      socket.onclose = null
      socket.close()
      this.retry('the relay did not answer')
    }, OPEN_TIMEOUT_MS)
    socket.onopen = () => {
      this.clearTimer(openTimer)
      this.attempt = 0
      this.flush()
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const status = parseRelayStatus(event.data)
      if (!status) return
      this.lastStatus = status
      const reason = status.droppedBytes > 0
        ? `${status.reason ?? ''}${status.reason ? '; ' : ''}${(status.droppedBytes / 32_000).toFixed(1)} s of early audio was dropped`
        : status.reason
      this.setLink(status.state, reason)
    }
    socket.onerror = () => {}
    socket.onclose = (event) => {
      this.clearTimer(openTimer)
      if (this.socket !== socket) return
      this.socket = null
      const meaning = closeMeaning(event.code, this.lastStatus)
      if (TERMINAL_LINKS.has(meaning)) {
        this.closed = true
        this.queue.drain()
        this.setLink(meaning, this.lastStatus?.reason ?? event.reason ?? null)
        return
      }
      this.retry(event.reason || null)
    }
  }

  private flush(): void {
    const socket = this.socket
    if (!socket || socket.readyState !== OPEN) return
    for (const chunk of this.queue.drain()) socket.send(chunk)
  }

  private retry(reason: string | null): void {
    if (this.closed) return
    this.setLink('reconnecting', reason)
    const delay = reconnectDelay(this.attempt)
    this.attempt += 1
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.closed) this.connect()
    }, delay)
  }

  private setLink(link: LinkState, reason: string | null): void {
    this.link = link
    this.options.onLink(link, reason)
  }
}
