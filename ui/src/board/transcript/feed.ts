import type { MessageProvenance } from './messages.js'
import { normalizeRecord, type Entry } from './records.js'

export type StreamEnd = 'closed' | 'reset' | 'unsupported' | 'busy' | 'failed' | 'stopped'

export type FeedStatus = 'loading' | 'ready' | 'missing' | 'pending' | 'unreachable' | 'error'

export interface TranscriptFeedOptions {
  shuttleBase: string
  session: string
  host?: string
  fetch?: typeof fetch
  onEntries(entries: Entry[]): void
  onReplaceRecord?(record: number, entries: Entry[]): void
  onReset(): void
  onStatus(status: FeedStatus, detail?: string): void
}

const DECODE_CHUNK_BYTES = 64 * 1024
const TIME_SLICE_MS = 8
type EvidenceSnapshot = { value?: Promise<void>; deadline?: Promise<void>; deadlineAt?: number }
type CandidateRecord = { record: number; value: unknown; entries: Entry[]; emitted: boolean }
const PROVENANCE_WAIT_MS = 500

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function carrierText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map(part => typeof part === 'string' ? part : typeof object(part)?.text === 'string' ? object(part)!.text as string : '').filter(Boolean).join('\n')
}

function candidateMessageText(record: unknown): string {
  const value = object(record)
  const attachment = object(value?.attachment)
  const origin = object(attachment?.origin)
  if (value?.type === 'attachment' && attachment?.type === 'hook_additional_context') {
    return carrierText(attachment.content)
  }
  if (value?.type === 'attachment' && attachment?.type === 'queued_command'
      && (attachment.isMeta === true || origin?.kind === 'peer')) {
    return carrierText(attachment.prompt)
  }
  if (value?.type === 'user' && value.isMeta === true) {
    const message = object(value.message)
    return carrierText(message?.content)
  }
  if (value?.type === 'custom_message' && value.customType === 'shuttle') {
    return carrierText(value.content)
  }
  return ''
}

/** Incrementally reads and decodes a native JSONL transcript by byte offset. */
export class TranscriptFeed {
  private readonly shuttleBase: string
  private readonly session: string
  private readonly host?: string
  private readonly fetcher: typeof fetch
  private readonly onEntries: (entries: Entry[]) => void
  private readonly onReplaceRecord?: (record: number, entries: Entry[]) => void
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
  private provenance = new Map<string, MessageProvenance>()
  private provenanceCursor: string | null = null
  private provenanceRequest: Promise<void> | null = null
  private provenancePrefetched = false
  private provenanceRetryTimer: ReturnType<typeof setTimeout> | null = null
  private provenanceRetryDelay = 500
  private provenanceCandidates = new Set<string>()
  private provenanceGeneration = 0
  private candidateRecords = new Map<number, CandidateRecord>()
  private nextCandidateRecord = 0
  private provenanceNeeded = false

