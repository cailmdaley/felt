import { inLane } from './requestLanes.js'
import { normalizeAbsolutePath } from './workspace/documents.js'

/**
 * The document cache: the one reader of document content. Every surface that
 * shows a document or something derived from it (a page, a thumbnail, a
 * title, a duration, a waveform) asks here, and only this module talks to the
 * daemon's `/file` and `/file-info` routes for content. Native viewers
 * (`<img>`, `<audio>`, a PDF frame) stream their own bytes by URL.
 *
 * - **Keyed by document,** `owner:normalised path` whatever URL spelling a
 *   caller holds, with a validator beside each answer: the ETag, else the
 *   owner's mtime and size.
 * - **Four answers:** `head` (existence, size, mtime), `peek` (the first
 *   64 KiB), `text` (the whole body) and `bytes` (a whole binary body, read for
 *   a derivation and not kept).
 * - **One read per question:** concurrent askers share a request in flight,
 *   and a settled answer stands for `RESOURCE_FRESH_MS`. After that it
 *   revalidates with `If-None-Match`, so an unchanged document costs a
 *   bodyless 304.
 * - **Ordered by what it serves:** the selected page reads in the foreground;
 *   everything else waits in the quiet request lane, ranked neighbours, titles,
 *   thumbnails, durations, so background reads never hold more than the lane's
 *   connections. A background read that has not answered within
 *   `RESOURCE_DEADLINE_MS` gives up its slot.
 * - **Derived facts once per validator:** `fact` memoises a computation over
 *   a document's bytes under the validator it was computed from.
 */
export const PEEK_BYTES = 65536
/** What a read serves, most urgent first. */
export const RESOURCE_PRIORITY = { selected: 0, neighbour: 1, title: 2, thumbnail: 3, duration: 4 } as const
export type ResourcePriority = typeof RESOURCE_PRIORITY[keyof typeof RESOURCE_PRIORITY]
/** A background read that has not answered by then gives up its lane slot. */
export const RESOURCE_DEADLINE_MS = 15_000
/** A settled answer is served again for this long before it revalidates. */
export const RESOURCE_FRESH_MS = 30_000

export interface Head { exists: boolean; size?: number; modifiedAt?: string; validator?: string }
export interface Peek { bytes: Uint8Array; etag?: string; size?: number }
export interface TextBody { text: string; etag?: string }
/** A whole-body read the live poller drives; `rank` is what it serves. */
export type DocumentFetch = (url: string, init: RequestInit & { rank?: ResourcePriority }) => Promise<Response>

type Held<T> = { value: T; at: number }
interface Entry {
  src: string
  head?: Held<Head>
  peek?: Held<Peek>
  text?: Held<TextBody>
  /** When the owner last said the document does not exist; a missing document is an answer too. */
  missing?: number
  facts: Map<string, { validator: string; value: Promise<unknown> }>
}

const ENTRY_LIMIT = 600
/** Whole bodies stay after their readers leave, up to this many characters in all. */
const TEXT_BUDGET = 24 * 1024 * 1024
const FACT_LIMIT = 8
/**
 * A read in flight. A more urgent asker moves it up the queue while it still
 * waits; it is cancelled once every asker that can abandon it has.
 */
interface Pending { promise: Promise<unknown>; join: (priority: ResourcePriority, asker?: AbortSignal) => void }
const entries = new Map<string, Entry>()
const inFlight = new Map<string, Pending>()
let textHeld = 0

/**
 * A document's identity in the cache, `owner:/normalised/path`, from a `/file`,
 * `/file-info` or `/file-assets` URL. A URL that names no document is its own key.
 */
export function resourceKey(src: string): string {
  let url: URL
  try { url = new URL(src, 'http://resource.invalid') } catch { return src }
  const asset = /\/api\/v1\/file-assets\/([^/]+)(\/.*)$/.exec(url.pathname)
  if (asset) return `${decodeURIComponent(asset[1])}:${normalizeAbsolutePath(decodeURIComponent(asset[2]))}`
  const path = url.searchParams.get('path')
  if (!/\/file(?:-info)?$/.test(url.pathname) || !path) return src
  return `${url.searchParams.get('origin') || 'local'}:${normalizeAbsolutePath(path)}`
}

