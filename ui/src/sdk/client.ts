/**
 * The one client for the daemon's core API: every JSON read and write goes
 * through here, so a booting daemon, a refusal and an unreachable host read
 * the same on every surface that builds on it.
 *
 * A boot 503 is a distinct state (`DaemonBootingError`), not a payload for a
 * caller to render. A refusal carries the daemon's own words. Writes that act
 * on a fiber are owner-routed by `origin`, the composite row's owner.
 */
import type {
  ShuttleCaptureRequest, ShuttleCompositeResponse, ShuttleCreatedFiber, ShuttleCreateFiberRequest,
  ShuttleDeliverRequest, ShuttleDispatchRequest, ShuttleFiber, ShuttleFiberEnvelope, ShuttleFleetResponse,
  ShuttleInboxRequest, ShuttleKillResult, ShuttleLifecycleRequest, ShuttleMessageReceipt, ShuttleMessageRequest, ShuttleOffer, ShuttlePeerDirectory,
  ShuttleSentFile, ShuttleVersion,
} from './types.js'

export class DaemonBootingError extends Error {
  readonly status = 503

  constructor() {
    super('Daemon is starting…')
    this.name = 'DaemonBootingError'
  }
}

/**
 * `fetch`, with a booting daemon's 503 thrown as {@link DaemonBootingError}.
 * Any other answer is returned for the caller to read. Reads keep the
 * browser's default cache mode: the daemon answers with `ETag` and
 * `Cache-Control: no-cache`, so an unchanged feed costs a 304 revalidation.
 */
export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit, fetcher: typeof fetch = globalThis.fetch): Promise<Response> {
  const response = await fetcher(input, init)
  if (response.status === 503 && typeof response.clone === 'function') {
    try {
      const body: unknown = await response.clone().json()
      if (isRecord(body) && body.error === 'booting') throw new DaemonBootingError()
    } catch (error) {
      if (error instanceof DaemonBootingError) throw error
    }
  }
  return response
}

export function isDaemonBooting(error: unknown): error is DaemonBootingError {
  return error instanceof DaemonBootingError
}

/**
 * A failed daemon request as a sentence.
 *
 * An unreachable daemon is detected by TYPE, not by reading the message: the
 * fetch spec says a transport failure rejects with a `TypeError` and says
 * nothing about the wording (Chrome writes "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource", WebKit "Load failed").
 * Anything else came from our own code and is already a sentence.
 */
export function daemonErrorMessage(error: unknown): string {
  if (error instanceof TypeError) return 'Couldn’t reach the Shuttle daemon (:4000).'
  return (error as { message?: string })?.message ?? String(error)
}

/**
 * The most descriptive message a refused response carries.
 *
 * Routes do not speak one error format: a forwarded CLI failure replies
 * `text/plain` with the CLI's stderr, a controller's own refusal replies JSON
 * `{error}` (or `{message}`). This reads the body once, prefers the JSON field,
 * falls back to the raw text, and only then to `<label> (HTTP <status>)`.
 */
export async function responseError(res: Response, label: string): Promise<string> {
  let body = ''
  try { body = (await res.text()).trim() } catch { /* body unreadable (network/stream error) */ }
  if (body) {
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        const parsed = JSON.parse(body) as { error?: unknown; message?: unknown }
        const field = parsed.error ?? parsed.message
        if (typeof field === 'string' && field.trim()) return field.trim()
      } catch { /* not JSON after all — use the raw text below */ }
    }
    return body
  }
  return `${label} (HTTP ${res.status})`
}

/** A refused request: the daemon's words, and the status it answered with. */
export class DaemonRequestError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'DaemonRequestError'
    this.status = status
  }
}

/** One read of the composite feed: the feed, or word that the copy held (`etag`) is still current. */
export type CompositeRead =
  | { notModified: false; response: ShuttleCompositeResponse; etag: string | null }
  | { notModified: true; etag: string }

export interface ShuttleClientOptions {
  /** The daemon's origin, `''` (the default) for a page the daemon serves itself. */
  base?: string
  /** The `fetch` to call; the global one by default. */
  fetch?: typeof fetch
}

type Query = Record<string, string | number | boolean | undefined>

