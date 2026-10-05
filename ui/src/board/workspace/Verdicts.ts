import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import { keyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import './verdicts.css'

export type Verdict = 'tempered' | 'composted'
export const VERDICT_DELAY_MS = 6000

/** A verdict stops any worker the card owns, so it asks first, as "New session"
 * does; a verdict on a finished run stays a single gesture. */
export function confirmWorkerStop(card: KanbanCard, verdict: Verdict): boolean {
  return !hasWorkerToStop(card) ||
    window.confirm(`“${card.name}” has a live worker. This stops it — ${verdict === 'tempered' ? 'temper' : 'discard'} anyway?`)
}
interface Pending { timer: number; toast: HTMLElement }

/** Session-local safety: only an expired toast authorizes a lifecycle write.
 * Navigation leaves timers alone. Closing the browser tab (or disposing this
 * workspace) loses uncommitted verdicts; no unload handler sends a write.
 */
export class Verdicts {
  private readonly pending = new Map<string, Pending>()
  private readonly el = document.createElement('div')
  constructor() {
    this.el.className = 'ws-verdict-toasts'
    this.el.setAttribute('aria-live', 'polite')
    this.el.setAttribute('aria-relevant', 'additions')
    document.body.append(this.el)
    window.addEventListener('keydown', this.keydown, true)
  }
  queue(card: KanbanCard, verdict: Verdict, commit: () => void, material?: { paper: string; ink: string }): void {
    const key = JSON.stringify([card.originId, card.uid ?? card.id])
    this.undo(key)
    const toast = document.createElement('div')
    toast.className = 'ws-verdict-toast'
    toast.dataset.part = 'act'; toast.dataset.act = 'toast'
    if (material) {
      toast.dataset.wsActMaterial = ''
      toast.style.setProperty('--ws-paper', material.paper)
      toast.style.setProperty('--ws-ink', material.ink)
    }
    toast.setAttribute('aria-atomic', 'true')
    const name = document.createElement('em')
    name.textContent = card.name
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.textContent = 'Undo z'
    undo.setAttribute('aria-label', `Undo verdict on ${card.name}`)
    undo.addEventListener('click', () => this.undo(key))
    toast.append(verdict === 'tempered' ? 'Tempered ' : 'Discarded ', name, ' · ', undo)
    this.el.append(toast)
    const timer = window.setTimeout(() => {
      this.pending.delete(key)
      toast.remove()
      commit()
    }, VERDICT_DELAY_MS)
    this.pending.set(key, { timer, toast })
  }
  /** z cancels the latest remaining verdict; each visible Undo names its own. */
  undo(key = [...this.pending.keys()].at(-1)): boolean {
    if (!key) return false
    const pending = this.pending.get(key)
    if (!pending) return false
    window.clearTimeout(pending.timer)
    pending.toast.remove()
    this.pending.delete(key)
    return true
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (blockingDialogOpen() || keyIntent(event, 'reader') !== 'undoVerdict' || !this.undo()) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  dispose(): void {
    for (const key of this.pending.keys()) this.undo(key)
    window.removeEventListener('keydown', this.keydown, true)
    this.el.remove()
  }
}
