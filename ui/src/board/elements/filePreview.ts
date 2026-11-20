import type { DocumentKey } from '../workspace/DocumentBridge.js'
import { openActionMenu, type ConversationAction } from '../conversationMenu.js'
import { buildFileViewer, disposeFileViewer, resumeFileViewer, suspendFileViewer } from '../FileViewerPanel.js'
import { forwardDocumentKey } from '../workspace/DocumentBridge.js'
import { documentKind, KIND_GLYPH, parseDocKey, type DocKey } from '../workspace/documents.js'
import { Thumbnail } from '../workspace/Thumbnail.js'
import { timeEl } from './time.js'
import './filePreview.css'

/**
 * A file the previews show: its document key, the name its bar carries, when
 * it was sent, for a card or a row to say, why it was sent when its send said,
 * and whether it is unread.
 */
export interface UnfoldFile { key: DocKey; name: string; at?: number; caption?: string; unread?: boolean }

/**
 * How a file's preview is drawn, by what it is: a figure (an image or an SVG
 * plot), a page (HTML: a tapestry, a report, a deck), and a card for anything
 * without a picture.
 */
export type FileDensity = 'figure' | 'page' | 'card'

/** A file's density in a post's previews, by its kind alone. */
export function densityOf(path: string): FileDensity {
  const kind = documentKind(path)
  return kind === 'image' ? 'figure' : kind === 'html' ? 'page' : 'card'
}

/** The gap between a post's previews and a card's height in CSS pixels, as filePreview.css sets them. */
export const PREVIEW_GAP = 8
export const CARD_PX = 56
/** A folded figure's or page's height, as filePreview.css caps it: about a third of the screen, 300px at most. */
export const foldPx = (): number => Math.min(300, 0.33 * window.innerHeight)

/**
 * How tall these files' folded previews stand before any of them loads: each
 * on a line of its own, a figure or a page at the fold's height and a card
 * at its own.
 */
export function previewsHeight(paths: readonly string[], fold = foldPx()): number {
  return paths.reduce((sum, path) => sum + (densityOf(path) === 'card' ? CARD_PX : fold), 0) + PREVIEW_GAP * Math.max(0, paths.length - 1)
}

export interface UnfoldOptions {
  shuttleBase: string
  /** Folded, only the first file shows; otherwise every one stands in a sideways row, the next peeking at its edge. */
  single?: boolean
  /** Whether its host is on screen: a hidden host loads no previews. */
  awake?(): boolean
  /** A file unfolded, a deliberate look at it. */
  seen?(key: DocKey): void
  /** Called as a file unfolds, once it stands in place and before it takes the keys: a page that keeps one file unfolded at a time folds the others here. */
  opening?(): void
  /** Opens the file in the board's full file viewer, whose way back returns here; without it the bar offers no full screen. */
  full?(key: DocKey): void
  /** Opens a file elsewhere (the reader) when its preview is pressed, instead of unfolding it in place. */
  open?(key: DocKey): void
  /** A link followed in the unfolded file `key`: a board route, or a file beside it. */
  link?(key: DocKey, href: string): void
}

/** A file's face, drawn alike in a card and a row: its kind's glyph, its name, and when it came. */
function face(file: UnfoldFile, now: number): HTMLElement[] {
  const glyph = document.createElement('span'), name = document.createElement('span')
  glyph.className = 'uf-glyph'; glyph.textContent = KIND_GLYPH[documentKind(parseDocKey(file.key)?.path ?? file.name)]
  name.className = 'uf-file-name'; name.textContent = file.name
  return [glyph, name, timeEl(file.at ?? 0, now, 'uf-age')]
}

/**
 * A file as one row of a list, the card's face in a line with its caption
 * under it when its send gave one. Drawn still: the list's item owns the press.
 */
export function fileRow(file: UnfoldFile, now = Date.now()): HTMLElement {
  const row = document.createElement('span')
  row.className = 'uf-file-row'
  row.dataset.key = file.key
  row.toggleAttribute('data-unread', !!file.unread)
  row.append(...face(file, now))
  if (file.caption) row.append(Object.assign(document.createElement('span'), { className: 'uf-caption', textContent: file.caption }))
  return row
}

/**
 * A file's page drawn at its real size in `el`, its preview's box: loaded as
 * it nears the screen and released once well away, and none while `awake`
 * says its host is hidden.
 */
