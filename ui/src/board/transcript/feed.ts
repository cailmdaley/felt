import { normalizeRecord, type Entry } from './records.js'

export type StreamEnd = 'closed' | 'reset' | 'unsupported' | 'busy' | 'failed' | 'stopped'

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
  private lineOffset = 0
  private streamController: AbortController | null = null
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

  /** Follow complete records from the last committed line boundary. */
  async stream(): Promise<StreamEnd> {
    if (this.disposed || this.streamController) return 'stopped'
    const controller = new AbortController()
    this.streamController = controller
    const epoch = this.epoch
    this.offset = this.lineOffset
    this.pendingLine = ''
    this.decoder = new TextDecoder()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout>
    const arm = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => { timedOut = true; controller.abort() }, 45_000)
    }
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    arm()
    try {
      const response = await Promise.race([this.fetcher(this.url('stream'), {
        cache: 'no-store', signal: controller.signal, headers: { accept: 'text/event-stream' },
      }), aborted])
      if (!this.active(epoch) || controller.signal.aborted) return timedOut ? 'failed' : 'stopped'
      if (response.status === 501) return 'unsupported'
      if (response.status === 429) return 'busy'
      if (response.status === 416) {
        this.resetBytes()
        this.onReset()
        return 'reset'
      }
      if (response.status === 404) {
        const receipt = await Promise.race([response.json().catch(() => null), aborted]) as { availability?: unknown } | null
        if (!this.active(epoch) || controller.signal.aborted) return timedOut ? 'failed' : 'stopped'
        if (!receipt || !('availability' in receipt)) return 'unsupported'
        this.onStatus('missing')
        return 'failed'
      }
      if (response.status === 409) { this.onStatus('pending'); return 'failed' }
      if (response.status !== 200) return 'failed'
      if (!/^text\/event-stream(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) return 'unsupported'
      if (!response.body) return 'failed'
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let data: string[] = []
      let id = ''
      let event = ''
      while (true) {
        const part = await Promise.race([reader.read(), aborted])
        if (part.done) {
          if (!buffer.endsWith('\r')) return 'closed'
          buffer += '\n'
        } else {
          arm()
          buffer += decoder.decode(part.value, { stream: true })
        }
        while (true) {
          const match = /[\r\n]/.exec(buffer)
          if (!match) break
          const i = match.index
          if (buffer[i] === '\r' && i === buffer.length - 1) break
          const line = buffer.slice(0, i)
          buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1))
          if (!line) {
            if (event === 'error') return 'failed'
            if (event === 'reset') {
              this.resetBytes()
              this.onReset()
              return 'reset'
            }
            if (data.length) {
              if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < this.lineOffset) return 'failed'
              await this.emitLines(data, epoch)
              if (!this.active(epoch)) return 'stopped'
              this.offset = this.lineOffset = Number(id)
              this.onStatus('ready')
            }
            data = []; id = ''; event = ''
            if (controller.signal.aborted) return timedOut ? 'failed' : 'stopped'
          } else if (!line.startsWith(':')) {
            const colon = line.indexOf(':')
            const field = colon < 0 ? line : line.slice(0, colon)
            let value = colon < 0 ? '' : line.slice(colon + 1)
            if (value.startsWith(' ')) value = value.slice(1)
            if (field === 'data') data.push(value)
            else if (field === 'id') id = value
            else if (field === 'event') event = value
          }
        }
        if (part.done) return 'closed'
      }
    } catch {
      return controller.signal.aborted && !timedOut ? 'stopped' : 'failed'
    } finally {
      clearTimeout(timer!)
      if (reader) void reader.cancel().catch(() => {})
      if (this.streamController === controller) this.streamController = null
    }
  }

  stopStream(): void {
    this.streamController?.abort()
  }

  dispose(): void {
    this.stopStream()
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
    const lastNewline = body.lastIndexOf(0x0a)
    if (lastNewline >= 0) this.lineOffset = this.offset + lastNewline + 1
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
    const slice = { started: now() }
    for (let offset = 0; offset < bytes.byteLength; offset += DECODE_CHUNK_BYTES) {
      this.pendingLine += this.decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + DECODE_CHUNK_BYTES)), { stream: true })
      const lines = this.pendingLine.split('\n')
      this.pendingLine = lines.pop() ?? ''
      await this.emitLines(lines, epoch, slice)
      if (!this.active(epoch)) return
    }
  }

  private async emitLines(lines: string[], epoch: number, slice = { started: now() }): Promise<void> {
    let batch: Entry[] = []
    const flush = (): void => {
      if (batch.length) this.onEntries(batch)
      batch = []
    }

    for (const line of lines) {
      if (line.trim()) {
        try {
          batch.push(...normalizeRecord(JSON.parse(line) as unknown))
        } catch {
          // A malformed JSONL row does not prevent later records from being read.
        }
      }
      if (now() - slice.started >= TIME_SLICE_MS) {
        flush()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        if (!this.active(epoch)) return
        slice.started = now()
      }
    }
    flush()
  }

  private resetBytes(): void {
    this.offset = 0
    this.lineOffset = 0
    this.decoder = new TextDecoder()
    this.pendingLine = ''
  }

  private active(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch
  }

  private url(route = 'raw'): string {
    let url = `${this.shuttleBase}/api/v1/transcript/${route}?session=${encodeURIComponent(this.session)}&offset=${this.offset}`
    if (this.host) url += `&host=${encodeURIComponent(this.host)}`
    return url
  }
}
