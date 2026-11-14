import { hasLiveWorker, type KanbanCard } from '../KanbanTypes.js'
import { isAgentCard, type PastedImage } from '../KanbanModalShared.js'
import { onDesk } from './fiberPageState.js'
import { headerIcon, type HeaderIcon } from './headerIcon.js'

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

/** The message box's text, as the browser lays it out (a line break typed is a newline). */
const textOf = (field: HTMLElement): string => field.innerText ?? field.textContent ?? ''

/**
 * One worker's message box: a field that grows with what is typed (Shift+Enter
 * breaks a line), and at its first line's right, the tools seated into it (the
 * band seats Listen there), Send and New session. The tools float, so the
 * text's first line runs up to them and every later line takes the box's full
 * width beneath them. Enter takes the primary verb: it resumes the session the
 * worker has (typing into it when it is live) or starts its first; an empty
 * box resumes or starts with nothing said. After a send the box says so, and
 * nothing more. Images pasted or dropped onto it wait as thumbnails and go
 * with the send.
 *
 * The field is a plaintext editable block rather than a textarea: only a
 * block's line boxes wrap around a float, and the float sits outside the
 * editable text, where neither the caret nor a deletion can reach it.
 */
export class WorkerActions {
  readonly el = document.createElement('div')
  private readonly compose = document.createElement('div')
  private readonly tools = document.createElement('span')
  private readonly field = document.createElement('div')
  private readonly shelf = document.createElement('div')
  private held: Held[] = []
  private readonly primary: HTMLButtonElement
  private readonly fresh: HTMLButtonElement
  private readonly receipt = document.createElement('span')
  private card: KanbanCard
  private busy = false
  /** Something was seated in the tools, which keeps the box when its worker has nothing to run. */
  private seated = false
  private receiptTimer: number | null = null
  private note = ''
  private readonly start: StartWorker

  constructor(card: KanbanCard, start: StartWorker) {
    this.card = card
    this.start = start
    this.el.className = 'ws-worker-acts'
    this.el.dataset.part = 'worker-actions'
    this.compose.className = 'ws-worker-compose'
    this.tools.className = 'ws-worker-tools'
    this.field.className = 'ws-worker-message'
    this.field.setAttribute('contenteditable', 'plaintext-only')
    this.field.setAttribute('role', 'textbox')
    this.field.setAttribute('aria-multiline', 'true')
    this.field.enterKeyHint = 'send'
    this.field.tabIndex = 0
    this.primary = button('ws-worker-primary', 'resume')
    this.fresh = button('ws-worker-fresh', 'newSession', 'New session')
    this.fresh.dataset.verb = 'New session'
    this.receipt.className = 'ws-worker-receipt'
    this.receipt.setAttribute('aria-live', 'polite')
    this.shelf.className = 'ws-worker-images'
    this.tools.append(this.receipt, this.primary, this.fresh)
    this.compose.append(this.tools, this.field)
    this.el.append(this.compose, this.shelf)
    // A press on the box's padding or beside the tools lands in the text.
    this.compose.addEventListener('pointerdown', event => {
      if (event.target !== this.compose) return
      event.preventDefault()
      this.focus()
    })
    this.primary.addEventListener('click', () => { void this.send(this.resumes ? 'previous' : 'fresh', this.primary) })
    this.fresh.addEventListener('click', () => { void this.send('fresh', this.fresh) })
    this.field.addEventListener('input', () => {
      // Emptied, the field drops the break a browser leaves behind, so its placeholder returns.
      if (!this.field.textContent && this.field.firstChild) this.field.replaceChildren()
      this.paint()
    })
    // Enter takes the box's verb, Shift+Enter breaks the line; its other keys, Escape aside, never reach the page's shortcuts.
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

  /** Seat controls at the head of the box's tools, before its receipt and verbs. */
  seat(...controls: HTMLElement[]): void {
    this.tools.prepend(...controls)
    this.seated ||= controls.length > 0
    this.paint()
  }

  /** The message as typed. */
  get message(): string { return textOf(this.field) }

  focus(): void {
    this.field.focus({ preventScroll: true })
    // The caret goes to the end of what is there.
    const range = document.createRange()
    range.selectNodeContents(this.field)
    range.collapse(false)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
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
    this.shelf.hidden = !this.held.length
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
  }

  /** The worker has a session to go back to. */
  private get resumes(): boolean { return !!this.card.sessionUuid }

  /** Only a Shuttle constitution on the Desk's lifecycle has a worker to run. */
  private get runnable(): boolean { return isAgentCard(this.card) && onDesk(this.card) }

  private paint(): void {
    const card = this.card
    const runnable = this.runnable
    // A box with nothing to run still holds what was seated in it (Listen); with nothing seated it goes.
    this.el.hidden = !runnable && !this.seated
    this.field.setAttribute('contenteditable', runnable ? 'plaintext-only' : 'false')
    this.field.setAttribute('aria-disabled', String(!runnable))
    this.field.hidden = !runnable
    this.primary.hidden = !runnable
    const live = hasLiveWorker(card)
    const said = this.message.trim() !== '' || this.held.length > 0
    const verb = !this.resumes ? 'Start' : live ? 'Send' : 'Resume'
    if (this.primary.dataset.verb !== verb) {
      this.primary.dataset.verb = verb
      this.primary.querySelector('svg')!.outerHTML = headerIcon(verb === 'Start' ? 'start' : verb === 'Send' ? 'send' : 'resume')
      word(this.primary).textContent = verb
    }
    const title = live ? `Type this into ${card.name}'s conversation` : `${verb} ${card.name}${said ? ' with this message' : ''}`
    this.primary.title = `${title} (Enter)${verb === 'Resume' && this.note ? ` · ${this.note}` : ''}`
    this.primary.setAttribute('aria-label', `${verb} ${card.name}`)
    this.primary.disabled = this.busy || (live && !said)
    this.fresh.hidden = !runnable || !this.resumes
    this.fresh.disabled = this.busy
    this.fresh.title = `A new session for ${card.name}${said ? ', opening with this message' : ''}${live ? '; cuts the running one' : ''}`
    this.fresh.setAttribute('aria-label', `New session for ${card.name}`)
    this.field.dataset.placeholder = live ? 'Message' : `${verb} with…`
    this.field.setAttribute('aria-label', live ? `Message to ${card.name}` : `Opening message for ${card.name}`)
    this.paintShelf()
  }

  private async send(mode: SessionMode, control: HTMLButtonElement): Promise<void> {
    if (this.busy || control.disabled) return
    const message = this.message.trim()
    const held = [...this.held]
    this.busy = true
    this.paint()
    // The receipt says what is under way while the daemon answers.
    if (this.receiptTimer !== null) { window.clearTimeout(this.receiptTimer); this.receiptTimer = null }
    this.receipt.textContent = ''
    const start = (images: PastedImage[]): Promise<boolean> => this.start(this.card, mode, message, this.receipt, images)
    const sending = held.length ? encode(held).then(start, () => { this.say('Could not read an image'); return false }) : start([])
    const ok = await sending.finally(() => { this.busy = false })
    if (ok) {
      this.field.replaceChildren()
      this.drop(held)
      this.say(message || held.length ? 'Sent' : mode === 'previous' ? 'Resumed' : 'Started')
    }
    this.paint()
  }
}

function button(cls: string, icon: HeaderIcon, label = ''): HTMLButtonElement {
  const control = document.createElement('button')
  control.type = 'button'
  control.className = `ws-header-icon ${cls}`
  control.innerHTML = headerIcon(icon)
  const text = document.createElement('span')
  text.className = 'ws-header-word ws-sr-only'
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
