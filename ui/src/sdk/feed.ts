/**
 * A live view of the composite feed: polls `ShuttleClient.fibersComposite`,
 * revalidating with the copy's ETag so an unchanged feed costs a 304, pauses
 * while the page is hidden and reads at once when it is shown again, and
 * tells its subscribers whenever its state changes.
 */
import { DaemonBootingError, daemonErrorMessage, type ShuttleClient } from './client.js'
import { notify } from './notify.js'
import type { ShuttleCompositeResponse, ShuttleFiber } from './types.js'

export type ShuttleFeedStatus = 'idle' | 'loading' | 'ready' | 'booting' | 'error'

export interface ShuttleFeedState {
  status: ShuttleFeedStatus
  /** The last feed's rows; kept through a failed read. */
  fibers: ShuttleFiber[]
  response: ShuttleCompositeResponse | null
  /** Why the last read failed, as a sentence. */
  error: string | null
  /** Epoch ms of the last successful read. */
  updatedAt: number | null
}

export interface ShuttleFeedOptions {
  /** Between reads while the page is visible; 15 s by default. */
  intervalMs?: number
  /** The document whose visibility pauses polling; the global one by default. */
  document?: Document
  /** The clock `updatedAt` reads. */
  now?: () => number
}

export class ShuttleFeed {
  readonly #client: ShuttleClient
  readonly #intervalMs: number
  readonly #document: Document | undefined
  readonly #now: () => number
  readonly #listeners = new Set<(state: ShuttleFeedState) => void>()
  #state: ShuttleFeedState = { status: 'idle', fibers: [], response: null, error: null, updatedAt: null }
  #etag: string | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #running = false
  #inflight: { read: Promise<ShuttleFeedState>; abort: AbortController } | undefined
  readonly #onVisibility = (): void => {
    if (!this.#running) return
    if (this.#hidden()) this.#clear()
    else void this.refresh()
  }

  constructor(client: ShuttleClient, options: ShuttleFeedOptions = {}) {
    this.#client = client
    this.#intervalMs = options.intervalMs ?? 15_000
    this.#document = options.document ?? (typeof document === 'undefined' ? undefined : document)
    this.#now = options.now ?? Date.now
  }

  /** Read now, then every interval while the page is visible. */
  start(): void {
    if (this.#running) return
    this.#running = true
    this.#document?.addEventListener('visibilitychange', this.#onVisibility)
    if (!this.#hidden()) void this.refresh()
  }

  /** Stop polling and abort a read in flight; the state stays as it was, a first read cut short leaving it idle. */
  stop(): void {
    this.#running = false
    this.#clear()
    this.#inflight?.abort.abort()
    this.#inflight = undefined
    if (this.#state.status === 'loading') this.#set({ status: 'idle' })
    this.#document?.removeEventListener('visibilitychange', this.#onVisibility)
  }

  getState(): ShuttleFeedState {
    return this.#state
  }

  /** Call `listener` on every change of state; returns its unsubscribe. */
  subscribe(listener: (state: ShuttleFeedState) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Read the feed now (joining a read already in flight), and resolve with the state it leaves. */
  refresh(): Promise<ShuttleFeedState> {
    if (this.#inflight) return this.#inflight.read
    const abort = new AbortController()
    const read = this.#read(abort.signal).finally(() => {
      if (abort.signal.aborted) return
      this.#inflight = undefined
      this.#schedule()
    })
    this.#inflight = { read, abort }
    // Told once the read is in flight, so a listener that refreshes joins it.
    if (!this.#state.response) this.#set({ status: 'loading' })
    return read
  }

  /** One read of the feed; one aborted meanwhile changes nothing. */
  async #read(signal: AbortSignal): Promise<ShuttleFeedState> {
    let patch: Partial<ShuttleFeedState>
    try {
      const read = await this.#client.fibersComposite({ etag: this.#etag, signal })
      if (signal.aborted) return this.#state
      this.#etag = read.etag
      patch = { status: 'ready', error: null, updatedAt: this.#now(), ...(read.notModified ? {} : { response: read.response, fibers: read.response.fibers ?? [] }) }
    } catch (error) {
      if (signal.aborted) return this.#state
      patch = error instanceof DaemonBootingError
        ? { status: 'booting', error: error.message }
        : { status: 'error', error: daemonErrorMessage(error) }
    }
    this.#set(patch)
    return this.#state
  }

  #set(patch: Partial<ShuttleFeedState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of [...this.#listeners]) notify(() => listener(this.#state))
  }

  #schedule(): void {
    this.#clear()
    if (this.#running && !this.#hidden()) this.#timer = setTimeout(() => { void this.refresh() }, this.#intervalMs)
  }

  #clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #hidden(): boolean {
    return this.#document?.visibilityState === 'hidden'
  }
}