  constructor(opts: TranscriptFeedOptions) {
    this.shuttleBase = opts.shuttleBase.replace(/\/$/, '')
    this.session = opts.session
    this.host = opts.host
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init))
    this.onEntries = opts.onEntries
    this.onReplaceRecord = opts.onReplaceRecord
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
    if (!this.provenancePrefetched) {
      this.provenancePrefetched = true
      void this.ensureProvenance(true)
    } else if (this.provenanceNeeded) void this.ensureProvenance()

    const epoch = this.epoch
    let shared!: Promise<boolean>
    shared = this.readAt(epoch, false).finally(() => {
      if (this.inFlight === shared) this.inFlight = null
    })
    this.inFlight = shared
    return shared
  }

  /** Follow complete records from the last committed line boundary. */
  stream(): Promise<StreamEnd> {
    if (this.disposed || this.streamController) return Promise.resolve('stopped')
    return this.runStream()
  }

  private async runStream(): Promise<StreamEnd> {
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
      let scanFrom = 0
      const lineEnd = /[\r\n]/g
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
          lineEnd.lastIndex = scanFrom
          const match = lineEnd.exec(buffer)
          if (!match) { scanFrom = buffer.length; break }
          const i = match.index
          if (buffer[i] === '\r' && i === buffer.length - 1) { scanFrom = i; break }
          const line = buffer.slice(0, i)
          buffer = buffer.slice(i + (buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1))
          scanFrom = 0
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
              if (controller.signal.aborted) return 'stopped'
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
    if (this.provenanceRetryTimer !== null) clearTimeout(this.provenanceRetryTimer)
    this.provenanceRetryTimer = null
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
    const evidence: EvidenceSnapshot = {}
    for (let offset = 0; offset < bytes.byteLength; offset += DECODE_CHUNK_BYTES) {
      this.pendingLine += this.decoder.decode(bytes.subarray(offset, Math.min(bytes.byteLength, offset + DECODE_CHUNK_BYTES)), { stream: true })
      const lines = this.pendingLine.split('\n')
      this.pendingLine = lines.pop() ?? ''
      await this.emitLines(lines, epoch, slice, evidence)
      if (!this.active(epoch)) return
    }
  }

  private async loadProvenance(): Promise<number | null> {
    try {
      const query = this.provenanceCursor ? `&since=${encodeURIComponent(this.provenanceCursor)}` : ''
      const response = await this.fetcher(`${this.url('messages')}${query}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      const payload: unknown = response.ok ? await response.json() : null
      if (payload && typeof payload === 'object' && 'messages' in payload && Array.isArray(payload.messages)) {
        let added = 0
        for (const item of payload.messages) {
          if (item && typeof item.id === 'string' && typeof item.envelope === 'string' && !this.provenance.has(item.id)) {
            this.provenance.set(item.id, item as MessageProvenance)
            added++
          }
        }
        if ('cursor' in payload && typeof payload.cursor === 'string') this.provenanceCursor = payload.cursor
        return added
      }
    } catch { /* A missing or unreachable ledger leaves the native text intact. */ }
    return null
  }

  private async emitLines(lines: string[], epoch: number, slice = { started: now() }, evidence: EvidenceSnapshot = {}): Promise<void> {
    let batch: Entry[] = []
    let pendingCandidates: CandidateRecord[] = []
    const flush = (): void => {
      for (const record of pendingCandidates) {
        const entries = normalizeRecord(record.value, [...this.provenance.values()])
          .map(entry => ({ ...entry, sourceRecord: record.record }))
        if (JSON.stringify(entries) !== JSON.stringify(record.entries)) {
          const start = batch.findIndex(entry => entry.sourceRecord === record.record)
          if (start >= 0) {
            let end = start
            while (end < batch.length && batch[end].sourceRecord === record.record) end++
            batch.splice(start, end - start, ...entries)
          }
          record.entries = entries
        }
        record.emitted = true
      }
      if (batch.length) this.onEntries(batch)
      batch = []
      pendingCandidates = []
    }

    for (const line of lines) {
      if (line.trim()) {
        try {
          const value = JSON.parse(line) as unknown
          const candidateIds = [...candidateMessageText(value).matchAll(/\[Shuttle message ([^\s\]\r\n]+)/g)].map(match => match[1])
          let record: CandidateRecord | undefined
          if (candidateIds.length) {
            const unseen = candidateIds.some(id => !this.provenanceCandidates.has(id))
            for (const id of candidateIds) {
              if (!this.provenanceCandidates.has(id)) this.provenanceGeneration++
              this.provenanceCandidates.add(id)
            }
            if (unseen) this.provenanceNeeded = candidateIds.some(id => !this.provenance.has(id))
            if (unseen && this.provenanceRetryTimer !== null) {
              clearTimeout(this.provenanceRetryTimer)
              this.provenanceRetryTimer = null
              this.provenanceRetryDelay = 500
            }
            evidence.value ??= this.ensureProvenance(unseen)
            evidence.deadline ??= new Promise<void>(resolve => {
              evidence.deadlineAt = now() + PROVENANCE_WAIT_MS
              setTimeout(resolve, PROVENANCE_WAIT_MS)
            })
            record = { record: ++this.nextCandidateRecord, value, entries: [], emitted: false }
            this.candidateRecords.set(record.record, record)
            if (now() < (evidence.deadlineAt ?? 0)) await Promise.race([evidence.value, evidence.deadline])
          }
          const entries = normalizeRecord(value, [...this.provenance.values()])
            .map(entry => record ? { ...entry, sourceRecord: record.record } : entry)
          if (record) {
            record.entries = entries
            pendingCandidates.push(record)
          }
          batch.push(...entries)
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

  private ensureProvenance(force = false): Promise<void> {
    if (!force && !this.provenanceNeeded) return Promise.resolve()
    if (this.provenanceRequest) return this.provenanceRequest
    if (this.provenanceRetryTimer !== null) return Promise.resolve()
    const requestGeneration = this.provenanceGeneration
    this.provenanceRequest = this.loadProvenance().then(added => {
      this.provenanceRequest = null
      if (added !== null) {
        this.provenanceNeeded = false
        this.provenanceRetryDelay = 500
        if (this.provenanceRetryTimer !== null) {
          clearTimeout(this.provenanceRetryTimer)
          this.provenanceRetryTimer = null
        }
      } else {
        this.provenanceNeeded = this.provenanceCandidates.size > 0
        this.provenanceRetryDelay = Math.min(30_000, this.provenanceRetryDelay * 2)
        this.scheduleProvenanceRetry()
      }
      if (added !== null && added > 0) {
        for (const record of this.candidateRecords.values()) {
          if (!record.emitted) continue
          const ids = [...candidateMessageText(record.value).matchAll(/\[Shuttle message ([^\s\]\r\n]+)/g)].map(match => match[1])
          if (!ids.some(id => this.provenance.has(id))) continue
          const entries = normalizeRecord(record.value, [...this.provenance.values()])
            .map(entry => ({ ...entry, sourceRecord: record.record }))
          if (JSON.stringify(entries) !== JSON.stringify(record.entries)) {
            record.entries = entries
            this.onReplaceRecord?.(record.record, entries)
          }
        }
      }
      if (requestGeneration < this.provenanceGeneration
          && [...this.provenanceCandidates].some(id => !this.provenance.has(id))) {
        void this.ensureProvenance(true)
      }
    }).catch(() => {
      this.provenanceRequest = null
      this.provenanceNeeded = this.provenanceCandidates.size > 0
      this.provenanceRetryDelay = Math.min(30_000, this.provenanceRetryDelay * 2)
      this.scheduleProvenanceRetry()
      if (requestGeneration < this.provenanceGeneration) {
        if (this.provenanceRetryTimer !== null) {
          clearTimeout(this.provenanceRetryTimer)
          this.provenanceRetryTimer = null
        }
        void this.ensureProvenance(true)
      }
    })
    return this.provenanceRequest
  }

  private scheduleProvenanceRetry(): void {
    if (this.disposed || !this.provenanceNeeded || this.provenanceRetryTimer !== null) return
    this.provenanceRetryTimer = setTimeout(() => {
      this.provenanceRetryTimer = null
      void this.ensureProvenance()
    }, this.provenanceRetryDelay)
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
