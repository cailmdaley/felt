import type { ChangeDraft } from './changeModel.js'

/** Draft text keeps its original snapshot anchors when the bundle is rebaked. */
export function acquireChangeDraft(identity: string, base: string, head: string) {
  const key = `shuttle:change:${JSON.stringify(identity)}:draft`
  let value: ChangeDraft = { note: '', comments: [], base, head }
  try {
    value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? value
  } catch {
    /* Drafting also works without storage. */
  }
  return {
    value,
    busy: false,
    message: '',
    report(message: string): void {
      this.message = message
    },
    lock(busy: boolean): void {
      this.busy = busy
    },
    save(): void {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        /* Keep the in-memory draft. */
      }
    },
  }
}
