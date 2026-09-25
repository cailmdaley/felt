/**
 * One change-aware watcher for every live file-reading surface.
 *
 * A watcher sends conditional GETs when the daemon exposes validators. Older
 * remote daemons may return the full file every time, so each 200 also gets a
 * client-side content fingerprint; views update only when that fingerprint
 * moves. Watchers for the same URL share one request; inactive tabs pause until
 * activation revalidates them, and hidden pages do no work.
 */

export const LIVE_FILE_POLL_INTERVAL_MS = 4_000
const MAX_ERROR_BACKOFF_MS = 60_000

type FileSubscriber = {
  onContent: (content: string) => void
  onError?: (error: unknown) => void
  active: boolean
  fingerprint: string | null
}

type WatchedFile = {
  subscribers: Set<FileSubscriber>
  etag: string | null
  lastModified: string | null
  fingerprint: string | null
  content: string | null
  failures: number
  nextPollAt: number
  inFlight: Promise<void> | null
  forceRefresh: Promise<void> | null
  controller: AbortController | null
}

export type LiveFileSubscription = (() => void) & {
  suspend: () => void
  resume: () => Promise<void>
}

export interface LiveFileRefreshOptions {
  fetch?: typeof fetch
  now?: () => number
  isVisible?: () => boolean
  intervalMs?: number
  maxBackoffMs?: number
  setInterval?: typeof globalThis.setInterval
  clearInterval?: typeof globalThis.clearInterval
  onVisibilityChange?: (listener: () => void) => () => void
}

/**
 * Poll file URLs once per page, regardless of how many reader surfaces show
 * them. The clock, visibility source, and timer are injectable so the polling
 * contract can be tested without a browser.
 */
export class LiveFileRefresh {
  private readonly fetchFile: typeof fetch
  private readonly now: () => number
  private readonly isVisible: () => boolean
  private readonly intervalMs: number
  private readonly maxBackoffMs: number
  private readonly schedule: typeof globalThis.setInterval
  private readonly cancelSchedule: typeof globalThis.clearInterval
  private readonly listenVisibility: (listener: () => void) => () => void
  private readonly files = new Map<string, WatchedFile>()
  private timer: ReturnType<typeof globalThis.setInterval> | null = null
  private stopListening: (() => void) | null = null