/** The `/file` URL a document's bytes come from, from any URL naming it. */
function bytesUrl(src: string): string {
  const asset = /^(.*)\/api\/v1\/file-assets\/([^/?#]+)(\/[^?#]*)/.exec(src)
  if (!asset) return src.replace(/\/file-info\?/, '/file?')
  const owner = decodeURIComponent(asset[2])
  const path = encodeURIComponent(decodeURIComponent(asset[3])).replace(/~/g, '%7E')
  return `${asset[1]}/api/v1/file?path=${path}${owner === 'local' ? '' : `&origin=${encodeURIComponent(owner)}`}`
}

function entryFor(src: string): Entry {
  const key = resourceKey(src)
  let entry = entries.get(key)
  if (entry) { entries.delete(key); entries.set(key, entry); return entry }
  entry = { src: bytesUrl(src), facts: new Map() }
  entries.set(key, entry)
  while (entries.size > ENTRY_LIMIT) {
    const oldest = entries.keys().next().value!
    if (entries.get(oldest)?.text) textHeld -= entries.get(oldest)!.text!.value.text.length
    entries.delete(oldest)
  }
  return entry
}

function holdText(entry: Entry, body: TextBody): void {
  if (entry.text) textHeld -= entry.text.value.text.length
  entry.text = { value: body, at: Date.now() }
  textHeld += body.text.length
  // The least recently asked bodies go first; their heads, peeks and facts stay.
  for (const other of entries.values()) {
    if (textHeld <= TEXT_BUDGET) break
    if (other === entry || !other.text) continue
    textHeld -= other.text.value.text.length
    other.text = undefined
  }
}

const isFresh = (held: Held<unknown> | undefined, now = Date.now()): boolean => !!held && now - held.at < RESOURCE_FRESH_MS
const knownMissing = (entry: Entry, now = Date.now()): boolean => entry.missing !== undefined && now - entry.missing < RESOURCE_FRESH_MS

/** The selected page reads now; every other read waits its turn in the quiet lane. */
export function queued<T>(priority: ResourcePriority, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (priority === RESOURCE_PRIORITY.selected) return signal?.aborted ? Promise.reject(signal.reason) : work()
  return inLane('quiet', work, { rank: priority, signal })
}

/**
 * One read per question, queued at `priority`: a second asker joins the
 * first, a more urgent one moves a read that has not started up the queue,
 * and the read is cancelled when every asker holding a signal has aborted
 * and none came without one.
 */
function shared<T>(id: string, priority: ResourcePriority, work: (signal: AbortSignal) => Promise<T>, asker?: AbortSignal): Promise<T> {
  const pending = inFlight.get(id)
  if (pending) { pending.join(priority, asker); return pending.promise as Promise<T> }
  let settle!: (outcome: T | Promise<T>) => void
  const promise = new Promise<T>(resolve => { settle = resolve })
  const cancelled = new AbortController()
  let started = false
  let rank = priority
  let waiting = new AbortController()
  let kept = false
  let askers = 0
  const run = (): void => {
    const own = waiting
    queued(rank, () => { started = true; return work(cancelled.signal) }, own.signal)
      .then(settle, error => { if (!own.signal.aborted || cancelled.signal.aborted) settle(Promise.reject(error)) })
  }
  const entry: Pending = {
    promise,
    join: (next, signal) => {
      if (!signal) kept = true
      else if (!signal.aborted) {
        askers++
        signal.addEventListener('abort', () => {
          if (--askers > 0 || kept) return
          if (inFlight.get(id) === entry) inFlight.delete(id)
          cancelled.abort(signal.reason)
          waiting.abort(signal.reason)
        }, { once: true })
      }
      if (started || next >= rank) return
      rank = next
      waiting.abort()
      waiting = new AbortController()
      run()
    },
  }
  inFlight.set(id, entry)
  void promise.catch(() => {}).finally(() => { if (inFlight.get(id) === entry) inFlight.delete(id) })
  entry.join(priority, asker)
  run()
  return promise
}

/** Abort when the caller does, or when `ms` passes before `answered` is called. */
function deadline(signal: AbortSignal | null | undefined, ms: number | null): { signal: AbortSignal; answered: () => void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timer = ms === null ? undefined : setTimeout(() => controller.abort(new DOMException('The owner did not answer in time', 'TimeoutError')), ms)
  return { signal: controller.signal, answered: () => clearTimeout(timer) }
}

const etagOf = (response: Response): string | undefined => response.headers.get('ETag') ?? undefined

/**
 * Whether a document exists, with its size and modification time, from the
 * owner's metadata route. Null when the owner cannot answer.
 */
export function head(src: string, priority: ResourcePriority = RESOURCE_PRIORITY.title, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<Head | null> {
  const entry = entryFor(src)
  if (!options.fresh && isFresh(entry.head)) return Promise.resolve(entry.head!.value)
  return shared(`head\0${resourceKey(src)}`, priority, async signal => {
    const limit = deadline(signal, RESOURCE_DEADLINE_MS)
    try {
      const response = await fetch(entry.src.replace(/\/file\?/, '/file-info?'), { cache: 'no-store', signal: limit.signal })
      if (!response.ok) return null
      const info = await response.json() as { exists?: boolean; size?: unknown; modified_at?: unknown }
      const time = typeof info.modified_at === 'number' ? info.modified_at * 1000 : typeof info.modified_at === 'string' ? Date.parse(info.modified_at) : NaN
      const size = typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : undefined
      const modifiedAt = Number.isFinite(time) ? new Date(time).toISOString() : undefined
      const value: Head = !info.exists ? { exists: false }
        : { exists: true, size, modifiedAt, validator: modifiedAt !== undefined && size !== undefined ? `${modifiedAt}|${size}` : undefined }
      entry.head = { value, at: Date.now() }
      entry.missing = value.exists ? undefined : entry.head.at
      return value
    } finally { limit.answered() }
  }, options.signal).catch(() => null)
}

/**
 * The first 64 KiB of a document, for titles, previews and audio metadata.
 * A fresh whole body answers without a request. Null when the document
 * cannot be read.
 */
export function peek(src: string, priority: ResourcePriority = RESOURCE_PRIORITY.title, options: { fresh?: boolean; now?: number; signal?: AbortSignal } = {}): Promise<Peek | null> {
  const entry = entryFor(src)
  const now = options.now ?? Date.now()
  if (!options.fresh) {
    if (knownMissing(entry, now)) return Promise.resolve(null)
    if (isFresh(entry.peek, now)) return Promise.resolve(entry.peek!.value)
    if (isFresh(entry.text, now)) return Promise.resolve(peekOfText(entry))
  }
  return shared(`peek\0${resourceKey(src)}`, priority, signal => readPeek(entry, signal), options.signal).catch(() => null)
}

function peekOfText(entry: Entry): Peek {
  const body = entry.text!.value
  const encoded = new TextEncoder().encode(body.text.slice(0, PEEK_BYTES))
  const value = { bytes: encoded.subarray(0, PEEK_BYTES), etag: body.etag, size: body.text.length <= PEEK_BYTES / 4 ? encoded.length : undefined }
  entry.peek = { value, at: entry.text!.at }
  return value
}

/** Native viewers own their byte streams; a peek stops after 64 KiB even if Range is ignored. */
async function readPeek(entry: Entry, signal: AbortSignal): Promise<Peek | null> {
  const known = entry.peek?.value.etag ?? entry.text?.value.etag
  const headers: Record<string, string> = { Range: `bytes=0-${PEEK_BYTES - 1}` }
  if (known) headers['If-None-Match'] = known
  const limit = deadline(signal, RESOURCE_DEADLINE_MS)
  try {
    const response = await fetch(entry.src, { cache: 'no-store', headers, signal: limit.signal })
    if (response.status === 304) {
      if (entry.peek && entry.peek.value.etag === known) { entry.peek.at = Date.now(); return entry.peek.value }
      if (entry.text && entry.text.value.etag === known) { entry.text.at = Date.now(); return peekOfText(entry) }
      return null
    }
    if (response.status === 404) entry.missing = Date.now()
    if (!response.ok || !response.body) return null
    entry.missing = undefined
    const reader = response.body.getReader()
    const out = new Uint8Array(PEEK_BYTES)
    let length = 0
    try {
      while (length < out.length) {
        const chunk = await reader.read()
        if (chunk.done) break
        const part = chunk.value.subarray(0, out.length - length)
        out.set(part, length); length += part.length
      }
    } finally { await reader.cancel() }
    const total = /\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')?.[1] ?? (response.status === 200 ? response.headers.get('Content-Length') : null)
    const value: Peek = { bytes: out.subarray(0, length), etag: etagOf(response), size: total ? Number(total) : undefined }
    entry.peek = { value, at: Date.now() }
    return value
  } finally { limit.answered() }
}

/**
 * One whole-body read, conditional when the caller sends `If-None-Match`. A
 * 200 is held as the document's text and a 304 confirms the text held. The
 * live poller reads through this; a reader asking `text` meanwhile joins it.
 */
export const fetchDocument: DocumentFetch = (url, init) => {
  const entry = entryFor(url)
  const priority = init.rank ?? RESOURCE_PRIORITY.selected
  const read = queued(priority, () => readWhole(entry, init, priority), init.signal ?? undefined)
  const id = `text\0${resourceKey(url)}`
  if (!inFlight.has(id)) {
    const joined: Pending = { promise: read.then(() => entry.text?.value ?? null, () => null), join: () => {} }
    inFlight.set(id, joined)
    void joined.promise.finally(() => { if (inFlight.get(id) === joined) inFlight.delete(id) })
  }
  return read
}

async function readWhole(entry: Entry, init: RequestInit, priority: ResourcePriority): Promise<Response> {
  const etag = ifNoneMatch(init.headers)
  // A selected body may be large and slow; a background read is held to the deadline until it answers.
  const limit = deadline(init.signal, priority === RESOURCE_PRIORITY.selected ? null : RESOURCE_DEADLINE_MS)
  let response: Response
  try { response = await fetch(entry.src, { ...init, signal: limit.signal }) } finally { limit.answered() }
  if (response.status === 304) {
    if (entry.text && entry.text.value.etag === etag) entry.text.at = Date.now()
    return response
  }
  if (response.status === 404) entry.missing = Date.now()
  if (response.ok) { entry.missing = undefined; holdText(entry, { text: await response.clone().text(), etag: etagOf(response) }) }
  return response
}

function ifNoneMatch(headers: HeadersInit | undefined): string | undefined {
  if (!headers) return undefined
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get('If-None-Match') ?? undefined
  const pairs = Array.isArray(headers) ? headers : Object.entries(headers)
  return pairs.find(([name]) => name.toLowerCase() === 'if-none-match')?.[1]
}

/**
 * A document's whole text for a reader that wants it once, such as a
 * thumbnail. Fresh text answers at once; older text revalidates. Null when
 * the document cannot be read.
 */
export function text(src: string, priority: ResourcePriority = RESOURCE_PRIORITY.thumbnail, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<TextBody | null> {
  const entry = entryFor(src)
  if (!options.fresh && knownMissing(entry)) return Promise.resolve(null)
  if (!options.fresh && isFresh(entry.text)) return Promise.resolve(entry.text!.value)
  return shared(`text\0${resourceKey(src)}`, priority, async signal => {
    const etag = entry.text?.value.etag
    const response = await readWhole(entry, { cache: 'no-store', signal, headers: etag ? { 'If-None-Match': etag } : undefined }, priority)
    return response.ok || response.status === 304 ? entry.text?.value ?? null : null
  }, options.signal).catch(() => null)
}

/** The text held for a document, however old, without a request. */
export function recallText(src: string): TextBody | undefined {
  return entries.get(resourceKey(src))?.text?.value
}

/**
 * A document's whole bytes, at most `maxBytes`, for a derivation such as a
 * waveform. The bytes are not held; the derived fact is. Null when the
 * document cannot be read or is larger than `maxBytes`.
 */
export function bytes(src: string, priority: ResourcePriority, options: { maxBytes: number; signal?: AbortSignal }): Promise<ArrayBuffer | null> {
  const entry = entryFor(src)
  return shared(`bytes\0${resourceKey(src)}`, priority, async signal => {
    const limit = deadline(signal, priority === RESOURCE_PRIORITY.selected ? null : RESOURCE_DEADLINE_MS)
    let response: Response
    try { response = await fetch(entry.src, { signal: limit.signal }) } finally { limit.answered() }
    if (!response.ok) return null
    return boundedBytes(response, options.maxBytes)
  }, options.signal).catch(() => null)
}

async function boundedBytes(response: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  if (Number(response.headers.get('Content-Length')) > maxBytes) return null
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) return null
      chunks.push(value)
    }
  } finally { await reader.cancel(); reader.releaseLock() }
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out.buffer
}

/**
 * A fact derived from a document, computed once per validator and kept beside
 * its bytes. A computation that yields null is not kept, so a later ask tries
 * again.
 */
export function fact<T>(src: string, name: string, validator: string, compute: () => Promise<T | null>): Promise<T | null> {
  const entry = entryFor(src)
  const held = entry.facts.get(name)
  if (held?.validator === validator) return held.value as Promise<T | null>
  const value = compute().catch(() => null)
  entry.facts.delete(name)
  entry.facts.set(name, { validator, value })
  while (entry.facts.size > FACT_LIMIT) entry.facts.delete(entry.facts.keys().next().value!)
  void value.then(result => { if (result === null && entry.facts.get(name)?.value === value) entry.facts.delete(name) })
  return value
}

/** A fact already computed under `validator`, without computing it. */
export function knownFact<T>(src: string, name: string, validator: string): Promise<T | null> | undefined {
  const held = entries.get(resourceKey(src))?.facts.get(name)
  return held?.validator === validator ? held.value as Promise<T | null> : undefined
}

/** Test support. */
export function resetDocumentResources(): void {
  entries.clear(); inFlight.clear(); textHeld = 0
}
