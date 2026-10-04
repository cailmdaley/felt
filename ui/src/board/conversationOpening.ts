/** Opening belongs to this browser; execution belongs to the worker's host. */
export type ClaudeOpening = 'terminal' | 'browser' | 'app'
export const CLAUDE_OPENING_KEY = 'shuttle.claude-opening'
export const CONVERSATION_OPENING_CHANGED = 'shuttle-conversation-opening-changed'

export function claudeOpening(): ClaudeOpening {
  try {
    const value = globalThis.localStorage?.getItem(CLAUDE_OPENING_KEY)
    if (value === 'browser' || value === 'app') return value
  } catch { /* Site storage may be disabled. */ }
  return 'terminal'
}

/** Return false when this browser cannot retain the preference. */
export function saveClaudeOpening(value: ClaudeOpening): boolean {
  try {
    globalThis.localStorage.setItem(CLAUDE_OPENING_KEY, value)
    window.dispatchEvent(new Event(CONVERSATION_OPENING_CHANGED))
    return true
  } catch {
    return false
  }
}

/** Phones retain their HTTPS universal-link opening, even with Terminal selected. */
export function effectiveClaudeOpening(desktop: boolean, choice = claudeOpening()): ClaudeOpening {
  return desktop ? choice : 'browser'
}

export const REMOTE_CONTROL_REQUIRED = 'No Claude Remote Control link is available. Enable Remote Control in this Claude session to open it in the browser or app.'
export const CLAUDE_APP_ROUTE_UNAVAILABLE = 'This Remote Control link has no supported Claude desktop app route. Open it in the browser instead.'