function pagePreview(file: UnfoldFile, el: HTMLElement, opts: { shuttleBase: string; awake?(): boolean }, density?: FileDensity): Thumbnail {
  const parsed = parseDocKey(file.key), path = parsed?.path ?? file.name
  // A post's page is laid out at its card's width, so it is drawn at its real size; a view's lead, at least as wide as a reading column.
  const thumbnail: Thumbnail = new Thumbnail({
    key: `unfold:${file.key}`, shuttleBase: opts.shuttleBase, className: 'uf-thumb', fallback: file.name, keepMedia: true,
    file: parsed ? { fullPath: parsed.path, owner: parsed.owner, basename: path.split('/').pop() ?? file.name } : undefined,
    get pageWidth() { return density ? Math.round(el.clientWidth) || 720 : Math.max(720, Math.round(el.clientWidth)) },
    priority: () => (opts.awake?.() ?? true) ? thumbnail.screenPriority() : 0,
    distance: () => thumbnail.gap(),
  })
  return thumbnail
}

/**
 * A constitution's tapestry in its slot among a post's previews, the slot's
 * size set before the tapestry is looked for: a card, one line, or with
 * `preview`, a page's box showing the top of the tapestry once it is found.
 * The newest look is the one that fills it. A press calls `open`.
 */
export class PageCard {
  readonly el = document.createElement('div')
  private readonly card = document.createElement('button')
  private readonly preview?: { shuttleBase: string; awake?(): boolean }
  private looking?: Promise<UnfoldFile | null | undefined>
  private shown?: { key: DocKey; thumbnail: Thumbnail }

  constructor(open: () => void, preview?: { shuttleBase: string; awake?(): boolean }) {
    this.preview = preview
    const row = document.createElement('div')
    this.el.className = 'uf'
    row.className = 'uf-row'
    Object.assign(this.card, { type: 'button', className: 'uf-card' })
    this.card.dataset.density = preview ? 'page' : 'card'
    this.card.dataset.page = ''
    this.card.addEventListener('click', open)
    const [glyph, name] = face({ key: '' as DocKey, name: 'tapestry.html' }, Date.now())
    name.textContent = 'Tapestry'
    if (!preview) this.card.append(glyph, name)
    this.say('Open the tapestry')
    row.append(this.card)
    this.el.append(row)
  }
  /** Whether it shows the page, not a card. */
  get previews(): boolean { return !!this.preview }
  /** Looks for the page again; the newest look that finds it is the one that fills it. */
  look(found: Promise<UnfoldFile | null | undefined>): void {
    this.looking = found
    void found.then(file => {
      if (this.looking !== found || !file) return
      this.say(`Open ${file.name}`)
      if (!this.preview) { this.card.replaceChildren(...face(file, Date.now())); return }
      if (this.shown?.key === file.key) return
      this.shown?.thumbnail.dispose()
      this.shown = { key: file.key, thumbnail: pagePreview(file, this.card, this.preview, 'page') }
      this.card.replaceChildren(this.shown.thumbnail.el)
    })
  }
  dispose(): void { this.shown?.thumbnail.dispose() }
  private say(label: string): void {
    this.card.title = label
    this.card.setAttribute('aria-label', label)
  }
}

/** An open list of files: its close, and its rows drawn anew from the files as they stand now. */
export interface OpenFileList { close(): void; update(files: readonly UnfoldFile[], current?: DocKey): void }

/** Files as a list under `anchor`, newest first, each row opening its file; `current` marks the one being read. */
export function openFileList(anchor: HTMLElement, files: readonly UnfoldFile[], open: (key: DocKey) => void, current?: DocKey): OpenFileList {
  const rows = (files: readonly UnfoldFile[], current?: DocKey): ConversationAction[] => {
    const now = Date.now()
    return [...files].sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity)).map(file => {
      const content = fileRow(file, now)
      content.toggleAttribute('data-current', file.key === current)
      return { label: file.caption ? `${file.name}: ${file.caption}` : file.name, content, run: () => open(file.key) }
    })
  }
  const menu = openActionMenu(anchor, rows(files, current), `${files.length} ${files.length === 1 ? 'file' : 'files'}`, undefined, true)
  // Drawn anew only when what it lists has changed, so a row under the pointer or the keys stays put.
  let drawn = JSON.stringify([files, current])
  return {
    close: menu.close,
    update: (files, current) => {
      const now = JSON.stringify([files, current])
      if (now !== drawn) { drawn = now; menu.update(rows(files, current)) }
    },
  }
}

/** The bar's two drawn controls, in the stroke the board's icons use. */
const GLYPH = {
  full: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  fold: '<path d="m4 10 4-4 4 4"/>',
}
const glyph = (shape: keyof typeof GLYPH): string =>
  `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[shape]}</svg>`

