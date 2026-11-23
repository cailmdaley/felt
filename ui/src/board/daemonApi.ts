/**
 * The board's helpers over the SDK's daemon client (`sdk/client.ts`), which
 * owns what a booting daemon, a refusal and an unreachable host read as on
 * every surface: `daemonFetch`, `DaemonBootingError`, `daemonErrorMessage`
 * and `responseError` are its, re-exported here for the board.
 */
import { daemonFetch, responseError } from '../sdk/client.js'

export { DaemonBootingError, daemonErrorMessage, daemonFetch, isDaemonBooting, responseError } from '../sdk/client.js'

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
  init?: Pick<RequestInit, 'signal'>,
): Promise<T> {
  const res = await daemonFetch(`${shuttleBase}${path}`, {
    ...init,
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
  feed: 'sessions' | 'sent-files/all',
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
