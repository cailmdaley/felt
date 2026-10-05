/**
 * One change-aware watcher for every live file-reading surface.
 *
 * A watcher sends conditional GETs against the file endpoint's content-digest
 * ETag. Every 200 also gets a client-side content fingerprint, and views
 * update only when that fingerprint moves — so a forced re-read, or an owner
 * that answers without a digest validator, repaints nothing when the body is
 * unchanged. Watchers for the same URL share one request; inactive tabs pause
 * until activation revalidates them, and hidden pages do no work.
 */

export const LIVE_FILE_POLL_INTERVAL_MS = 4_000

/** The file endpoint's content-digest ETag: `W/"sha256-<hex>"`. */
const DIGEST_ETAG = /^W\/"sha256-[0-9a-f]{64}"$/
const MAX_ERROR_BACKOFF_MS = 60_000

type FileSubscriber = {
  onContent: (content: string) => void
  onError?: (error: unknown) => void
  onRecover?: () => void
  failed: boolean
  active: boolean
  initializing: boolean
  fingerprint: string | null
}

type WatchedFile = {
  subscribers: Set<FileSubscriber>
  etag: string | null
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
  loadOnce: () => Promise<void>
}

export interface LiveFileWatchOptions {
  active?: boolean
  /** An inactive preview may read once without joining periodic polling. */
  loadOnce?: boolean
  /** A successful read after an error, even when the bytes are unchanged. */
  onRecover?: () => void
}