/**
 * The ground behind `el` as one opaque background: every translucent tint
 * between it and the first opaque ground, laid over that ground, so the
 * pinned bar matches what it covers.
 */
function ground(el: HTMLElement): string {
  const tints: string[] = []
  for (let at: HTMLElement | null = el; at; at = at.parentElement) {
    const color = getComputedStyle(at).backgroundColor
    if (!color || color === 'transparent') continue
    // rgba(r, g, b, a) or a modern colour's `/ a`; without either it is opaque.
    const alpha = Number((/^rgba\(.*,\s*([\d.]+)\)$/.exec(color) ?? /\/\s*([\d.]+%?)\s*\)$/.exec(color))?.[1]?.replace(/%$/, 'e-2') ?? 1)
    if (alpha === 0) continue
    if (alpha >= 1) return [...tints, color].join(', ')
    tints.push(`linear-gradient(${color}, ${color})`)
  }
  return tints.length ? [...tints, 'var(--ws-paper, var(--kbn-paper))'].join(', ') : ''
}

/** The nearest box that scrolls this one. */
function scroller(el: HTMLElement): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at
  return null
}

/**
 * Files as previews that unfold in place, one component wherever a page shows
 * files inline (a constitution's view, a post in a channel). Folded, a single
 * lead (a constitution's view) is a preview capped at about 320px showing the
 * top of its page at the full width it is given; a post's files stand each
 * on a line of its own at the full width given, a page or a figure at the
 * fold's height ({@link foldPx}) and a card without a picture one line,
 * drawn with nothing loaded. A click
 * unfolds that file at its natural height in the same place, the same card
 * grown, under a quiet bar pinned to the top of whatever scrolls it: the
 * file's name, ‹ i / n › when there are several (the count opening the list
 * of them, {@link openFileList}), full screen, and the fold chevron. The bar has no ground of its own until it pins over the file, when
 * it takes its page's ground and a hairline. While one is unfolded, ← and →
 * step to its neighbours, from the page or from inside the file, and Escape
 * folds it, returning to the preview.
 */
export class Unfold {
  readonly el = document.createElement('div')
  private readonly row = document.createElement('div')
  private readonly bar = document.createElement('div')
  private readonly name = document.createElement('span')
  private readonly steps = document.createElement('span')
  private readonly count = document.createElement('button')
  private readonly prev = document.createElement('button')
  private readonly next = document.createElement('button')
  private readonly page = document.createElement('div')
  private files: UnfoldFile[] = []
  private readonly cards = new Map<DocKey, { el: HTMLButtonElement; thumbnail?: Thumbnail }>()
  private open: { key: DocKey; viewer: HTMLElement } | null = null
  /** The list its count last opened, which follows its files while it is open. */
  private list?: OpenFileList
  private readonly opts: UnfoldOptions

  constructor(opts: UnfoldOptions) {
    this.opts = opts
    this.el.className = 'uf'
    this.el.toggleAttribute('data-single', !!opts.single)
    this.row.className = 'uf-row'
    this.bar.className = 'uf-bar'
    this.name.className = 'uf-name'
    this.steps.className = 'uf-steps'
    const control = (button: HTMLButtonElement, text: string, label: string, act: () => void): HTMLButtonElement => {
      button.type = 'button'; button.className = 'uf-control'; button.innerHTML = text
      button.title = label; button.setAttribute('aria-label', label)
      button.addEventListener('click', event => { event.stopPropagation(); act() })
      return button
    }
    control(this.prev, '‹', 'Previous file (←)', () => this.step(-1))
    control(this.next, '›', 'Next file (→)', () => this.step(1))
    control(this.count, '', 'List the files', () => { this.list = openFileList(this.count, this.files, key => this.unfold(key), this.open?.key) })
    this.count.classList.add('uf-count')
    this.steps.append(this.prev, this.count, this.next)
    const full = opts.full && control(document.createElement('button'), glyph('full'), 'Full screen', () => { if (this.open) opts.full!(this.open.key) })
    const fold = control(document.createElement('button'), glyph('fold'), 'Collapse (Esc)', () => this.fold())
    fold.classList.add('uf-fold')
    full?.classList.add('uf-full')
    this.bar.append(this.name, this.steps, ...full ? [full] : [], fold)
    this.page.className = 'uf-page'
    this.page.tabIndex = -1
    this.el.append(this.row)
    this.el.addEventListener('keydown', event => { if (this.key(event.key, event)) { event.preventDefault(); event.stopPropagation() } })
  }
  /** While a file is unfolded, whether its bar stands pinned over it. */
  private readonly pin = (): void => {
    // Out of layout (under the reader), nothing is pinned or unpinned until it shows again.
    if (!this.open || !this.el.getClientRects().length) return
    this.el.toggleAttribute('data-pinned', this.page.getBoundingClientRect().top < this.bar.getBoundingClientRect().bottom - 1)
  }

