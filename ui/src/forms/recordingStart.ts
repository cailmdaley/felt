/** A start without an authoritative answer holds every recording entry point. */
const key = (base: string): string => `shuttle.recording-start:${base}`
const fallback = new Map<string, string>()
const listeners = new Set<() => void>()

export function subscribeRecordingStart(listener: () => void): () => void {
  listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', listener)
  }
}

function changed(): void {
  for (const listener of listeners) listener()
}

export function recordingStartHold(base: string): string | null {
  if (fallback.has(base)) return fallback.get(base)!
  try { return localStorage.getItem(key(base)) } catch { return null }
}

export function holdRecordingStart(base: string, recorder: string | null): void {
  const identity = recorder ?? 'hub-selected recorder'
  try { localStorage.setItem(key(base), identity) } catch { fallback.set(base, identity) }
  changed()
}

/** Called on a definitive start response or after the operator inspects the recorder. */
export function resolveRecordingStart(base: string): void {
  fallback.delete(base)
  try { localStorage.removeItem(key(base)) } catch { /* Storage may be unavailable. */ }
  changed()
}
