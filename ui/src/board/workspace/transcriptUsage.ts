/** A session's latest usage, from `GET /api/v1/transcript/usage`. Times are epoch milliseconds. */
export interface TranscriptUsage {
  context?: number
  window?: number
  cached?: number
  cache_warm_until?: number
  hit_share?: number
  at?: number
}

/** The session's usage, or null when its host has none to report or cannot be reached. */
export async function fetchTranscriptUsage(shuttleBase: string, session: string, host: string | undefined): Promise<TranscriptUsage | null> {
  const query = new URLSearchParams({ session, ...(host ? { host } : {}) })
  try {
    const response = await fetch(`${shuttleBase}/api/v1/transcript/usage?${query}`)
    return response.ok ? await response.json() as TranscriptUsage : null
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
 * The context figure's tooltip. Claude transcripts record no window; Claude
 * sessions run with a million-token one.
 */
export function contextTitle(usage: TranscriptUsage, agent: string | undefined): string {
  if (usage.context === undefined) return ''
  const count = (n: number): string => new Intl.NumberFormat('en-US').format(n)
  const window_ = usage.window ?? (agent?.startsWith('claude') ? 1_000_000 : undefined)
  const tokens = `Context: ${count(usage.context)} tokens`
  if (!window_) return tokens
  return `${tokens} of a ${count(window_)}-token window (${Math.round(Math.min(1, usage.context / window_) * 100)}% full)`
}
