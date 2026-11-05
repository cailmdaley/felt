import type { ChangeDraft } from './changeModel.js'

interface DraftState { value: ChangeDraft; busy: boolean; message: string; listeners: Set<() => void> }
const active = new Map<string, DraftState>()

/** One editable draft per owner/path, shared across remounts and rebakes in this tab. */
export function acquireChangeDraft(identity: string, base: string, head: string) {
  const key = `shuttle:change:${JSON.stringify(identity)}:draft`
  let state = active.get(key)
  if (!state) {
    let value: ChangeDraft = { note: '', comments: [], base, head }
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (saved && typeof saved.note === 'string' && Array.isArray(saved.comments)) value = saved
    } catch { /* Drafting also works without storage. */ }
    state = { value, busy: false, message: '', listeners: new Set() }; active.set(key, state)
  }
  const current = state
  const prune = (): void => { if (!current.busy && !current.listeners.size) active.delete(key) }
  return {
    value: current.value,
    get busy() { return current.busy },
    get message() { return current.message },
    report(message: string): void { current.message = message },
    save(): void { try { localStorage.setItem(key, JSON.stringify(current.value)) } catch { /* Keep the in-memory draft. */ } },
    lock(busy: boolean): void { current.busy = busy; if (busy) current.message = 'Sending…'; for (const listener of current.listeners) listener(); prune() },
    subscribe(listener: () => void): () => void { current.listeners.add(listener); return () => { current.listeners.delete(listener); prune() } },
  }
}
