export const THREAD_PREFERENCES_CHANGED = 'shuttle-thread-preferences-changed'
const KEY = 'shuttle:board:waiting-threads'
let fallback = false
export function waitingThreadEntries(): boolean {
  try { return localStorage.getItem(KEY) === 'true' } catch { return fallback }
}
export function saveWaitingThreadEntries(enabled: boolean): void {
  fallback = enabled
  try { localStorage.setItem(KEY, String(enabled)) } catch { /* This page keeps the choice. */ }
  window.dispatchEvent(new Event(THREAD_PREFERENCES_CHANGED))
}