  constructor(options: LiveFileRefreshOptions = {}) {
    this.fetchFile = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.isVisible = options.isVisible ?? (() => typeof document === 'undefined' || !document.hidden)
    this.intervalMs = options.intervalMs ?? LIVE_FILE_POLL_INTERVAL_MS
    this.maxBackoffMs = options.maxBackoffMs ?? MAX_ERROR_BACKOFF_MS
    this.schedule = options.setInterval ?? globalThis.setInterval.bind(globalThis)
    this.cancelSchedule = options.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    this.listenVisibility = options.onVisibilityChange ?? ((listener) => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    })
  }

  watch(url: string, onContent: (content: string) => void, onError?: (error: unknown) => void): LiveFileSubscription {
    let file = this.files.get(url)
    if (!file) {
      file = {
        subscribers: new Set(),
        etag: null,
        lastModified: null,
        fingerprint: null,
        content: null,
        failures: 0,
        nextPollAt: 0,
        inFlight: null,
        forceRefresh: null,
        controller: null,
      }
      this.files.set(url, file)
      this.start()
    }

    const subscriber = { onContent, onError, active: true, fingerprint: null }
    file.subscribers.add(subscriber)
    if (file.content !== null) this.deliverContent(subscriber, file.content)
    else void this.pollFile(url, file)

    let disposed = false
    const stop = (() => {
      if (disposed) return
      disposed = true
      const current = this.files.get(url)
      if (!current) return
      current.subscribers.delete(subscriber)
      if (current.subscribers.size === 0) {
        current.controller?.abort()
        this.files.delete(url)
        if (this.files.size === 0) this.stop()
      } else if (!this.hasActiveSubscribers(current)) {
        current.controller?.abort()
      }
    }) as LiveFileSubscription
    stop.suspend = () => {
      if (disposed || !subscriber.active) return
      subscriber.active = false
      if (!this.hasActiveSubscribers(file)) file.controller?.abort()
    }
    stop.resume = () => {
      if (disposed || subscriber.active) return Promise.resolve()
      subscriber.active = true
      if (file.content !== null) this.deliverContent(subscriber, file.content)
      return this.refresh(url)
    }
    return stop
  }

  /** Poll every due file now; hidden pages do no work. */
  async pollNow(): Promise<void> {
    if (!this.isVisible()) return
    await Promise.all([...this.files].map(([url, file]) => this.pollFile(url, file)))
  }

  /** Revalidate one watched URL immediately, bypassing its current validators. */
  async refresh(url: string): Promise<void> {
    const file = this.files.get(url)
    if (!file || !this.isVisible()) return
    if (file.forceRefresh) return file.forceRefresh

    const pending = this.forceRead(url, file)
    file.forceRefresh = pending
    try {
      await pending
    } finally {
      if (file.forceRefresh === pending) file.forceRefresh = null
    }
  }

  private async forceRead(url: string, file: WatchedFile): Promise<void> {
    file.etag = null
    file.lastModified = null
    file.nextPollAt = 0
    if (file.inFlight) await file.inFlight
    if (this.files.get(url) !== file || !this.isVisible()) return
    file.etag = null
    file.lastModified = null
    file.nextPollAt = 0
    await this.pollFile(url, file, true)
  }

  private start(): void {
    if (this.timer !== null) return
    this.timer = this.schedule(() => void this.pollNow(), this.intervalMs)
    this.stopListening = this.listenVisibility(() => {
      if (this.isVisible()) void this.pollNow()
    })
  }

  private stop(): void {
    if (this.timer !== null) this.cancelSchedule(this.timer)
    this.timer = null
    this.stopListening?.()
    this.stopListening = null
  }

  private async pollFile(url: string, file: WatchedFile, force = false): Promise<void> {
    if (this.files.get(url) !== file || file.subscribers.size === 0 || !this.isVisible()) return
    if (!force && !this.hasActiveSubscribers(file)) return
    if (file.inFlight) {
      if (!force) return
      await file.inFlight
      return this.pollFile(url, file, true)
    }
    if (!force && this.now() < file.nextPollAt) return

    const controller = new AbortController()
    file.controller = controller
    const headers: Record<string, string> = {}
    if (file.etag) headers['If-None-Match'] = file.etag
    else if (file.lastModified) headers['If-Modified-Since'] = file.lastModified

    let request: Promise<void>
    request = (async () => {
      try {
        const response = await this.fetchFile(url, {
          cache: 'no-store',
          headers,
          signal: controller.signal,
        })
        if (this.files.get(url) !== file) return

        if (response.status === 304) {
          file.etag = response.headers.get('etag') ?? file.etag
          file.lastModified = response.headers.get('last-modified') ?? file.lastModified
          file.failures = 0
          file.nextPollAt = this.now() + this.intervalMs
          return
        }
        if (!response.ok) throw new Error(`file request failed: ${response.status}`)

        const content = await response.text()
        if (this.files.get(url) !== file) return
        const fingerprint = contentFingerprint(content)
        file.etag = response.headers.get('etag')
        file.lastModified = response.headers.get('last-modified')
        file.failures = 0
        file.nextPollAt = this.now() + this.intervalMs
        if (fingerprint !== file.fingerprint) {
          file.fingerprint = fingerprint
          file.content = content
          for (const subscriber of file.subscribers) {
            if (subscriber.active) this.deliverContent(subscriber, content)
          }
        }
      } catch (error) {
        if (this.files.get(url) !== file || controller.signal.aborted) return
        file.failures += 1
        file.nextPollAt = this.now() + Math.min(this.intervalMs * 2 ** file.failures, this.maxBackoffMs)
        for (const subscriber of file.subscribers) {
          if (subscriber.active) subscriber.onError?.(error)
        }
      }
    })().finally(() => {
      if (this.files.get(url) === file && file.inFlight === request) {
        file.inFlight = null
        file.controller = null
      }
    })
    file.inFlight = request
    await request
  }

  private hasActiveSubscribers(file: WatchedFile): boolean {
    return [...file.subscribers].some((subscriber) => subscriber.active)
  }

  private deliverContent(subscriber: FileSubscriber, content: string): void {
    const fingerprint = contentFingerprint(content)
    if (subscriber.fingerprint === fingerprint) return
    subscriber.fingerprint = fingerprint
    try {
      subscriber.onContent(content)
    } catch {
      // One view failing to render must not stop another view of the same file.
    }
  }
}

/** A fast 128-bit fingerprint for legacy daemons that do not return validators. */
export function contentFingerprint(content: string): string {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  let c = 0x85ebca6b
  let d = 0xc2b2ae35
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i)
    a = Math.imul(a ^ code, 0x01000193)
    b = Math.imul(b ^ code, 0x5bd1e995)
    c = Math.imul(c ^ code, 0x27d4eb2d)
    d = Math.imul(d ^ code, 0x165667b1)
  }
  return `${content.length}:${a >>> 0}:${b >>> 0}:${c >>> 0}:${d >>> 0}`
}

export const liveFileRefresh = new LiveFileRefresh()

export function watchLiveFile(
  url: string,
  onContent: (content: string) => void,
  onError?: (error: unknown) => void,
): LiveFileSubscription {
  return liveFileRefresh.watch(url, onContent, onError)
}

export function refreshLiveFile(url: string): Promise<void> {
  return liveFileRefresh.refresh(url)
}