  /** The files it shows, in order; an unfolded file that is gone folds. */
  update(files: readonly UnfoldFile[]): void {
    this.files = [...files]
    const keys = new Set(files.map(file => file.key))
    for (const [key, card] of this.cards) if (!keys.has(key)) { card.thumbnail?.dispose(); card.el.remove(); this.cards.delete(key) }
    const shown = this.opts.single ? this.files.slice(0, 1) : this.files, cards = shown.map(file => this.card(file))
    // The same cards stay where they stand: moving one reloads its page, drops its focus and resets the row's scroll.
    if (cards.length !== this.row.children.length || cards.some((card, i) => this.row.children[i] !== card)) this.row.replaceChildren(...cards)
    this.el.hidden = !files.length
    this.el.toggleAttribute('data-several', shown.length > 1)
    if (this.open && !keys.has(this.open.key)) this.fold(false)
    else if (this.open) this.paintBar()
    this.list?.update(this.files, this.open?.key)
  }
  /** Gives the keys to the unfolded file, if one is; false when none is. */
  focus(): boolean {
    if (!this.open) return false
    this.page.focus({ preventScroll: true })
    return true
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
      onNavigate: href => this.opts.link?.(key, href),
      // Keys from inside the file: its own steps and fold, else the board's, replayed from its place.
      onDocumentKey: (pressed: DocumentKey) => {
        const plain = !pressed.altKey && !pressed.ctrlKey && !pressed.metaKey && !pressed.shiftKey
        if (!plain || !this.key(pressed.key)) forwardDocumentKey(this.page, pressed, viewer.querySelector('iframe'))
      },
    })
    this.open = { key, viewer }
    this.page.dataset.kind = kind
    this.page.dataset.key = key
    this.page.replaceChildren(viewer)
    this.el.setAttribute('data-unfolded', '')
    this.el.replaceChildren(this.bar, this.page)
    // Grown first, so a fold elsewhere that the page then answers has room to scroll.
    this.opts.opening?.()
    this.el.style.setProperty('--uf-ground', ground(this.el))
    document.addEventListener('scroll', this.pin, { capture: true, passive: true })
    this.pin()
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
  resume(): void { if (this.open) { resumeFileViewer(this.open.viewer); this.pin() } }
  dispose(): void {
    this.drop()
    for (const card of this.cards.values()) card.thumbnail?.dispose()
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
    document.removeEventListener('scroll', this.pin, { capture: true })
    this.el.removeAttribute('data-pinned')
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
    this.count.title = `File ${at + 1} of ${this.files.length}: list them`
    this.count.setAttribute('aria-label', this.count.title)
    this.prev.disabled = at === 0
    this.next.disabled = at === this.files.length - 1
  }
  /** A file's preview, folded: the top of its page, or a card naming it, and a click to unfold it. */
  private card(file: UnfoldFile): HTMLButtonElement {
    const made = this.cards.get(file.key)
    if (made) {
      made.el.title = `${this.opts.open ? 'Open' : 'Expand'} ${file.name}`
      // A card sent again says when it last came.
      made.el.querySelector('.uf-age')?.replaceWith(timeEl(file.at ?? 0, Date.now(), 'uf-age'))
      return made.el
    }
    const parsed = parseDocKey(file.key), path = parsed?.path ?? file.name
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'uf-card'
    el.dataset.key = file.key
    el.title = `${this.opts.open ? 'Open' : 'Expand'} ${file.name}`
    el.setAttribute('aria-label', el.title)
    el.addEventListener('click', () => this.opts.open ? this.opts.open(file.key) : this.unfold(file.key))
    const density = this.opts.single ? undefined : densityOf(path)
    if (density) el.dataset.density = density
    if (density === 'card') {
      // Nothing to see before it opens: its kind, its name and when it came, and nothing loads.
      el.append(...face(file, Date.now()))
      this.cards.set(file.key, { el })
      return el
    }
    const thumbnail = pagePreview(file, el, this.opts, density)
    el.append(thumbnail.el)
    this.cards.set(file.key, { el, thumbnail })
    return el
  }
}
