/**
 * The Desk's hover preview: a compact row grows, beside itself, into the full
 * card it stands for.
 *
 * One panel serves the whole Desk. Its content is built when it opens, never
 * per row, so a Desk of fifty rows costs fifty rows. The timing follows the
 * tooltip convention: the first preview waits for the pointer to settle, and
 * while one is showing (or has just closed) the next row answers almost at
 * once, so running the pointer down a column reads card after card without
 * waiting on each. The panel never takes the pointer — it is a reading, not a
 * place — so it cannot trap hover or hide the row under it from a click.
 *
 * The keyboard reaches it through the Desk's selection: the selected row
 * previews after the same settle, and follows the selection as it moves.
 */

export interface PreviewContent {
  el: HTMLElement
  /** Release what the content holds (a live thumbnail) when it leaves. */
  dispose?: () => void
}

export interface CardPreviewOptions {
  /** The Desk: rows are found under it by delegation. */
  root: HTMLElement
  /** Where the panel lives. It must outlive the Desk's rebuilds. */
  host: HTMLElement
  /** Build the preview for a row, or null when the row has none. */
  build: (row: HTMLElement) => PreviewContent | null
}

/** Rows that preview: Desk cards and Resting lines. */
export const PREVIEW_ROW_SELECTOR = '.kbn-col .kbn-card[data-card-uid], .kbn-cluster-item[data-card-uid]'

export const PREVIEW_TIMING = {
  /** Pointer settle before the first preview. */
  open: 420,
  /** Hop between rows while a preview is showing or just closed. */
  warm: 70,
  /** Grace before closing, so a pointer crossing the gap between rows does not blink the panel. */
  close: 120,
  /** How long after closing the next row still opens warm. */
  warmWindow: 450,
} as const

export type PreviewSide = 'right' | 'left' | 'below' | 'above'

interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }

/**
 * Where the panel goes: beside the row, on whichever side has room (right
 * first, the direction a column reads into), top-aligned with the row and kept
 * inside the viewport. With no room on either side — a narrow window — it
 * drops below the row, or above when below is shorter.
 */
export function placePreview(
  anchor: Rect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { gap = 10, margin = 8 }: { gap?: number; margin?: number } = {},
): { left: number; top: number; side: PreviewSide } {
  const clampTop = (top: number): number => Math.max(margin, Math.min(top, viewport.height - margin - size.height))
  const clampLeft = (left: number): number => Math.max(margin, Math.min(left, viewport.width - margin - size.width))
  const roomRight = viewport.width - margin - anchor.right - gap
  const roomLeft = anchor.left - gap - margin
  if (roomRight >= size.width) return { left: anchor.right + gap, top: clampTop(anchor.top), side: 'right' }
  if (roomLeft >= size.width) return { left: anchor.left - gap - size.width, top: clampTop(anchor.top), side: 'left' }
  const below = viewport.height - margin - anchor.bottom - gap
  const above = anchor.top - gap - margin
  if (below >= size.height || below >= above) {
    return { left: clampLeft(anchor.left), top: Math.min(anchor.bottom + gap, Math.max(margin, viewport.height - margin - size.height)), side: 'below' }
  }
  return { left: clampLeft(anchor.left), top: Math.max(margin, anchor.top - gap - size.height), side: 'above' }
}

const rowKey = (row: HTMLElement): string => `${row.dataset.cardOrigin ?? ''}\u0000${row.dataset.cardUid ?? ''}`

let panelSeq = 0

export class CardPreview {
  readonly panel: HTMLElement
  private readonly o: CardPreviewOptions
  private anchor: HTMLElement | null = null
  private content: PreviewContent | null = null
  /** Who opened the preview: a keyboard preview ignores the pointer leaving. */
  private source: 'pointer' | 'keyboard' = 'pointer'
  private showTimer: ReturnType<typeof setTimeout> | undefined
  private hideTimer: ReturnType<typeof setTimeout> | undefined
  private pending: HTMLElement | null = null
  private pendingSource: 'pointer' | 'keyboard' = 'pointer'
  private closedAt = -Infinity
  /** A row the reader pressed or escaped: it stays quiet until the pointer leaves it. */
  private suppressed: HTMLElement | null = null
  private disposed = false

  constructor(options: CardPreviewOptions) {
    this.o = options
    this.panel = document.createElement('div')
    this.panel.className = 'kbn-preview'
    this.panel.id = `kbn-preview-${++panelSeq}`
    this.panel.setAttribute('role', 'tooltip')
    this.panel.hidden = true
    options.host.append(this.panel)
    const root = options.root
    root.addEventListener('pointerover', this.onPointerOver)
    root.addEventListener('pointerout', this.onPointerOut)
    root.addEventListener('pointerdown', this.onPress, true)
    root.addEventListener('dragstart', this.onPress, true)
    root.addEventListener('scroll', this.onScroll, true)
    document.addEventListener('keydown', this.onKey, true)
    window.addEventListener('blur', this.onWindowBlur)
  }

  get openRow(): HTMLElement | null { return this.anchor }
  get isOpen(): boolean { return this.anchor !== null }

  dispose(): void {
    this.disposed = true
    this.hide()
    this.cancelShow()
    const root = this.o.root
    root.removeEventListener('pointerover', this.onPointerOver)
    root.removeEventListener('pointerout', this.onPointerOut)
    root.removeEventListener('pointerdown', this.onPress, true)
    root.removeEventListener('dragstart', this.onPress, true)
    root.removeEventListener('scroll', this.onScroll, true)
    document.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('blur', this.onWindowBlur)
    this.panel.remove()
  }

