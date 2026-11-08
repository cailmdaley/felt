/**
 * The board's one client for the daemon API: every JSON read and write goes
 * through here, so a booting daemon, a refusal and an unreachable host read
 * the same on every surface.
 *
 * A boot 503 is a distinct state, not a JSON payload for a caller to render or
 * a generic request failure. A refusal carries the daemon's own words. Reads
 * keep the browser's default cache mode: the daemon answers with `ETag` and
 * `Cache-Control: no-cache`, so the browser revalidates its stored copy and an
 * unchanged feed costs a 304 instead of a transfer.
 */
export class DaemonBootingError extends Error {
  readonly status = 503

  constructor() {
    super('Daemon is starting…')
    this.name = 'DaemonBootingError'
  }
}

export async function daemonFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init)

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
 * An unreachable daemon is detected by TYPE, not by reading the message. The
 * fetch spec says a transport failure rejects with a `TypeError` and says
 * nothing about the wording: Chrome writes "Failed to fetch", Firefox
 * "NetworkError when attempting to fetch resource", and WebKit — the phone —
 * writes "Load failed". Anything that is not a TypeError came from our own
 * code and is already a sentence, so it is passed through.
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

/** GET a JSON route, throwing the daemon's own message on a non-2xx. */
export async function getDaemonJson<T = unknown>(url: string, label = 'Request failed', init?: RequestInit): Promise<T> {
  const res = await daemonFetch(url, init)
  if (!res.ok) throw new Error(await responseError(res, label))
  return await res.json() as T
}

/**
 * POST one JSON body to a daemon route, throwing the daemon's own message on a
 * non-2xx and returning its JSON answer (undefined for an empty one). Write
 * routes are owner-routed by the `origin` field in the body, so the board can
 * drive a fiber whose owning host is not this one.
 */
export async function postDaemonJson<T = unknown>(
  shuttleBase: string,
  path: string,
  body: unknown,
  label = 'Request failed',
): Promise<T> {
  const res = await daemonFetch(`${shuttleBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await responseError(res, label))
  return await res.json().catch(() => undefined) as T
}

/**
 * One cross-host composite feed: `GET /api/v1/<feed>/composite?<query>`.
 * Throws on any failure; each reader decides what a failed read leaves drawn.
 */
export function readComposite(
  shuttleBase: string,
  feed: 'activity' | 'sessions' | 'commits' | 'sent-files/all',
  query: Record<string, number | string>,
): Promise<unknown> {
  const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, typeof value === 'number' ? String(Math.floor(value)) : value]))
  return getDaemonJson(`${shuttleBase}/api/v1/${feed}/composite?${params}`, `${feed} feed unavailable`)
}

/**
 * The start of a trailing window, floored to `quantumMs`. A window that
 * slides with the clock would name a new URL, and so a new validator, on every
 * read; a quantized start keeps one URL between steps, so a re-read of an
 * unchanged feed revalidates to a 304.
 */
export function windowStart(nowMs: number, windowMs: number, quantumMs = 3_600_000): number {
  return Math.max(0, Math.floor((nowMs - windowMs) / quantumMs) * quantumMs)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
