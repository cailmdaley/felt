/**
 * The Desk's preview: a row opens, over the column beside its own, into the
 * full card it stands for and a gallery of what it sent.
 *
 * One panel serves the whole Desk. Its content is built when it opens, never
 * per row, so a Desk of fifty rows costs fifty rows. The timing follows the
 * tooltip convention: the first preview waits for the pointer to settle, and
 * while one is showing (or has just closed) the next row answers almost at
 * once, so running the pointer down a column reads card after card without
 * waiting on each.
 *
 * A row in one of the Now columns previews in its neighbour's exact frame —
 * Drafts and Awaiting review over In flight, In flight over Awaiting review —
 * so the panel is a sheet of the Desk rather than a balloon over it, and moving
 * between rows swaps its content in place. A row with no neighbour on screen
 * (a Resting or Roles line, the phone's one-column pager) gets a panel beside
 * itself instead.
 *
 * The panel is a place: the pointer can cross from the row into it, read,
 * scroll and click. It stays open while the pointer is on the row or the
 * panel; crossing the gap between them is covered by a short close grace, and
 * a pointer heading for the panel passes over other rows without switching to
 * them. Escape, a press anywhere outside it, or leaving both closes it.
 *
 * The keyboard reaches it through the Desk's selection: the selected row
 * previews after the same settle, and follows the selection as it moves.
 */

export interface PreviewContent {
  el: HTMLElement
  /** Release what the content holds (live thumbnails) when it leaves. */
  dispose?: () => void
  /**
   * Repaint in place for the same card's rebuilt row, keeping what is costly
   * to rebuild. False when the content cannot follow, and is built afresh.
   */
  refresh?: (row: HTMLElement) => boolean
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
  /** A row crossed on the way to the panel answers only if the pointer stays on it this long. */
  aim: 320,
  /** Grace before closing, long enough to cross from a row into the panel. */
  close: 180,
  /** How long after closing the next row still opens warm. */
  warmWindow: 450,
} as const

/** Which Now column a row's preview covers. */
export const PREVIEW_NEIGHBOUR: Readonly<Record<string, string>> = {
  drafts: 'inFlight',
  inFlight: 'awaitingReview',
  awaitingReview: 'inFlight',
}

export type PreviewSide = 'right' | 'left' | 'below' | 'above'

export interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }
export interface Point { x: number; y: number }

/**
 * The frame a column-sized preview takes: the neighbour column's own box, cut
 * to the viewport where the Desk has scrolled it partly away. Null when the
 * neighbour is not there to cover — off to the side in the phone's pager, too
 * narrow, or mostly scrolled out of sight — and the panel floats instead.
 */
export function columnFrame(
  column: Rect,
  viewport: { width: number; height: number },
  { minWidth = 240, minHeight = 200 }: { minWidth?: number; minHeight?: number } = {},
): Rect | null {
  if (column.width < minWidth) return null
  if (column.left < -0.5 || column.right > viewport.width + 0.5) return null
  const top = Math.max(0, column.top)
  const bottom = Math.min(viewport.height, column.bottom)
  if (bottom - top < minHeight) return null
  return { left: column.left, top, right: column.right, bottom, width: column.width, height: bottom - top }
}

/**
 * Whether a pointer moving from `from` to `to` is heading for `target`: the
 * move points inside the triangle spanned by `from` and the target's near
 * edge. A pointer inside the target's horizontal span is not aiming across.
 */
export function headingToward(from: Point, to: Point, target: Rect): boolean {
  const dx = to.x - from.x
  const dy = to.y - from.y
  let reach: number
  if (target.left >= from.x) {
    if (dx <= 0) return false
    reach = target.left - from.x
  } else if (target.right <= from.x) {
    if (dx >= 0) return false
    reach = from.x - target.right
  } else return false
  const slope = dy / Math.abs(dx)
  const r = Math.max(reach, 1)
  return slope >= (target.top - from.y) / r && slope <= (target.bottom - from.y) / r
}

