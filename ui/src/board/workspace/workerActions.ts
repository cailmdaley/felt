import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { isAgentCard, type PastedImage } from '../KanbanModalShared.js'
import { onDesk } from './fiberPageState.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'
import { slug } from '../threadOutline.js'

type SessionMode = 'fresh' | 'previous'

/** Starts or resumes one worker with an opening message and its images; resolves true once the daemon took it. */
export type StartWorker = (card: KanbanCard, mode: SessionMode, message: string, word: HTMLElement, images: PastedImage[]) => Promise<boolean>

/** How long the receipt stays after a send. */
const RECEIPT_MS = 4_000
/** What the owning daemon takes in one send (Shuttle.DispatchImages). */
const MAX_IMAGES = 8
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

interface Held { file: File; url: string }

/**
 * One worker's ways to run: a line for an opening message, the verb Enter
 * takes, and New session. Enter resumes the session the worker has (typing
 * into it when it is live) or starts its first; an empty line resumes or
 * starts with nothing said. After a send the line says so, and nothing more.
 * The line grows with what is typed (Shift+Enter breaks it), and images
 * pasted or dropped onto it wait as thumbnails and go with the send.
 */
export class WorkerActions {
  readonly el = document.createElement('div')
  private readonly field = document.createElement('textarea')
  private readonly shelf = document.createElement('div')
  private held: Held[] = []
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
    this.field.rows = 1
    this.field.className = 'ws-worker-message'
    this.field.enterKeyHint = 'send'
    this.field.autocomplete = 'off'
    this.primary = button('ws-worker-primary', 'resume')
    this.fresh = button('ws-worker-fresh', 'newSession', 'New session')
    this.fresh.dataset.verb = 'New session'
    this.receipt.className = 'ws-worker-receipt'
    this.receipt.setAttribute('aria-live', 'polite')
    this.shelf.className = 'ws-worker-images'
    this.el.append(this.field, this.primary, this.fresh, this.receipt, this.shelf)
    this.primary.addEventListener('click', () => { void this.send(this.resumes ? 'previous' : 'fresh', this.primary) })
    this.fresh.addEventListener('click', () => { void this.send('fresh', this.fresh) })
    this.field.addEventListener('input', () => this.paint())
    // Enter takes the line's verb, Shift+Enter breaks it; its other keys, Escape aside, never reach the page's shortcuts.
    this.field.addEventListener('keydown', event => {
      if (event.key === 'Escape') { this.field.blur(); return }
      event.stopPropagation()
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.primary.click() }
    })
    // An image on the clipboard is held; text alongside it still pastes as text.
    this.field.addEventListener('paste', event => {
      const files = [...event.clipboardData?.files ?? []].filter(file => file.type.startsWith('image/'))
      if (!files.length) return
      if (!event.clipboardData?.types.includes('text/plain')) event.preventDefault()
      this.hold(files)
    })
    this.field.addEventListener('dragover', event => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault()
    })
    this.field.addEventListener('drop', event => {
      const files = [...event.dataTransfer?.files ?? []].filter(file => file.type.startsWith('image/'))
      if (!files.length) return
      event.preventDefault()
      this.hold(files)
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
    this.drop(this.held)
  }

  /** Hold images for the next send, refusing what the daemon would. */
  private hold(files: File[]): void {
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) { this.say('Only PNG, JPEG, GIF or WebP images'); continue }
      if (this.held.length >= MAX_IMAGES) { this.say(`At most ${MAX_IMAGES} images`); break }
      const total = this.held.reduce((sum, h) => sum + h.file.size, 0) + file.size
      if (total > MAX_IMAGE_BYTES) { this.say('Images over 20 MB'); break }
      this.held.push({ file, url: URL.createObjectURL(file) })
    }
    this.paint()
  }

  private drop(held: Held[]): void {
    for (const h of held) URL.revokeObjectURL(h.url)
    this.held = this.held.filter(h => !held.includes(h))
  }

  private say(text: string): void {
    this.receipt.textContent = text
    if (this.receiptTimer !== null) window.clearTimeout(this.receiptTimer)
    this.receiptTimer = window.setTimeout(() => { this.receipt.textContent = ''; this.receiptTimer = null }, RECEIPT_MS)
  }

  private paintShelf(): void {
    const shown = [...this.shelf.children].map(chip => (chip as HTMLElement).dataset.url)
    if (shown.join() === this.held.map(h => h.url).join()) return
    this.shelf.replaceChildren(...this.held.map(h => {
      const chip = document.createElement('span')
      chip.className = 'ws-worker-image'
      chip.dataset.url = h.url
      const img = document.createElement('img')
      img.src = h.url; img.alt = h.file.name || 'Pasted image'
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'ws-worker-image-remove'
      remove.textContent = '×'
      remove.setAttribute('aria-label', `Remove ${img.alt}`)
      remove.addEventListener('click', () => { this.drop([h]); this.paint(); this.field.focus() })
      chip.append(img, remove)
      return chip
    }))
    this.shelf.hidden = !this.held.length
  }

  /** The textarea grows with its text, up to the stylesheet's max-height; empty, it is one line whatever its placeholder. */
  private fit(): void {
    this.field.style.height = ''
    if (!this.field.value) return
    this.field.style.height = 'auto'
    if (this.field.scrollHeight) this.field.style.height = `${this.field.scrollHeight + this.field.offsetHeight - this.field.clientHeight}px`
  }

  /** The worker has a session to go back to. */
  private get resumes(): boolean { return !!this.card.sessionUuid }

  private paint(): void {
    const card = this.card
    // Only a Shuttle constitution on the Desk's lifecycle has a worker to run.
    this.el.hidden = !isAgentCard(card) || !onDesk(card)
    const live = hasLiveWorker(card)
    const said = this.field.value.trim() !== '' || this.held.length > 0
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
    this.field.placeholder = live ? `Message ${slug(card)}` : `${verb} ${slug(card)} with…`
    this.field.setAttribute('aria-label', live ? `Message to ${card.name}` : `Opening message for ${card.name}`)
    this.paintShelf()
    this.fit()
  }

  private async send(mode: SessionMode, control: HTMLButtonElement): Promise<void> {
    if (this.busy || control.disabled) return
    const message = this.field.value.trim()
    const held = [...this.held]
    this.busy = true
    this.paint()
    const start = (images: PastedImage[]): Promise<boolean> => this.start(this.card, mode, message, word(control), images)
    const sending = held.length ? encode(held).then(start, () => { this.say('Could not read an image'); return false }) : start([])
    const ok = await sending.finally(() => { this.busy = false })
    if (ok) {
      this.field.value = ''
      this.drop(held)
      this.say(message || held.length ? 'Sent' : mode === 'previous' ? 'Resumed' : 'Started')
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

/** Base64 of each held image, for the dispatch body. */
function encode(held: Held[]): Promise<PastedImage[]> {
  return Promise.all(held.map(({ file }) => new Promise<PastedImage>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve({ name: file.name || 'pasted.png', data: String(reader.result).replace(/^data:[^,]*,/, '') })
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })))
}