/** A query string from the values that are set, with a leading `?`, or nothing. */
function queryString(query: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value))
  const text = params.toString()
  return text ? `?${text}` : ''
}

/** An absolute path's `path` parameter: `~` is encoded too, so a path under `~user` survives Markdown on the way. */
const encodePath = (abs: string): string => encodeURIComponent(abs).replace(/~/g, '%7E')

/** A fiber id's URL path: each segment encoded on its own, so a namespace id keeps its separators. */
const encodeId = (id: string): string => id.split('/').map(encodeURIComponent).join('/')

export class ShuttleClient {
  readonly base: string
  readonly #fetch: typeof fetch | undefined

  constructor(options: ShuttleClientOptions = {}) {
    this.base = (options.base ?? '').replace(/\/+$/, '')
    this.#fetch = options.fetch
  }

  /** The URL of an API route. */
  url(path: string, query?: Query): string {
    return `${this.base}/api/v1${path}${queryString(query)}`
  }

  #send(input: string, init?: RequestInit): Promise<Response> {
    return daemonFetch(input, init, this.#fetch ?? globalThis.fetch)
  }

  async #get<T>(path: string, query: Query | undefined, label: string): Promise<T> {
    const res = await this.#send(this.url(path, query))
    if (!res.ok) throw new DaemonRequestError(await responseError(res, label), res.status)
    return await res.json() as T
  }

  #postRaw(path: string, body: unknown, init: { signal?: AbortSignal } = {}): Promise<Response> {
    return this.#send(this.url(path), {
      ...init,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  async #post<T>(path: string, body: unknown, label: string): Promise<T> {
    const res = await this.#postRaw(path, body)
    if (!res.ok) throw new DaemonRequestError(await responseError(res, label), res.status)
    return await res.json().catch(() => undefined) as T
  }

  /** `GET /version`: the daemon's identity and readiness, or a remote's through `origin`. */
  version(origin?: string): Promise<ShuttleVersion> {
    return this.#get('/version', { origin }, 'Version unavailable')
  }

  /** `GET /contract`: the OpenAPI document of the stable routes. */
  contract(): Promise<Record<string, unknown>> {
    return this.#get('/contract', undefined, 'Contract unavailable')
  }

  /** `GET /fleet`: a host's configured and discovered remotes. */
  fleet(origin?: string): Promise<ShuttleFleetResponse> {
    return this.#get('/fleet', { origin }, 'Fleet unavailable')
  }

  /** `GET /peers`: addressable sessions, this host's alone with `local`. */
  peers(local?: boolean): Promise<ShuttlePeerDirectory> {
    return this.#get('/peers', { local: local ? 'true' : undefined }, 'Peers unavailable')
  }

  /**
   * `GET /fibers/composite`: every host's rows. Given the `etag` of the copy
   * held, an unchanged feed answers `{ notModified: true }` without a body.
   */
  async fibersComposite(options: { etag?: string | null; signal?: AbortSignal } = {}): Promise<CompositeRead> {
    const init: RequestInit = { signal: options.signal }
    if (options.etag) {
      init.headers = { 'If-None-Match': options.etag }
      // The browser's cache would answer a 304 with its stored 200; ask the daemon itself.
      init.cache = 'no-store'
    }
    const res = await this.#send(this.url('/fibers/composite'), init)
    if (res.status === 304 && options.etag) return { notModified: true, etag: options.etag }
    if (!res.ok) throw new DaemonRequestError(await responseError(res, 'Feed unavailable'), res.status)
    return { notModified: false, response: await res.json() as ShuttleCompositeResponse, etag: res.headers.get('ETag') }
  }

  /** `GET /fibers/{id}`: one fiber, with its body, read from its owner. */
  fiber(id: string, origin?: string): Promise<ShuttleFiberEnvelope> {
    return this.#get(`/fibers/${encodeId(id)}`, { body: 'true', origin }, 'Fiber unavailable')
  }

  /** `GET /sent-files`: the files a fiber's workers sent, newest first. */
  async sentFiles(uid: string, origin?: string): Promise<ShuttleSentFile[]> {
    const answer = await this.#get<{ files?: ShuttleSentFile[] }>('/sent-files', { uid, origin }, 'Sent files unavailable')
    return answer.files ?? []
  }

  /** The URL of a file's bytes on its owner (`GET /file`). */
  fileUrl(path: string, origin?: string): string {
    const abs = path.startsWith('/') ? path : `/${path}`
    const url = `${this.base}/api/v1/file?path=${encodePath(abs)}`
    return origin && origin !== 'local' ? `${url}&origin=${encodeURIComponent(origin)}` : url
  }

  /** `GET /file`: a file's text on its owner. */
  async fileText(path: string, origin?: string): Promise<string> {
    const res = await this.#send(this.fileUrl(path, origin))
    if (!res.ok) throw new DaemonRequestError(await responseError(res, 'File unavailable'), res.status)
    return await res.text()
  }

  /**
   * The URL of a file's bytes on its owner under a path-shaped address
   * (`GET /file-assets/{origin}/{path}`), from which a page's relative figures,
   * styles and scripts resolve.
   */
  htmlAssetUrl(path: string, origin?: string): string {
    const abs = path.startsWith('/') ? path : `/${path}`
    return `${this.base}/api/v1/file-assets/${encodeURIComponent(origin || 'local')}${encodeId(abs)}`
  }

  /** The address of a thread's page, which every daemon serves. */
  threadPageUrl(uid: string, host: string): string {
    return `${this.base}/thread?f=${encodeURIComponent(uid)}@${encodeURIComponent(host)}`
  }

  /** `POST /fiber/create`. */
  createFiber(request: ShuttleCreateFiberRequest): Promise<ShuttleCreatedFiber> {
    return this.#post('/fiber/create', request, 'Create failed')
  }

  /** `POST /capture`: launch an agent from a prompt. */
  capture(request: ShuttleCaptureRequest): Promise<Record<string, unknown>> {
    return this.#post('/capture', request, 'Capture failed')
  }

  /** `POST /dispatch`: launch or resume a fiber's worker, optionally with the human's message. */
  dispatch(request: ShuttleDispatchRequest): Promise<Record<string, unknown>> {
    return this.#post('/dispatch', request, 'Send failed')
  }

  /** `POST /deliver`: put text in front of a fiber's worker. */
  deliver(request: ShuttleDeliverRequest): Promise<Record<string, unknown>> {
    return this.#post('/deliver', request, 'Delivery failed')
  }

  /**
   * `POST /messages`: an idempotent message to one exact session. Resolves with
   * the receipt whenever the daemon gave one, a refused or unconfirmed
   * message's included: read its `status`. Anything else the daemon refuses throws.
   */
  async messages(request: ShuttleMessageRequest, init?: { signal?: AbortSignal }): Promise<ShuttleMessageReceipt> {
    const res = await this.#postRaw('/messages', request, init)
    const answer: unknown = await res.clone().json().catch(() => undefined)
    if (isRecord(answer) && typeof answer.status === 'string' && typeof answer.message_id === 'string') return answer as unknown as ShuttleMessageReceipt
    throw new DaemonRequestError(await responseError(res, 'Message failed'), res.status)
  }

  /** `POST /lifecycle`: one lifecycle verb on a fiber. */
  lifecycle(request: ShuttleLifecycleRequest): Promise<Record<string, unknown> | undefined> {
    return this.#post('/lifecycle', request, `${request.action} failed`)
  }

  /** `POST /kill`: stop a fiber's live worker. */
  kill(fiberId: string, origin?: string): Promise<ShuttleKillResult> {
    return this.#post('/kill', { fiber_id: fiberId, ...(origin ? { origin } : {}) }, 'Stop failed')
  }

  /** `POST /inbox`: list or cancel the entries waiting for a fiber's worker. */
  inbox(request: ShuttleInboxRequest): Promise<Record<string, unknown>> {
    return this.#post('/inbox', request, 'Inbox unavailable')
  }

  /** Take one offered verb on a fiber: its `/lifecycle` request, or `/kill`. */
  act(fiber: ShuttleFiber, offer: ShuttleOffer): Promise<unknown> {
    if (offer.verb === 'kill' || !offer.request) return this.kill(fiber.fiber.id, fiber.origin)
    return this.lifecycle({ ...offer.request, fiber: fiber.fiber.id, origin: fiber.origin })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