/**
 * Where a floating panel goes: beside the row, on whichever side has room
 * (right first, the direction a column reads into), top-aligned with the row
 * and kept inside the viewport. With no room on either side — a narrow window
 * — it drops below the row, or above when below is shorter.
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

/** How far back the pointer's trail reaches when judging where it is heading. */
const TRAIL_MS = 90

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
  /** The preview row under the pointer, if any. */
  private hoverRow: HTMLElement | null = null
  private overPanel = false
  /** Recent pointer positions, oldest first, while a preview is open. */
  private trail: Array<Point & { t: number }> = []
  private disposed = false

  constructor(options: CardPreviewOptions) {
    this.o = options
    this.panel = document.createElement('div')
    this.panel.className = 'kbn-preview'
    this.panel.id = `kbn-preview-${++panelSeq}`
    this.panel.setAttribute('role', 'region')
    this.panel.hidden = true
    options.host.append(this.panel)
    this.panel.addEventListener('pointerenter', this.onPanelEnter)
    this.panel.addEventListener('pointerleave', this.onPanelLeave)
    const root = options.root
    root.addEventListener('pointerover', this.onPointerOver)
    root.addEventListener('pointerout', this.onPointerOut)
    root.addEventListener('dragstart', this.onPress, true)
    document.addEventListener('pointerdown', this.onPress, true)
    document.addEventListener('pointermove', this.onPointerMove, { capture: true, passive: true })
    document.addEventListener('scroll', this.onScroll, true)
    document.addEventListener('keydown', this.onKey, true)
    window.addEventListener('resize', this.onResize)
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
    root.removeEventListener('dragstart', this.onPress, true)
    document.removeEventListener('pointerdown', this.onPress, true)
    document.removeEventListener('pointermove', this.onPointerMove, true)
    document.removeEventListener('scroll', this.onScroll, true)
    document.removeEventListener('keydown', this.onKey, true)
    window.removeEventListener('resize', this.onResize)
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
    if (this.hoverRow && !this.hoverRow.isConnected) this.hoverRow = find(this.hoverRow)
    if (!this.anchor || this.anchor.isConnected) return
    const next = find(this.anchor)
    if (!next) { this.hide(); return }
    if (this.content?.refresh?.(next)) {
      this.anchor.removeAttribute('aria-details')
      this.anchor = next
      next.setAttribute('aria-details', this.panel.id)
      this.place()
    } else this.show(next, this.source)
  }

  /** Close now. */
  hide(): void {
    clearTimeout(this.hideTimer); this.hideTimer = undefined
    if (!this.anchor) return
    this.anchor.removeAttribute('aria-details')
    this.anchor = null
    this.closedAt = performance.now()
    this.overPanel = false
    this.trail = []
    this.content?.dispose?.()
    this.content = null
    if (typeof this.panel.hidePopover === 'function' && this.panel.matches(':popover-open')) this.panel.hidePopover()
    this.panel.hidden = true
    this.panel.replaceChildren()
  }

  private warm(): boolean {
    return this.anchor !== null || performance.now() - this.closedAt < PREVIEW_TIMING.warmWindow
  }

  private schedule(row: HTMLElement, source: 'pointer' | 'keyboard', delay?: number): void {
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
      else this.reconcile()
    }, delay ?? (this.warm() ? PREVIEW_TIMING.warm : PREVIEW_TIMING.open))
  }

  private cancelShow(): void {
    clearTimeout(this.showTimer); this.showTimer = undefined
    this.pending = null
  }

  private scheduleHide(): void {
    if (this.hideTimer !== undefined) return
    this.hideTimer = setTimeout(() => { this.hideTimer = undefined; this.hide() }, PREVIEW_TIMING.close)
  }

  /**
   * A pointer preview stays while the pointer is on its row or on the panel,
   * or while a switch to another row is pending; otherwise it starts to close.
   */
  private reconcile(): void {
    if (!this.anchor || this.source !== 'pointer') return
    if (this.overPanel || this.hoverRow === this.anchor || this.pending) {
      clearTimeout(this.hideTimer); this.hideTimer = undefined
      return
    }
    this.scheduleHide()
  }

  private show(row: HTMLElement, source: 'pointer' | 'keyboard'): void {
    const content = this.o.build(row)
    if (!content) { this.hide(); return }
    const wasOpen = this.anchor !== null
    this.anchor?.removeAttribute('aria-details')
    this.content?.dispose?.()
    this.content = content
    this.anchor = row
    this.source = source
    row.setAttribute('aria-details', this.panel.id)
    const name = row.querySelector('.kbn-card-name')?.textContent?.trim()
    this.panel.setAttribute('aria-label', name ? `Preview: ${name}` : 'Preview')
    this.panel.replaceChildren(content.el)
    this.panel.hidden = false
    this.panel.toggleAttribute('data-warm', wasOpen)
    if (typeof this.panel.showPopover === 'function') {
      if (!this.panel.hasAttribute('popover')) this.panel.setAttribute('popover', 'manual')
      if (!this.panel.matches(':popover-open')) this.panel.showPopover()
    }
    this.place()
    this.reconcile()
  }

  private viewport(): { width: number; height: number } {
    return {
      width: document.documentElement.clientWidth || window.innerWidth,
      height: document.documentElement.clientHeight || window.innerHeight,
    }
  }

  /** The neighbour column's frame for `row`, or null when the panel floats. */
  private frameFor(row: HTMLElement): Rect | null {
    const own = row.closest<HTMLElement>('.kbn-col[data-column]')?.dataset.column
    const target = own ? PREVIEW_NEIGHBOUR[own] : undefined
    const column = target ? this.o.root.querySelector<HTMLElement>(`.kbn-col[data-column="${target}"]`) : null
    return column ? columnFrame(column.getBoundingClientRect(), this.viewport()) : null
  }

  private place(): void {
    if (!this.anchor) return
    const style = this.panel.style
    const frame = this.frameFor(this.anchor)
    if (frame) {
      this.panel.dataset.frame = 'column'
      delete this.panel.dataset.side
      style.left = `${Math.round(frame.left)}px`
      style.top = `${Math.round(frame.top)}px`
      style.width = `${Math.round(frame.width)}px`
      style.height = `${Math.round(frame.height)}px`
      return
    }
    this.panel.dataset.frame = 'float'
    style.width = ''
    style.height = ''
    const rect = this.anchor.getBoundingClientRect()
    const box = this.panel.getBoundingClientRect()
    const { left, top, side } = placePreview(rect, { width: box.width, height: box.height }, this.viewport())
    style.left = `${Math.round(left)}px`
    style.top = `${Math.round(top)}px`
    this.panel.dataset.side = side
  }

  private rowAt(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) return null
    const row = target.closest<HTMLElement>(PREVIEW_ROW_SELECTOR)
    return row && this.o.root.contains(row) ? row : null
  }

  /** Whether the pointer, by its recent trail, is on its way into the open panel. */
  private aimingAtPanel(e: PointerEvent): boolean {
    if (!this.anchor || this.panel.hidden || !this.trail.length) return false
    return headingToward(this.trail[0], { x: e.clientX, y: e.clientY }, this.panel.getBoundingClientRect())
  }

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (!this.anchor || e.pointerType !== 'mouse') return
    const t = e.timeStamp
    this.trail.push({ x: e.clientX, y: e.clientY, t })
    while (this.trail.length > 2 && t - this.trail[1].t > TRAIL_MS) this.trail.shift()
  }

  private readonly onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const row = this.rowAt(e.target)
    this.hoverRow = row
    if (!row || row === this.suppressed) { this.reconcile(); return }
    this.suppressed = null
    if (row === this.anchor) {
      this.cancelShow()
      this.reconcile()
      return
    }
    const crossing = this.anchor !== null && this.source === 'pointer' && this.aimingAtPanel(e)
    this.schedule(row, 'pointer', crossing ? PREVIEW_TIMING.aim : undefined)
  }

  private readonly onPointerOut = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const from = this.rowAt(e.target)
    const to = this.rowAt(e.relatedTarget)
    if (!from || from === to) return
    this.hoverRow = to
    if (from === this.suppressed) this.suppressed = null
    if (from === this.pending) this.cancelShow()
    this.reconcile()
  }

  private readonly onPanelEnter = (): void => {
    this.overPanel = true
    this.cancelShow()
    this.reconcile()
  }

  private readonly onPanelLeave = (): void => {
    this.overPanel = false
    this.reconcile()
  }

  private readonly onPress = (e: Event): void => {
    if (e.target instanceof Node && this.panel.contains(e.target)) return
    const row = this.rowAt(e.target)
    this.cancelShow()
    this.hide()
    this.suppressed = row
  }

  private readonly onScroll = (e: Event): void => {
    if (e.target instanceof Node && this.panel.contains(e.target)) return
    // A column-framed panel follows its column; a floating one under the
    // pointer has lost its row. A keyboard move scrolls its row into view, and
    // that scroll must not cancel the preview it asked for.
    if (this.anchor && this.source === 'pointer' && this.panel.dataset.frame !== 'column') this.hide()
    else if (this.anchor) this.place()
    if (this.pendingSource === 'pointer') this.cancelShow()
  }

  private readonly onResize = (): void => { this.place() }

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
