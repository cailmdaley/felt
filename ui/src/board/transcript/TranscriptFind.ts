export interface FindHost {
  /** Mark the words in the open transcript and report through `setCount`. */
  query(text: string): void
  step(direction: 1 | -1): void
  cleared(): void
}

const QUERY_DELAY_MS = 120
const PLACEHOLDER = 'Find in this transcript'
const HINT = 'Enter: next · Shift+Enter: previous · Esc: clear'

function control(label: string, text: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'ws-transcript-find-step'
  button.textContent = text
  button.setAttribute('aria-label', label)
  button.title = label
  return button
}

/** Find and step through matches in the open transcript. */
export class TranscriptFind {
  readonly el = document.createElement('div')
  private readonly input = document.createElement('input')
  private readonly count = document.createElement('span')
  private readonly previous = control('Previous match', '▴')
  private readonly next = control('Next match', '▾')
  private timer: number | null = null

  private readonly host: FindHost
  constructor(host: FindHost) {
    this.host = host
    this.el.className = 'ws-transcript-find'
    this.el.setAttribute('role', 'search')
    const bar = document.createElement('div')
    bar.className = 'ws-transcript-find-bar'
    this.input.type = 'search'
    this.input.className = 'ws-transcript-find-input'
    this.input.placeholder = PLACEHOLDER
    this.input.title = HINT
    this.input.setAttribute('aria-label', PLACEHOLDER)
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.count.className = 'ws-transcript-find-count'
    this.count.setAttribute('aria-live', 'polite')
    this.previous.disabled = this.next.disabled = true
    bar.append(this.input, this.count, this.previous, this.next)
    this.el.append(bar)
    this.input.addEventListener('input', () => this.typed())
    this.input.addEventListener('keydown', event => this.keydown(event))
    this.previous.addEventListener('click', () => host.step(-1))
    this.next.addEventListener('click', () => host.step(1))
  }

  get value(): string { return this.input.value }
  focus(): void { this.input.focus({ preventScroll: true }); this.input.select() }
  hasFocus(): boolean { return this.el.contains(document.activeElement) }
  set(text: string): void { this.input.value = text }
  setCount(current: number, total: number): void {
    const asked = this.input.value.trim() !== ''
    this.previous.disabled = this.next.disabled = total < 2
    this.count.textContent = !asked ? '' : total === 0 ? 'no matches' : `${current} of ${total}`
    if (asked && total === 0) this.count.dataset.empty = 'true'
    else delete this.count.dataset.empty
  }
  clear(): void {
    this.cancel()
    this.input.value = ''
    this.setCount(0, 0)
    this.host.cleared()
  }
  dispose(): void { this.cancel() }
  private cancel(): void {
    if (this.timer !== null) window.clearTimeout(this.timer)
    this.timer = null
  }
  private typed(): void {
    const text = this.input.value
    this.cancel()
    if (!text.trim()) { this.clear(); return }
    this.timer = window.setTimeout(() => { this.timer = null; this.host.query(text) }, QUERY_DELAY_MS)
  }
  private keydown(event: KeyboardEvent): void {
    if (event.isComposing) return
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      if (this.timer !== null) { this.cancel(); this.host.query(this.input.value) }
      this.host.step(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape' && this.input.value) {
      event.preventDefault(); event.stopPropagation(); this.clear()
    }
  }
}
