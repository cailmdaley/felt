/** Compact token counts for transcript head facts. */
export function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  if (tokens >= 1000) return `${Number((tokens / 1000).toFixed(1))}k`
  return String(tokens)
}