  /** The Desk's keyboard selection moved to `row`, or cleared. */
  select(row: HTMLElement | null): void {
    if (this.disposed) return
    if (!row) {
      if (this.source === 'keyboard') this.hide()
      this.cancelShow()
      return
    }
    if (row === this.anchor) { this.source = 'keyboard'; return }
    this.schedule(row, 'keyboard')
  }

  /**
   * The Desk rebuilt its rows. An open preview moves onto the row that now
   * stands for the same card, with content rebuilt from the fresh data, or
   * closes when that card has left the Desk.
   */
  rerendered(): void {
    if (this.disposed) return
    const find = (old: HTMLElement | null): HTMLElement | null => {
      if (!old || old.isConnected) return old
      const key = rowKey(old)
      return [...this.o.root.querySelectorAll<HTMLElement>(PREVIEW_ROW_SELECTOR)].find(row => rowKey(row) === key) ?? null
    }
    if (this.pending && !this.pending.isConnected) {
      const next = find(this.pending)
      if (next) this.pending = next
      else this.cancelShow()
    }
    if (this.suppressed && !this.suppressed.isConnected) this.suppressed = find(this.suppressed)
    if (!this.anchor || this.anchor.isConnected) return
    const next = find(this.anchor)
    if (next) this.show(next, this.source)
    else this.hide()
  }

  /** Close now. */
  hide(): void {
    clearTimeout(this.hideTimer); this.hideTimer = undefined
    if (!this.anchor) return
    this.anchor.removeAttribute('aria-describedby')
    this.anchor = null
    this.closedAt = performance.now()
    this.content?.dispose?.()
    this.content = null
    if (typeof this.panel.hidePopover === 'function' && this.panel.matches(':popover-open')) this.panel.hidePopover()
    this.panel.hidden = true
    this.panel.replaceChildren()
  }

  private warm(): boolean {
    return this.anchor !== null || performance.now() - this.closedAt < PREVIEW_TIMING.warmWindow
  }

  private schedule(row: HTMLElement, source: 'pointer' | 'keyboard'): void {
    clearTimeout(this.hideTimer); this.hideTimer = undefined
    if (this.pending === row) return
    this.cancelShow()
    this.pending = row
    this.pendingSource = source
    this.showTimer = setTimeout(() => {
      this.showTimer = undefined
      const target = this.pending
      this.pending = null
      if (target?.isConnected) this.show(target, source)
    }, this.warm() ? PREVIEW_TIMING.warm : PREVIEW_TIMING.open)
  }

  private cancelShow(): void {
    clearTimeout(this.showTimer); this.showTimer = undefined
    this.pending = null
  }

  private scheduleHide(): void {
    if (this.hideTimer !== undefined) return
    this.hideTimer = setTimeout(() => { this.hideTimer = undefined; this.hide() }, PREVIEW_TIMING.close)
  }

  private show(row: HTMLElement, source: 'pointer' | 'keyboard'): void {
    const content = this.o.build(row)
    if (!content) { this.hide(); return }
    const wasOpen = this.anchor !== null
    this.anchor?.removeAttribute('aria-describedby')
    this.content?.dispose?.()
    this.content = content
    this.anchor = row
    this.source = source
    row.setAttribute('aria-describedby', this.panel.id)
    this.panel.replaceChildren(content.el)
    this.panel.hidden = false
    this.panel.toggleAttribute('data-warm', wasOpen)
    if (typeof this.panel.showPopover === 'function') {
      if (!this.panel.hasAttribute('popover')) this.panel.setAttribute('popover', 'manual')
      if (!this.panel.matches(':popover-open')) this.panel.showPopover()
    }
    this.place()
  }

  private place(): void {
    if (!this.anchor) return
    const rect = this.anchor.getBoundingClientRect()
    const box = this.panel.getBoundingClientRect()
    const viewport = {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    }
    const { left, top, side } = placePreview(rect, { width: box.width, height: box.height }, viewport)
    this.panel.style.left = `${Math.round(left)}px`
    this.panel.style.top = `${Math.round(top)}px`
    this.panel.dataset.side = side
  }

  private rowAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null
    const row = target.closest<HTMLElement>(PREVIEW_ROW_SELECTOR)
    return row && this.o.root.contains(row) ? row : null
  }

  private readonly onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const row = this.rowAt(e.target)
    if (!row) return
    if (row === this.suppressed) return
    this.suppressed = null
    if (row === this.anchor) {
      clearTimeout(this.hideTimer); this.hideTimer = undefined
      return
    }
    this.schedule(row, 'pointer')
  }

  private readonly onPointerOut = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const from = this.rowAt(e.target)
    if (!from || from === this.rowAt(e.relatedTarget)) return
    if (from === this.suppressed) this.suppressed = null
    if (from === this.pending) this.cancelShow()
    if (from === this.anchor && this.source === 'pointer') this.scheduleHide()
  }

  private readonly onPress = (e: Event): void => {
    const row = this.rowAt(e.target)
    this.cancelShow()
    this.hide()
    this.suppressed = row
  }

  private readonly onScroll = (): void => {
    // A keyboard move scrolls its row into view; that scroll must not cancel the preview it asked for.
    if (this.anchor && this.source === 'pointer') this.hide()
    else if (this.anchor) this.place()
    if (this.pendingSource === 'pointer') this.cancelShow()
  }

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || !this.anchor) return
    this.suppressed = this.anchor
    this.hide()
  }

  private readonly onWindowBlur = (): void => {
    this.cancelShow()
    this.hide()
  }
}
