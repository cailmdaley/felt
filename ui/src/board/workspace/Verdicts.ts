import { hasWorkerToStop, type KanbanCard } from '../KanbanTypes.js'
import { keyIntent } from '../keymap.js'
import { blockingDialogOpen } from '../views/ViewRegistry.js'
import { VERDICT_DELAY_MS } from './verdictDelay.js'
import './verdicts.css'

export type Verdict = 'tempered' | 'composted'

/** A verdict stops any worker the card owns, so it asks first, as "New session"
 * does; a verdict on a finished run stays a single gesture. */
export function confirmWorkerStop(card: KanbanCard, verdict: Verdict): boolean {
  return !hasWorkerToStop(card) ||
    window.confirm(`“${card.name}” has a live worker. This stops it — ${verdict === 'tempered' ? 'temper' : 'discard'} anyway?`)
}

/** A fiber's identity across hosts and renames: the undo queue's key. */
export const verdictKey = (card: Pick<KanbanCard, 'originId' | 'uid' | 'id'>): string =>
  JSON.stringify([card.originId, card.uid ?? card.id])

/**
 * Marks where a card's verdict controls sit. While a verdict on that card
 * waits out its undo window, the host's own children give way to one line,
 * "Tempered · undo z", in their footprint.
 */
export function markVerdictHost(host: HTMLElement, card: KanbanCard): void {
  host.dataset.verdictKey = verdictKey(card)
}

interface Pending { timer: number; verdict: 'tempered' | 'discarded'; name: string; due: number }

/** Session-local safety: only an expired undo window authorizes a lifecycle write.
 * Navigation leaves timers alone. Closing the browser tab (or disposing this
 * workspace) loses uncommitted verdicts; no unload handler sends a write.
 *
 * The window is drawn in place, on every marked host for its card. Surfaces
 * re-render freely: while anything is pending, a mutation observer repaints
 * the hosts they rebuild before the browser draws them.
 */
export class Verdicts {
  private readonly pending = new Map<string, Pending>()
  private readonly live = document.createElement('div')
  private readonly observer = new MutationObserver(() => this.paint())
  constructor() {
    this.live.className = 'ws-sr-only'
    this.live.setAttribute('aria-live', 'polite')
    document.body.append(this.live)
    window.addEventListener('keydown', this.keydown, true)
  }
  queue(card: KanbanCard, verdict: Verdict, commit: () => void): void {
    const key = verdictKey(card)
    this.undo(key)
    const word = verdict === 'tempered' ? 'Tempered' : 'Discarded'
    const timer = window.setTimeout(() => {
      this.pending.delete(key)
      // The write paints the card's new state first, so its controls do not
      // flash back between the line and the verdict.
      commit()
      this.paint()
    }, VERDICT_DELAY_MS)
    this.pending.set(key, { timer, verdict: verdict === 'tempered' ? 'tempered' : 'discarded', name: card.name, due: Date.now() + VERDICT_DELAY_MS })
    this.live.textContent = `${word} ${card.name} · undo z`
    this.paint()
  }
  /** z cancels the latest remaining verdict; each visible undo names its own. */
  undo(key = [...this.pending.keys()].at(-1)): boolean {
    if (!key) return false
    const pending = this.pending.get(key)
    if (!pending) return false
    window.clearTimeout(pending.timer)
    this.pending.delete(key)
    this.paint()
    return true
  }
  private paint(): void {
    this.observer.disconnect()
    for (const host of document.querySelectorAll<HTMLElement>('[data-verdict-key]')) {
      const key = host.dataset.verdictKey!
      const pending = this.pending.get(key)
      const line = host.querySelector<HTMLElement>(':scope > .ws-verdict-undo')
      if (line?.dataset.verdict === pending?.verdict) continue
      const focused = host.contains(document.activeElement)
      line?.remove()
      if (!pending) {
        delete host.dataset.verdictPending
        if (focused) host.querySelector<HTMLElement>('button')?.focus()
        continue
      }
      const next = this.line(key, pending)
      host.dataset.verdictPending = pending.verdict
      host.append(next)
      // The control that gave the verdict gives way; its focus moves to undo.
      if (focused) next.querySelector('button')!.focus()
    }
    if (this.pending.size) this.observer.observe(document.body, { childList: true, subtree: true })
  }
  private line(key: string, pending: Pending): HTMLElement {
    const line = document.createElement('span')
    line.className = 'ws-verdict-undo'
    line.dataset.verdict = pending.verdict
    // A host rebuilt mid-window joins the fade where it stands.
    const left = Math.max(0, pending.due - Date.now())
    line.style.setProperty('--ws-verdict-left', `${left}ms`)
    if (left > VERDICT_DELAY_MS - 100) line.dataset.fresh = ''
    const word = document.createElement('span')
    word.className = 'ws-verdict-word'
    word.dataset.verdict = pending.verdict
    word.textContent = pending.verdict === 'tempered' ? 'Tempered' : 'Discarded'
    const dot = document.createElement('span')
    dot.setAttribute('aria-hidden', 'true')
    dot.textContent = '·'
    const undo = document.createElement('button')
    undo.type = 'button'
    const kbd = document.createElement('kbd')
    kbd.textContent = 'z'
    undo.append('undo ', kbd)
    undo.setAttribute('aria-label', `Undo verdict on ${pending.name}`)
    undo.addEventListener('click', event => { event.stopPropagation(); this.undo(key) })
    line.append(word, dot, undo)
    return line
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (blockingDialogOpen() || keyIntent(event, 'reader') !== 'undoVerdict' || !this.undo()) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  dispose(): void {
    for (const key of [...this.pending.keys()]) this.undo(key)
    this.observer.disconnect()
    window.removeEventListener('keydown', this.keydown, true)
    this.live.remove()
  }
}
