import { normalizeSentFiles, type SentFile } from '../sentFiles.js'

export interface SentFilesFeedOptions {
  shuttleBase: string
  uid: string
  session: string
  host?: string
  fetch?: typeof fetch
  onFiles(files: SentFile[]): void
}

/** Reads the current fiber's receipt trail from the host that ran this session. */
export class SentFilesFeed {
  private readonly shuttleBase: string
  private readonly uid: string
  private readonly session: string
  private readonly host?: string
  private readonly fetcher: typeof fetch
  private readonly onFiles: (files: SentFile[]) => void
  private etag: string | undefined
  private inFlight: Promise<boolean> | null = null
  private epoch = 0
  private disposed = false

  constructor(opts: SentFilesFeedOptions) {
    this.shuttleBase = opts.shuttleBase.replace(/\/$/, '')
    this.uid = opts.uid
    this.session = opts.session
    this.host = opts.host
    this.fetcher = opts.fetch ?? ((input, init) => fetch(input, init))
    this.onFiles = opts.onFiles
  }

  /** Read the latest receipts; returns true when a fresh list arrived. */
  read(): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false)
    if (this.inFlight) return this.inFlight
    const epoch = this.epoch
    let shared!: Promise<boolean>
    shared = this.readAt(epoch).finally(() => {
      if (this.inFlight === shared) this.inFlight = null
    })
    this.inFlight = shared
    return shared
  }

  dispose(): void {
    this.disposed = true
    this.epoch++
  }

  private async readAt(epoch: number): Promise<boolean> {
    const params = new URLSearchParams({ uid: this.uid, session: this.session })
    if (this.host) params.set('origin', this.host)
    const headers = this.etag ? { 'If-None-Match': this.etag } : undefined
    let response: Response
    try {
      response = await this.fetcher(`${this.shuttleBase}/api/v1/sent-files?${params}`, { cache: 'no-store', headers })
    } catch {
      return false
    }
    if (!this.active(epoch) || response.status === 304) return false
    if (!response.ok) return false

    try {
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) return false
      const rawFiles = (body as { files?: unknown }).files
      if (!Array.isArray(rawFiles)) return false
      if (!this.active(epoch)) return false
      this.etag = response.headers.get('ETag') ?? undefined
      this.onFiles(normalizeSentFiles(rawFiles))
      return true
    } catch {
      return false
    }
  }

  private active(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch
  }
}
