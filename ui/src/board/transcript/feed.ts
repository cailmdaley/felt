import { normalizeRecord, type Entry } from './records.js'

export type FeedStatus = 'loading' | 'ready' | 'missing' | 'pending' | 'unreachable' | 'error'

export interface TranscriptFeedOptions {
  shuttleBase: string
  session: string
  host?: string
  fetch?: typeof fetch
  onEntries(entries: Entry[]): void
  onReset(): void
  onStatus(status: FeedStatus, detail?: string): void
}

const DECODE_CHUNK_BYTES = 64 * 1024
const TIME_SLICE_MS = 8

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

/** Incrementally reads and decodes a native JSONL transcript by byte offset. */
export class TranscriptFeed {
  private readonly shuttleBase: string
  private readonly session: string
  private readonly host?: string
  private readonly fetcher: typeof fetch
  private readonly onEntries: (entries: Entry[]) => void
  private readonly onReset: () => void
  private readonly onStatus: (status: FeedStatus, detail?: string) => void
  private offset = 0
  private decoder = new TextDecoder()
  private pendingLine = ''
  private inFlight: Promise<boolean> | null = null
  private epoch = 0
  private started = false
  private disposed = false

  constructor(opts: TranscriptFeedOptions) {
    this.shuttleBase = opts.shuttleBase.replace(/\/$/, '')
    this.session = opts.session
    this.host = opts.host
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init))
    this.onEntries = opts.onEntries
    this.onReset = opts.onReset
    this.onStatus = opts.onStatus
  }

  /** Read whatever the file has grown by; resolves true when bytes arrived. */
  read(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.inFlight) return this.inFlight
    if (!this.started) {
      this.started = true
      this.onStatus('loading')
    }

    const epoch = this.epoch
    let shared!: Promise<boolean>
    shared = this.readAt(epoch, false).finally(() => {
      if (this.inFlight === shared) this.inFlight = null
    })
    this.inFlight = shared
    return shared
  }

  dispose(): void {
    this.disposed = true
    this.epoch++
  }

  private async readAt(epoch: number, retried416: boolean): Promise<boolean> {
    let response: Response
    try {
      response = await this.fetcher(this.url(), { cache: 'no-store' })
    } catch (error) {
      if (!this.active(epoch)) return false
      this.onStatus('error', error instanceof Error ? error.message : undefined)
      return false
    }
    if (!this.active(epoch)) return false

    if (response.status === 416 && !retried416) {
      this.resetBytes()
      this.onReset()
      return this.active(epoch) ? this.readAt(epoch, true) : false
    }
    if (response.status === 404) {
      this.onStatus('missing')
      return false
    }
    if (response.status === 409) {
      this.onStatus('pending')
      return false
    }
    if (response.status === 503) {
      const receipt = await response.json().catch(() => null) as { host?: unknown } | null
      if (!this.active(epoch)) return false
      this.onStatus('unreachable', typeof receipt?.host === 'string' ? receipt.host : undefined)
      return false
    }
    if (response.status !== 200) {
      this.onStatus('error', `HTTP ${response.status}`)
      return false
    }

    let bytes: ArrayBuffer
    try {
      bytes = await response.arrayBuffer()
    } catch (error) {
      if (!this.active(epoch)) return false
      this.onStatus('error', error instanceof Error ? error.message : undefined)
      return false
    }
    if (!this.active(epoch)) return false

    const body = new Uint8Array(bytes)
    if (this.offset > 0 && response.headers.get('x-transcript-offset') === null) {
      this.resetBytes()
      this.onReset()
      if (!this.active(epoch)) return false
    }
    this.offset += body.byteLength

    try {
      await this.decode(body, epoch)
    } catch (error) {
      if (!this.active(epoch)) return false
      this.onStatus('error', error instanceof Error ? error.message : undefined)
      return false
    }
    if (!this.active(epoch)) return false
    this.onStatus('ready')
    return body.byteLength > 0
  }

  private async decode(bytes: Uint8Array, epoch: number): Promise<void> {
    let batch: Entry[] = []
    let sliceStarted = now()
    const flush = (): void => {
      if (batch.length) this.onEntries(batch)
      batch = []
    }

    for (let offset = 0; offset < bytes.byteLength; offset += DECODE_CHUNK_BYTES) {
      const text = this.decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + DECODE_CHUNK_BYTES)), { stream: true })
      this.pendingLine += text
      let newline = this.pendingLine.indexOf('\n')
      while (newline >= 0) {
        const line = this.pendingLine.slice(0, newline)
        this.pendingLine = this.pendingLine.slice(newline + 1)
        if (line.trim()) {
          try {
            batch.push(...normalizeRecord(JSON.parse(line) as unknown))
          } catch {
            // A malformed JSONL row does not prevent later records from being read.
          }
        }
        if (now() - sliceStarted >= TIME_SLICE_MS) {
          flush()
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          if (!this.active(epoch)) return
          sliceStarted = now()
        }
        newline = this.pendingLine.indexOf('\n')
      }
      if (!this.active(epoch)) return
    }
    flush()
  }

  private resetBytes(): void {
    this.offset = 0
    this.decoder = new TextDecoder()
    this.pendingLine = ''
  }

  private active(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch
  }

  private url(): string {
    let url = `${this.shuttleBase}/api/v1/transcript/raw?session=${encodeURIComponent(this.session)}&offset=${this.offset}`
    if (this.host) url += `&host=${encodeURIComponent(this.host)}`
    return url
  }
}
