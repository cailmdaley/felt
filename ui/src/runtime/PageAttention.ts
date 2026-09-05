type PageAttentionState = 'hidden' | 'visible-unfocused' | 'active'

const MIN_UNFOCUSED_POLL_INTERVAL_MS = 60_000

function getPageAttention(): PageAttentionState {
  if (document.hidden) return 'hidden'
  if (!document.hasFocus()) return 'visible-unfocused'
  return 'active'
}

export function shouldRunVisiblePoll(
  lastRunAtMs: number | null,
  nowMs: number,
  activeIntervalMs: number,
): boolean {
  const attention = getPageAttention()
  if (attention === 'hidden') return false
  if (lastRunAtMs === null) return true
  const interval = attention === 'active'
    ? activeIntervalMs
    : Math.max(activeIntervalMs * 2, MIN_UNFOCUSED_POLL_INTERVAL_MS)
  return nowMs - lastRunAtMs >= interval
}
