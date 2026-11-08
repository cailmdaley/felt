const CLAUDE_SESSION = /^https:\/\/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]+)$/

/** Whether this browser can use a native desktop application opener. */
export function canOpenDesktopApp(userAgent: string, coarse: boolean): boolean {
  return !coarse && !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)
}

/** The Claude desktop route for a URL naming exactly one bridged session. */
export function claudeAppRoute(url: string): string | undefined {
  const match = CLAUDE_SESSION.exec(url)
  const id = match?.[0] === url ? match[1] : undefined
  return id ? `claude://claude.ai/code/${id}` : undefined
}

/** Only HTTPS links on Claude's exact origin can leave the board. */
export function claudeWebLink(url: string | null | undefined): string | undefined {
  if (!url || /\s/.test(url)) return undefined
  try {
    const parsed = new URL(url)
    return parsed.origin === 'https://claude.ai' && !parsed.username && !parsed.password ? url : undefined
  } catch { return undefined }
}
