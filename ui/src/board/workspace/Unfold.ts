import type { DocumentKey } from './DocumentBridge.js'
import { buildFileViewer, disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { forwardDocumentKey } from './DocumentBridge.js'
import { documentKind, parseDocKey, type DocKey } from './documents.js'
import { Thumbnail } from './Thumbnail.js'
import './unfold.css'

/** A file the previews show: its document key and the name its bar carries. */
export interface UnfoldFile { key: DocKey; name: string }

export interface UnfoldOptions {
  shuttleBase: string
  /** Folded, only the first file shows; otherwise every one stands in a sideways row, the next peeking at its edge. */
  single?: boolean
  /** Whether its host is on screen: a hidden host loads no previews. */
  awake?(): boolean
  /** A file unfolded, a deliberate look at it. */
  seen?(key: DocKey): void
}

/** The nearest box that scrolls this one. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at
  return null
}

/**
 * Files as previews that unfold in place, one component wherever a page shows
 * files inline (a constitution's view, a post in a channel). Folded, each file
 * is a preview capped at about 320px showing the top of its page, at the full
 * width it is given, in one sideways row when there are several. A click
 * unfolds that file at its natural height in the same place, under a slim bar
 * pinned to the top of whatever scrolls it: the file's name, ‹ i / n › when
 * there are several, and the fold control. While one is unfolded, ← and →
 * step to its neighbours, from the page or from inside the file, and Escape
 * folds it, returning to the preview.
 */
export class Unfold {
  readonly el = document.createElement('div')
  private readonly row = document.createElement('div')
  private readonly bar = document.createElement('div')
  private readonly name = document.createElement('span')
  private readonly steps = document.createElement('span')
  private readonly count = document.createElement('span')
  private readonly prev = document.createElement('button')
  private readonly next = document.createElement('button')
  private readonly page = document.createElement('div')
  private files: UnfoldFile[] = []
  private readonly cards = new Map<DocKey, { el: HTMLButtonElement; thumbnail: Thumbnail }>()
  private open: { key: DocKey; viewer: HTMLElement } | null = null
  private readonly opts: UnfoldOptions

  constructor(opts: UnfoldOptions) {
    this.opts = opts
    this.el.className = 'uf'
    this.el.toggleAttribute('data-single', !!opts.single)
    this.row.className = 'uf-row'
    this.bar.className = 'uf-bar'
    this.name.className = 'uf-name'
    this.steps.className = 'uf-steps'
    this.count.className = 'uf-count'
    const control = (button: HTMLButtonElement, text: string, label: string, act: () => void): HTMLButtonElement => {
      button.type = 'button'; button.className = 'uf-control'; button.textContent = text
      button.title = label; button.setAttribute('aria-label', label)
      button.addEventListener('click', event => { event.stopPropagation(); act() })
      return button
    }
    control(this.prev, '‹', 'Previous file (←)', () => this.step(-1))
    control(this.next, '›', 'Next file (→)', () => this.step(1))
    this.steps.append(this.prev, this.count, this.next)
    const fold = control(document.createElement('button'), 'collapse ⌃', 'Collapse (Esc)', () => this.fold())
    fold.classList.add('uf-fold')
    this.bar.append(this.name, this.steps, fold)
    this.page.className = 'uf-page'
    this.page.tabIndex = -1
    this.el.append(this.row)
    this.el.addEventListener('keydown', event => { if (this.key(event.key, event)) { event.preventDefault(); event.stopPropagation() } })
  }

  /** The files it shows, in order; an unfolded file that is gone folds. */
  update(files: readonly UnfoldFile[]): void {
    this.files = [...files]
    const keys = new Set(files.map(file => file.key))
    for (const [key, card] of this.cards) if (!keys.has(key)) { card.thumbnail.dispose(); card.el.remove(); this.cards.delete(key) }
    const shown = this.opts.single ? this.files.slice(0, 1) : this.files, cards = shown.map(file => this.card(file))
    // The same cards stay where they stand: moving one reloads its page, drops its focus and resets the row's scroll.
    if (cards.length !== this.row.children.length || cards.some((card, i) => this.row.children[i] !== card)) this.row.replaceChildren(...cards)
    this.el.hidden = !files.length
    this.el.toggleAttribute('data-several', shown.length > 1)
    if (this.open && !keys.has(this.open.key)) this.fold(false)
    else if (this.open) this.paintBar()
  }
  /** The file unfolded, if one is. */
  get unfolded(): DocKey | null { return this.open?.key ?? null }

  /** Unfolds one file in place, folding any other. */
  unfold(key: DocKey): void {
    const file = this.files.find(each => each.key === key), parsed = parseDocKey(key)
    if (!file || !parsed) return
    if (this.open?.key === key) return
    this.drop()
    const kind = documentKind(parsed.path)
    const viewer = buildFileViewer(this.opts.shuttleBase, parsed.path, parsed.owner, undefined, undefined, {
      kind: kind === 'fiber' ? undefined : kind, fit: true, active: true,
      // Keys from inside the file: its own steps and fold, else the board's, replayed from its place.
      onDocumentKey: (pressed: DocumentKey) => {
        const plain = !pressed.altKey && !pressed.ctrlKey && !pressed.metaKey && !pressed.shiftKey
        if (!plain || !this.key(pressed.key)) forwardDocumentKey(this.page, pressed, viewer.querySelector('iframe'))
      },
    })
    this.open = { key, viewer }
    this.page.dataset.kind = kind
    this.page.replaceChildren(viewer)
    this.el.setAttribute('data-unfolded', '')
    this.el.replaceChildren(this.bar, this.page)
    this.paintBar()
    this.page.focus({ preventScroll: true })
    this.opts.seen?.(key)
  }
  /**
   * Folds the unfolded file back to its preview. Folded by the human, the
   * preview comes into sight with the focus; folded because the file is gone,
   * the focus moves only if it was in the file, and nothing scrolls.
   */
  fold(asked = true): void {
    const key = this.open?.key
    if (!key) return
    const held = this.el.contains(document.activeElement)
    this.drop()
    this.el.removeAttribute('data-unfolded')
    this.el.replaceChildren(this.row)
    // Folded from a file the row does not draw, it returns to the row's first.
    const card = this.cards.get(key)?.el.isConnected ? this.cards.get(key)!.el : this.row.querySelector<HTMLButtonElement>('.uf-card')
    if (asked || held) card?.focus({ preventScroll: true })
    if (asked) (card ?? this.el).scrollIntoView({ block: 'nearest' })
  }
  /** Its host is hidden: an unfolded file stops reading and playing. */
  suspend(): void { if (this.open) suspendFileViewer(this.open.viewer) }
  resume(): void { if (this.open) resumeFileViewer(this.open.viewer) }
  dispose(): void {
    this.drop()
    for (const card of this.cards.values()) card.thumbnail.dispose()
    this.cards.clear()
  }

  /** ← and → step, Escape folds, ↓ and ↑ scroll, while a file is unfolded; true when the key was used. */
  private key(key: string, event?: KeyboardEvent): boolean {
    if (!this.open || event?.altKey || event?.ctrlKey || event?.metaKey || event?.shiftKey) return false
    if (key === 'ArrowLeft' || key === 'ArrowRight') { this.step(key === 'ArrowLeft' ? -1 : 1); return true }
    if (key === 'Escape') { this.fold(); return true }
    if (key === 'ArrowDown' || key === 'ArrowUp') { scroller(this.el)?.scrollBy({ top: key === 'ArrowDown' ? 60 : -60 }); return true }
    return false
  }
  private step(by: -1 | 1): void {
    const at = this.files.findIndex(file => file.key === this.open?.key), next = this.files[at + by]
    if (at < 0 || !next) return
    this.unfold(next.key)
    // Read from deep inside the last file, the next one starts at its top.
    const box = scroller(this.el)
    if (box && this.el.getBoundingClientRect().top < box.getBoundingClientRect().top) this.el.scrollIntoView({ block: 'start' })
  }
  private drop(): void {
    if (!this.open) return
    disposeFileViewer(this.open.viewer)
    this.open.viewer.remove()
    this.open = null
  }
  private paintBar(): void {
    const at = this.files.findIndex(file => file.key === this.open?.key), file = this.files[at]
    if (!file) return
    this.name.textContent = file.name
    this.name.title = parseDocKey(file.key)?.path ?? file.name
    this.steps.hidden = this.files.length < 2
    this.count.textContent = `${at + 1} / ${this.files.length}`
    this.prev.disabled = at === 0
    this.next.disabled = at === this.files.length - 1
  }
  /** A file's preview, folded: the top of its page, a click to unfold it. */
  private card(file: UnfoldFile): HTMLButtonElement {
    const made = this.cards.get(file.key)
    if (made) { made.el.title = `Expand ${file.name}`; return made.el }
    const parsed = parseDocKey(file.key)
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'uf-card'
    el.dataset.key = file.key
    el.title = `Expand ${file.name}`
    el.setAttribute('aria-label', el.title)
    const basename = parsed?.path.split('/').pop() ?? file.name
    // Laid out at least as wide as a reading column, drawn to the card's width: wide, it is the page itself.
    const thumbnail: Thumbnail = new Thumbnail({
      key: `unfold:${file.key}`, shuttleBase: this.opts.shuttleBase, className: 'uf-thumb', fallback: file.name,
      file: parsed ? { fullPath: parsed.path, owner: parsed.owner, basename } : undefined,
      get pageWidth() { return Math.max(720, Math.round(el.clientWidth)) },
      priority: () => (this.opts.awake?.() ?? true) && thumbnail.el.isConnected ? 2 : 0,
      distance: () => this.files.findIndex(each => each.key === file.key),
    })
    el.append(thumbnail.el)
    el.addEventListener('click', () => this.unfold(file.key))
    this.cards.set(file.key, { el, thumbnail })
    return el
  }
}