export interface LiveFileRefreshOptions {
  fetch?: typeof fetch
  now?: () => number
  isVisible?: () => boolean
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
    this.schedule = options.setInterval ?? globalThis.setInterval.bind(globalThis)
    this.cancelSchedule = options.clearInterval ?? globalThis.clearInterval.bind(globalThis)
    this.listenVisibility = options.onVisibilityChange ?? ((listener) => {
      if (typeof document === 'undefined') return () => {}
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    })
  }

  watch(url: string, onContent: (content: string) => void, onError?: (error: unknown) => void, options: LiveFileWatchOptions = {}): LiveFileSubscription {
    let file = this.files.get(url)
    if (!file) {
      file = {
        subscribers: new Set(),
        etag: null,
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

    const subscriber: FileSubscriber = {
      onContent, onError, onRecover: options.onRecover, failed: false, active: options.active !== false,
      initializing: options.active === false && options.loadOnce === true, fingerprint: null,
    }
    file.subscribers.add(subscriber)
    if (file.content !== null) this.deliverContent(subscriber, file.content)
    else if (subscriber.active || subscriber.initializing) void this.pollFile(url, file, false, subscriber.initializing)

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
      } else if (!this.hasInterestedSubscribers(current)) {
        current.controller?.abort()
      }
    }) as LiveFileSubscription
    stop.suspend = () => {
      if (disposed || (!subscriber.active && !subscriber.initializing)) return
      subscriber.active = false
      subscriber.initializing = false
      if (!this.hasInterestedSubscribers(file)) file.controller?.abort()
    }
    stop.resume = () => {
      if (disposed || subscriber.active) return Promise.resolve()
      subscriber.active = true
      subscriber.initializing = false
      if (file.content !== null) this.deliverContent(subscriber, file.content)
      return this.refresh(url)
    }
    stop.loadOnce = () => {
      if (disposed || subscriber.active || subscriber.initializing) return Promise.resolve()
      subscriber.initializing = true
      if (file.content !== null) {
        this.deliverContent(subscriber, file.content)
        return Promise.resolve()
      }
      return this.pollFile(url, file, false, true)
    }
    return stop
  }

  /** True while a reader surface watches this URL. */
  watched(url: string): boolean {
    return this.files.has(url)
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
    file.nextPollAt = 0
    if (file.inFlight) await file.inFlight
    if (this.files.get(url) !== file || !this.isVisible()) return
    file.etag = null
    file.nextPollAt = 0
    await this.pollFile(url, file, true)
  }

  private start(): void {
    if (this.timer !== null) return
    this.timer = this.schedule(() => void this.pollNow(), LIVE_FILE_POLL_INTERVAL_MS)
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

  private async pollFile(url: string, file: WatchedFile, force = false, initial = false): Promise<void> {
    if (this.files.get(url) !== file || file.subscribers.size === 0 || !this.isVisible()) return
    if (!force && !this.hasActiveSubscribers(file) && !(initial && this.hasInterestedSubscribers(file))) return
    if (file.inFlight) {
      if (!force) {
        await file.inFlight
        if (initial && [...file.subscribers].some((subscriber) => subscriber.initializing)) {
          return this.pollFile(url, file, false, true)
        }
        return
      }
      await file.inFlight
      return this.pollFile(url, file, true)
    }
    if (!force && !initial && this.now() < file.nextPollAt) return

    const controller = new AbortController()
    file.controller = controller
    // Only a content-digest validator can prove a file unchanged. An owner that
    // offers anything else is polled unconditionally and its body compared by
    // fingerprint instead.
    const headers: Record<string, string> = {}
    if (file.etag && DIGEST_ETAG.test(file.etag)) headers['If-None-Match'] = file.etag

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
          file.failures = 0
          file.nextPollAt = this.now() + LIVE_FILE_POLL_INTERVAL_MS
          for (const subscriber of file.subscribers) {
            if (subscriber.active || subscriber.initializing) this.recover(subscriber)
          }
          return
        }
        if (!response.ok) throw new Error(`file request failed: ${response.status}`)

        const content = await response.text()
        if (this.files.get(url) !== file) return
        const fingerprint = contentFingerprint(content)
        file.etag = response.headers.get('etag')
        file.failures = 0
        file.nextPollAt = this.now() + LIVE_FILE_POLL_INTERVAL_MS
        const interested = [...file.subscribers].filter((subscriber) => subscriber.active || subscriber.initializing)
        if (fingerprint !== file.fingerprint) {
          file.fingerprint = fingerprint
          file.content = content
          for (const subscriber of interested) this.deliverContent(subscriber, content)
        }
        for (const subscriber of interested) {
          if (file.subscribers.has(subscriber)) this.recover(subscriber)
        }
      } catch (error) {
        if (this.files.get(url) !== file || controller.signal.aborted) return
        file.failures += 1
        file.nextPollAt = this.now() + Math.min(LIVE_FILE_POLL_INTERVAL_MS * 2 ** file.failures, MAX_ERROR_BACKOFF_MS)
        for (const subscriber of file.subscribers) {
          if (subscriber.active || subscriber.initializing) {
            subscriber.failed = true
            subscriber.onError?.(error)
          }
          subscriber.initializing = false
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

  private hasInterestedSubscribers(file: WatchedFile): boolean {
    return [...file.subscribers].some((subscriber) => subscriber.active || subscriber.initializing)
  }

  private recover(subscriber: FileSubscriber): void {
    if (!subscriber.failed) return
    subscriber.failed = false
    try {
      subscriber.onRecover?.()
    } catch {
      // One view's recovery callback must not interrupt another view.
    }
  }

  private deliverContent(subscriber: FileSubscriber, content: string): void {
    subscriber.initializing = false
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

/** A fast 128-bit fingerprint of a file body — what decides whether a 200
 *  actually changed anything a view shows. */
function contentFingerprint(content: string): string {
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

const liveFileRefresh = new LiveFileRefresh()

export function watchLiveFile(
  url: string,
  onContent: (content: string) => void,
  onError?: (error: unknown) => void,
  options: LiveFileWatchOptions = {},
): LiveFileSubscription {
  return liveFileRefresh.watch(url, onContent, onError, options)
}

export function liveFileWatched(url: string): boolean {
  return liveFileRefresh.watched(url)
}

export function refreshLiveFile(url: string): Promise<void> {
  return liveFileRefresh.refresh(url)
}
