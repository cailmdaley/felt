import { clockTime } from '../civilDay.js'
import { getDaemonJson } from '../daemonApi.js'

/** A session's latest usage, from `GET /api/v1/transcript/usage`. Times are epoch milliseconds. */
export interface TranscriptUsage {
  context?: number
  window?: number
  cached?: number
  cache_warm_until?: number
  cache_ttl?: number
  hit_share?: number
  at?: number
}

/** The session's usage, or null when its host has none to report or cannot be reached. */
export async function fetchTranscriptUsage(shuttleBase: string, session: string, host: string | undefined): Promise<TranscriptUsage | null> {
  const query = new URLSearchParams({ session, ...(host ? { host } : {}) })
  try {
    return await getDaemonJson<TranscriptUsage>(`${shuttleBase}/api/v1/transcript/usage?${query}`)
  } catch {
    return null
  }
}

/** Compact token counts: a decimal only below 100k, where it still says something. */
export function tokenLabel(tokens: number): string {
  if (tokens >= 999_500) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 100_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}k`
  return String(tokens)
}

/** When the cache stays warm until, while the estimate says it still is. */
export function warmUntil(usage: TranscriptUsage | null): number | undefined {
  const until = usage?.cache_warm_until
  return until !== undefined && until > Date.now() ? until : undefined
}

/**
 * The window a session's context is read against. Claude transcripts record
 * none; Claude sessions run with a million-token window.
 */
function contextWindow(recorded: number | undefined, agent: string | undefined): number | undefined {
  return recorded || (agent?.startsWith('claude') ? 1_000_000 : undefined)
}

/**
 * Paint the session's usage: context as its token count, tinted from verdigris
 * toward red as it fills the window; the cache as a verdigris dot draining as
 * the entry ages, an alarm-red ring once cold.
 */
export function paintUsage(context: HTMLElement, cache: HTMLElement, usage: TranscriptUsage | null, agent: string | undefined): void {
  const count = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  const tokens = usage?.context
  const window_ = tokens === undefined ? undefined : contextWindow(usage?.window, agent)
  const share = tokens !== undefined && window_ ? Math.round(Math.min(1, tokens / window_) * 100) : undefined
  context.hidden = tokens === undefined
  context.textContent = tokens === undefined ? '' : tokenLabel(tokens)
  context.title = tokens === undefined ? '' : `Context: ${count(tokens)} tokens${window_ ? ` of a ${count(window_)}-token window (${share}% full)` : ''}`
  if (share === undefined) context.style.removeProperty('color')
  else context.style.color = `color-mix(in oklch, var(--kbn-alarm) ${share}%, var(--kbn-tempered))`

  const until = usage?.cache_warm_until
  const now = Date.now()
  const warm = until !== undefined && until > now
  const said = until === undefined ? '' : warm ? `Cache warm until ${clockTime(until)}` : `Cache cold since ${clockTime(until)}`
  cache.hidden = until === undefined
  cache.dataset.cache = until === undefined ? '' : warm ? 'warm' : 'cold'
  cache.title = until === undefined ? '' : `${said} (estimated from Claude cache usage)`
  cache.setAttribute('aria-label', said)
  cache.style.setProperty('--ws-cache-left', warm ? String(Math.min(1, (until - now) / (usage?.cache_ttl ?? 300_000))) : '0')
}
