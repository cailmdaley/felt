import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'

type SessionMode = 'fresh' | 'previous'

/** Starts or resumes one worker with an opening message; resolves true once the daemon took it. */
export type StartWorker = (card: KanbanCard, mode: SessionMode, message: string, word: HTMLElement) => Promise<boolean>

/** How long the receipt stays after a send. */
const RECEIPT_MS = 4_000

/**
 * One worker's ways to run: a line for an opening message, the verb Enter
 * takes, and New session. Enter resumes the session the worker has (typing
 * into it when it is live) or starts its first; an empty line resumes or
 * starts with nothing said. After a send the line says so, and nothing more.
 */
export class WorkerActions {
  readonly el = document.createElement('div')
  private readonly field = document.createElement('input')
  private readonly primary: HTMLButtonElement
  private readonly fresh: HTMLButtonElement
  private readonly receipt = document.createElement('span')
  private card: KanbanCard
  private busy = false
  private receiptTimer: number | null = null
  private note = ''
  private readonly start: StartWorker

  constructor(card: KanbanCard, start: StartWorker) {
    this.card = card
    this.start = start
    this.el.className = 'ws-worker-acts'
    this.el.dataset.part = 'worker-actions'
    this.field.type = 'text'
    this.field.className = 'ws-worker-message'
    this.field.enterKeyHint = 'send'
    this.field.autocomplete = 'off'
    this.primary = button('ws-worker-primary', 'resume')
    this.fresh = button('ws-worker-fresh', 'newSession', 'New session')
    this.fresh.dataset.verb = 'New session'
    this.receipt.className = 'ws-worker-receipt'
    this.receipt.setAttribute('aria-live', 'polite')
    this.el.append(this.field, this.primary, this.fresh, this.receipt)
    this.primary.addEventListener('click', () => { void this.send(this.resumes ? 'previous' : 'fresh', this.primary) })
    this.fresh.addEventListener('click', () => { void this.send('fresh', this.fresh) })
    this.field.addEventListener('input', () => this.paint())
    // Enter takes the line's verb; its other keys, Escape aside, never reach the page's shortcuts.
    this.field.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.field.blur(); return }
      event.stopPropagation()
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); this.primary.click() }
    })
    this.paint()
  }

  /** Follow the card's runtime: which verbs it offers and what they say; `note` adds to Resume's title (the cache's warmth). */
  update(card: KanbanCard, note = ''): void {
    this.card = card
    this.note = note
    this.paint()
  }

  dispose(): void {
    if (this.receiptTimer !== null) window.clearTimeout(this.receiptTimer)
  }

  /** The worker has a session to go back to. */
  private get resumes(): boolean { return !!this.card.sessionUuid }

  private paint(): void {
    const card = this.card
    const live = hasLiveWorker(card)
    const said = this.field.value.trim() !== ''
    const verb = !this.resumes ? 'Start' : live ? 'Send' : 'Resume'
    if (this.primary.dataset.verb !== verb) {
      this.primary.dataset.verb = verb
      this.primary.querySelector('svg')!.outerHTML = headerIcon(verb === 'Start' ? 'start' : verb === 'Send' ? 'send' : 'resume')
    }
    if (!this.busy) word(this.primary).textContent = verb
    this.primary.title = live ? `Type this into ${card.name}'s conversation (Enter)` : `${verb} ${card.name}${said ? ' with this message' : ''} (Enter)${verb === 'Resume' && this.note ? ` · ${this.note}` : ''}`
    this.primary.setAttribute('aria-label', `${verb} ${card.name}`)
    this.primary.disabled = this.busy || (live && !said)
    this.fresh.hidden = !this.resumes
    this.fresh.disabled = this.busy
    this.fresh.title = `A new session for ${card.name}${said ? ', opening with this message' : ''}${live ? '; cuts the running one' : ''}`
    this.fresh.setAttribute('aria-label', `New session for ${card.name}`)
    this.field.placeholder = live ? `Message ${card.name}` : `${verb} ${card.name} with…`
    this.field.setAttribute('aria-label', live ? `Message to ${card.name}` : `Opening message for ${card.name}`)
  }

  private async send(mode: SessionMode, control: HTMLButtonElement): Promise<void> {
    if (this.busy || control.disabled) return
    const message = this.field.value.trim()
    this.busy = true
    this.paint()
    const ok = await this.start(this.card, mode, message, word(control)).finally(() => { this.busy = false })
    if (ok) {
      this.field.value = ''
      this.receipt.textContent = message ? 'Sent' : mode === 'previous' ? 'Resumed' : 'Started'
      if (this.receiptTimer !== null) window.clearTimeout(this.receiptTimer)
      this.receiptTimer = window.setTimeout(() => { this.receipt.textContent = ''; this.receiptTimer = null }, RECEIPT_MS)
    }
    this.paint()
  }
}

function button(cls: string, icon: HeaderIcon, label = ''): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.className = `ws-header-icon ws-header-verb ${cls}`
  control.innerHTML = headerIcon(icon)
  const text = document.createElement('span')
  text.className = 'ws-header-word'
  text.textContent = label
  control.append(text)
  return control
}

const word = (control: HTMLButtonElement): HTMLElement => control.querySelector<HTMLElement>('.ws-header-word')!
