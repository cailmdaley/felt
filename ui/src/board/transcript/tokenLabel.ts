/** Compact token counts for transcript head facts: a decimal only below 100k, where it still says something. */
export function tokenLabel(tokens: number): string {
  if (tokens >= 999_500) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 100_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}k`
  return String(tokens)
}
