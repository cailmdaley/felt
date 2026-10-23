import type { KeyIntent } from '../keymap.js'
import { isDeclared, KIND_GLYPH, type Channel, type WorkspaceDocument } from './documents.js'
import { probeDocumentTitles } from './titleProbe.js'
import './tabs.css'
import { ReceiptMotion } from './receiptMotion.js'

export const TAB_CROSSING_MS = 280
/** The first hover waits this long before naming a tile; its neighbours are named at once while a name shows. */
export const TIP_DELAY_MS = 360
/** Sent attachments (documents the body neither embeds nor links) a channel's strip shows before folding the rest behind a +N tile. */
export const SENT_TILE_CAP = 3

/** A sent attachment: sent to the channel and not declared in its body. */
export function isSentAttachment(doc: WorkspaceDocument): boolean {
  return doc.kind !== 'fiber' && !isDeclared(doc) && doc.provenance.some(p => p.kind === 'sent')
}

/**
 * Clamp the scroll offset that puts a tab's centre at `focus` inside a
 * horizontally scrolling strip (by default, the strip's own centre).
 */
export function centeredScrollLeft(tabLeft: number, tabWidth: number, viewportWidth: number, contentWidth: number, focus = viewportWidth / 2): number {
  const maximum = Math.max(0, contentWidth - viewportWidth)
  const centred = tabLeft + tabWidth / 2 - focus
  return Math.max(0, Math.min(maximum, centred))
}

function cubicBezier(x: number, x1: number, y1: number, x2: number, y2: number): number {
  const coordinate = (t: number, a: number, b: number): number =>
    3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t ** 2 * b + t ** 3
  const derivative = (t: number, a: number, b: number): number =>
    3 * (1 - t) ** 2 * a + 6 * (1 - t) * t * (b - a) + 3 * t ** 2 * (1 - b)
  let t = x
  for (let i = 0; i < 6; i++) {
    const error = coordinate(t, x1, x2) - x
    const slope = derivative(t, x1, x2)
    if (Math.abs(error) < 1e-5 || Math.abs(slope) < 1e-5) break
    t = Math.max(0, Math.min(1, t - error / slope))
  }
  return coordinate(t, y1, y2)
}

function easeCrossing(progress: number): number {
  return cubicBezier(Math.max(0, Math.min(1, progress)), 0.25, 0.1, 0.25, 1)
}

/**
 * The words a tile's face shows. The fiber's own page is its § mark; a label
 * that is a file's name drops its extension (the kind mark names the kind)
 * unless that would make two captions alike.
 */
export function indexCaptions(labels: string[], channel?: Pick<Channel, 'documents'>): string[] {
  const captions = labels.map((label, index) => {
    const doc = channel?.documents[index]
    if (doc?.kind === 'fiber') return '§'
    const extension = doc?.name.match(/\.[^./]+$/)?.[0]
    return doc && extension && label.endsWith(doc.name) && label.length > extension.length ? label.slice(0, -extension.length) : label
  })
  const counts = new Map<string, number>()
  for (const caption of captions) counts.set(caption, (counts.get(caption) ?? 0) + 1)
  return captions.map((caption, index) => caption !== '§' && (counts.get(caption) ?? 0) > 1 ? labels[index] : caption)
}

/** The chat's tab mark: a quotation, the conversation. */
export const CHAT_GLYPH = '❝'

type TabRecord = { key: string; label: string; docIndex: number; button: HTMLButtonElement; caption: string; doc?: WorkspaceDocument }
interface StripOptions { shuttleBase: string }

/**
 * The reader's map of pages: one roving-focus tablist of compact text tabs in
 * the running head, in the run's order, whose selected tab stays over the
 * page's centre through one interruptible crossing. A tab is a small kind mark
 * and its page's name, truncated; the constitution's own page is its § alone.
 */
export class TabStrip {
  readonly el: HTMLDivElement
  /** The hovered tile's name; the reader sets it beneath the head, outside the strip's mask. */
  readonly tip: HTMLDivElement
  private readonly onSelect: (index: number) => void
  private readonly onExpand: () => void
  private readonly motion: MediaQueryList | null
  private readonly receiptMotion = new ReceiptMotion()
  private records: TabRecord[] = []
  private selectedIndex = -1
  private animationFrame: number | null = null
  private animationTarget = 0
  private layoutFrame: number | null = null
  private pendingMark: { animate: boolean; start: number } | null = null
  private disposed = false
  private visible = true
  private tipTimer: ReturnType<typeof setTimeout> | null = null
  private tipFor: HTMLButtonElement | null = null
  private tipWarmUntil = 0
  private channel: Channel | null = null
  /** The last full run handed to `render`, including documents folded behind the +N tile. */
  private input: { labels: string[]; keys?: string[]; channel?: Channel } | null = null
  private channelId: string | null = null
  private expanded = false
  private selectedKey: string | null = null
  private expandTile: HTMLButtonElement | null = null
  private focus: number | null = null
  private readonly shuttleBase: string | null

  constructor(onSelect: (index: number) => void, onExpand: () => void, options?: StripOptions) {
    this.onSelect = onSelect
    this.onExpand = onExpand
    this.el = document.createElement('div')
    this.el.className = 'ws-tabs'
    this.el.dataset.part = 'tab-strip'
    this.el.setAttribute('role', 'tablist')
    this.el.setAttribute('aria-label', 'Documents')
    this.shuttleBase = options?.shuttleBase ?? null
    this.tip = document.createElement('div')
    this.tip.className = 'ws-tab-tip'
    this.tip.dataset.part = 'tab-tip'
    this.tip.setAttribute('aria-hidden', 'true')
    this.tip.hidden = true
    this.motion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    this.el.addEventListener('pointerover', this.onPointerOver)
    this.el.addEventListener('pointerleave', this.onPointerLeave)
    this.el.addEventListener('pointerdown', this.hideTip)
    document.addEventListener('keydown', this.hideTip, true)
    this.el.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.onResize)
    this.motion?.addEventListener('change', this.onMotionChange)
  }

  /** Current buttons, exposed for keyboard integrations and focused tests. */
  get buttons(): HTMLButtonElement[] {
    return this.records.map((record) => record.button)
  }

  fresh(keys: ReadonlySet<string>): void {
    for (const { key, button } of this.records) button.classList.toggle('ws-tab-fresh', keys.has(key))
  }

  arrive(keys: ReadonlySet<string>): void {
    if (!this.visible) return
    for (const record of this.records) if (keys.has(record.key)) this.receiptMotion.tab(record.button)
  }

  /** The selected tile's width, so the reader can keep it whole inside the strip. */
  get selectedWidth(): number { return this.records[this.selectedIndex]?.button.offsetWidth ?? 0 }

  /** Where, inside the strip, the selected tile's centre belongs; null centres it. */
  setFocus(x: number | null): void {
    if (this.focus === x) return
    this.focus = x
    // The strip's ends are padded to the focus, so the first and last tiles can reach it too.
    if (x === null) { this.el.style.removeProperty('--ws-strip-start'); this.el.style.removeProperty('--ws-strip-end') }
    else { this.el.style.setProperty('--ws-strip-start', `${x}px`); this.el.style.setProperty('--ws-strip-end', `calc(100% - ${x}px)`) }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) this.hideTip()
  }

  /**
   * Draw the run. Given a channel, a channel's sent attachments beyond the
   * newest `SENT_TILE_CAP` stay unmounted behind a +N tile until revealed; the
   * selected document is never one of them.
   */
  render(allLabels: string[], allKeys?: string[], channel?: Channel): void {
    if (this.disposed) return
    this.input = { labels: allLabels, keys: allKeys, channel }
    const channelId = channel ? `${channel.owner}\u0000${channel.uid}` : null
    if (channelId !== this.channelId) { this.channelId = channelId; this.expanded = false; this.selectedKey = null }
    if (channel) this.channel = channel
    if (channel && this.shuttleBase !== null) probeDocumentTitles(this.shuttleBase, channel.documents)
    const shown = this.shownIndices(allLabels, allKeys, channel)
    const labels = shown.map(i => allLabels[i])
    const keys = allKeys && shown.map(i => allKeys[i])
    const docs = channel && shown.map(i => channel.documents[i])
    const hiddenCount = allLabels.length - shown.length
    const captions = indexCaptions(labels, docs && { documents: docs })
    if (labels.length === this.records.length && labels.every((label, index) => label === this.records[index].label && (!keys || keys[index] === this.records[index].key))) {
      this.records.forEach((record, index) => {
        record.caption = captions[index]
        record.docIndex = shown[index]
        record.doc = docs?.[index] ?? record.doc
        this.paint(record)
      })
      this.syncExpandTile(hiddenCount)
      return
    }

    const active = document.activeElement instanceof HTMLButtonElement && this.el.contains(document.activeElement)
      ? this.records.find((record) => record.button === document.activeElement)?.key
      : undefined
    const oldSelectedKey = this.records[this.selectedIndex]?.key
    const available = new Map<string, TabRecord[]>()
    for (const record of this.records) {
      const identity = keys ? record.key : record.label
      const matches = available.get(identity) ?? []
      matches.push(record)
      available.set(identity, matches)
    }

    const seen = new Map<string, number>()
    const next = labels.map((label, index): TabRecord => {
      const occurrence = seen.get(label) ?? 0
      seen.set(label, occurrence + 1)
      const key = keys?.[index] ?? `${label}\u0000${occurrence}`
      const reused = available.get(keys ? key : label)?.shift()
      const record: TabRecord = reused ?? { key, label, docIndex: shown[index], button: this.createButton(key), caption: captions[index] }
      record.key = key
      record.label = label
      record.docIndex = shown[index]
      record.caption = captions[index]
      record.doc = docs?.[index]
      record.button.dataset.tabKey = key
      record.button.setAttribute('aria-label', label)
      this.paint(record)
      return record
    })

    const retained = new Set(next.map((record) => record.button))
    const focusTarget = next.find((record) => record.key === active)?.button
    const nextSelected = next.findIndex((record) => record.key === oldSelectedKey)
    this.selectedIndex = next.length ? (nextSelected >= 0 ? nextSelected : Math.min(Math.max(this.selectedIndex, 0), next.length - 1)) : -1

    for (let index = 0; index < next.length; index++) {
      const button = next[index].button
      const at = this.el.children[index]
      if (at !== button) this.el.insertBefore(button, at ?? null)
    }
    for (const child of [...this.el.children]) {
      if (child instanceof HTMLButtonElement && child !== this.expandTile && !retained.has(child)) child.remove()
    }
    this.records = next
    this.syncExpandTile(hiddenCount)
    if (this.tipFor && !retained.has(this.tipFor)) this.hideTip()
    this.updateSelection()
    this.scheduleLayout()
    if (active && focusTarget) focusTarget.focus({ preventScroll: true })
  }

  /**
   * Indices of the documents to draw. Without a channel, or once expanded, all
   * of them; otherwise every document but the sent attachments past the cap. A
   * selected document that the cap would fold expands the run instead.
   */
  private shownIndices(labels: string[], keys: string[] | undefined, channel: Channel | undefined): number[] {
    const all = labels.map((_, i) => i)
    if (!channel || this.expanded) return all
    let sent = 0
    const hidden = new Set<number>()
    channel.documents.forEach((doc, i) => { if (isSentAttachment(doc) && ++sent > SENT_TILE_CAP) hidden.add(i) })
    if (!hidden.size) return all
    const selected = this.selectedKey === null || !keys ? -1 : keys.indexOf(this.selectedKey)
    if (selected >= 0 && hidden.has(selected)) { this.expanded = true; return all }
    return all.filter(i => !hidden.has(i))
  }

  /** The strip's last tile: `+N`, revealing the documents the cap folded away. */
  private syncExpandTile(hidden: number): void {
    if (hidden <= 0) { this.expandTile?.remove(); this.expandTile = null; return }
    if (!this.expandTile) {
      const tile = document.createElement('button')
      tile.type = 'button'
      tile.className = 'ws-tab-more'
      tile.dataset.part = 'tab-more'
      tile.addEventListener('click', () => this.expand())
      this.expandTile = tile
    }
    const tile = this.expandTile
    tile.textContent = `+${hidden}`
    tile.setAttribute('aria-label', `Show ${hidden} more ${hidden === 1 ? 'document' : 'documents'}`)
    if (tile.parentElement !== this.el || tile !== this.el.lastElementChild) this.el.append(tile)
  }

  /** Mount every document of the channel being read; the strip stays expanded until another channel opens. */
  private expand(): void {
    const first = this.records.length ? this.records[this.records.length - 1].docIndex + 1 : 0
    this.expanded = true
    if (this.input) this.render(this.input.labels, this.input.keys, this.input.channel)
    this.records.find(record => record.docIndex === first)?.button.focus({ preventScroll: true })
  }

  /** Select the document at `docIndex` of the run last rendered, revealing it if the cap folded it away. */
  mark(docIndex: number, animate: boolean): void {
    if (this.disposed || docIndex < 0) return
    let index = this.records.findIndex(record => record.docIndex === docIndex)
    if (index < 0 && this.input && docIndex < this.input.labels.length) {
      this.selectedKey = this.input.keys?.[docIndex] ?? null
      this.expanded = true
      this.render(this.input.labels, this.input.keys, this.input.channel)
      index = this.records.findIndex(record => record.docIndex === docIndex)
    }
    if (index < 0) return
    this.selectedIndex = index
    this.selectedKey = this.records[index].key
    this.updateSelection()
    this.cancelAnimation()
    this.pendingMark = { animate, start: performance.now() }
    this.scheduleLayout()
  }

  /** Coalesce marks from Reader paint and layout; geometry is read once before scroll/fade writes. */
  private scheduleLayout(): void {
    if (this.layoutFrame !== null) return
    this.layoutFrame = this.requestFrame(() => this.runLayout())
  }

  /**
   * Land a pending placement now, for a caller about to measure the tiles
   * where they end up (a FLIP glide); otherwise placement waits for the frame.
   */
  flushLayout(): void {
    if (this.layoutFrame === null) return
    this.cancelFrame(this.layoutFrame)
    this.runLayout()
  }

  private runLayout(): void {
    this.layoutFrame = null
    if (this.disposed) return
    const pending = this.pendingMark
    this.pendingMark = null
    if (pending) this.place(pending.animate, pending.start)
    else this.updateFades()
  }

  private place(animate: boolean, start: number): void {
    const selected = this.records[this.selectedIndex]?.button
    if (!selected) return
    const target = centeredScrollLeft(selected.offsetLeft, selected.offsetWidth, this.el.clientWidth, this.el.scrollWidth, this.focus ?? this.el.clientWidth / 2)
    this.animationTarget = target
    this.cancelAnimation()
    if (!animate || this.motion?.matches || this.el.clientWidth === 0) {
      this.el.scrollLeft = target
      this.updateFades()
      return
    }
    const from = this.el.scrollLeft
    if (Math.abs(target - from) < 0.5) {
      this.el.scrollLeft = target
      this.updateFades()
      return
    }
    const step = (now: number): void => {
      if (this.disposed) return
      const progress = Math.min(1, Math.max(0, (now - start) / TAB_CROSSING_MS))
      this.el.scrollLeft = from + (this.animationTarget - from) * easeCrossing(progress)
      this.updateFades()
      if (progress < 1) this.animationFrame = this.requestFrame(step)
      else this.animationFrame = null
    }
    step(performance.now())
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.layoutFrame !== null) this.cancelFrame(this.layoutFrame)
    this.layoutFrame = null
    this.pendingMark = null
    this.cancelAnimation()
    this.hideTip()
    this.receiptMotion.dispose()
    this.el.removeEventListener('pointerover', this.onPointerOver)
    this.el.removeEventListener('pointerleave', this.onPointerLeave)
    this.el.removeEventListener('pointerdown', this.hideTip)
    document.removeEventListener('keydown', this.hideTip, true)
    this.el.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    this.motion?.removeEventListener('change', this.onMotionChange)
    this.tip.remove()
    this.el.replaceChildren()
    this.records = []
  }

  /**
   * A tab is its kind's mark and its caption; the constitution's own page is
   * its § alone. The full name is the tab's accessible label.
   */
  private paint(record: TabRecord): void {
    const { button, caption, doc } = record
    let glyph = button.querySelector<HTMLElement>('.ws-tab-glyph')
    let text = button.querySelector<HTMLElement>('.ws-tab-label')
    if (!glyph) { glyph = document.createElement('span'); glyph.className = 'ws-tab-glyph'; glyph.setAttribute('aria-hidden', 'true'); button.prepend(glyph) }
    if (!text) { text = document.createElement('span'); text.className = 'ws-tab-label'; button.append(text) }
    text.textContent = caption
    const mark = !doc || doc.kind === 'fiber' ? '' : doc.kind === 'chat' ? CHAT_GLYPH : KIND_GLYPH[doc.kind]
    glyph.textContent = mark; glyph.hidden = !mark
    if (doc) button.dataset.kind = doc.kind
    else delete button.dataset.kind
  }

  private createButton(key: string): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ws-tab'
    button.dataset.part = 'tab'
    button.setAttribute('role', 'tab')
    button.tabIndex = -1
    button.dataset.tabKey = key
    button.addEventListener('click', () => {
      const index = this.records.findIndex((record) => record.button === button)
      if (index >= 0) { const doc = this.records[index].docIndex; this.mark(doc, true); this.onSelect(doc) }
    })
    button.addEventListener('dblclick', () => {
      const index = this.records.findIndex((record) => record.button === button)
      if (index >= 0 && index === this.selectedIndex) this.onExpand()
    })
    return button
  }

  private updateSelection(): void {
    this.records.forEach(({ button }, index) => {
      const selected = index === this.selectedIndex
      button.setAttribute('aria-selected', String(selected))
      button.tabIndex = selected ? 0 : -1
    })
  }

  /** An edge fades only where a tile runs past it, not over the strip's centring margin. */
  private updateFades(): void {
    const first = this.records[0]?.button, last = this.expandTile ?? this.records[this.records.length - 1]?.button
    const left = this.el.scrollLeft, right = left + this.el.clientWidth
    const fadeLeft = !!first && first.offsetLeft < left - 2
    const fadeRight = !!last && last.offsetLeft + last.offsetWidth > right + 2
    this.el.classList.toggle('ws-fade-l', fadeLeft)
    this.el.classList.toggle('ws-fade-r', fadeRight)
  }

  private requestFrame(callback: FrameRequestCallback): number {
    if (typeof window.requestAnimationFrame === 'function') return window.requestAnimationFrame(callback)
    return window.setTimeout(() => callback(performance.now()), 16)
  }

  private cancelFrame(frame: number): void {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
    else window.clearTimeout(frame)
  }

  private cancelAnimation(): void {
    if (this.animationFrame === null) return
    this.cancelFrame(this.animationFrame)
    this.animationFrame = null
  }

  private readonly onPointerOver = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || !this.visible) return
    const tab = (e.target as Element).closest<HTMLButtonElement>('.ws-tab')
    if (!tab || tab === this.tipFor) return
    if (this.tipTimer !== null) clearTimeout(this.tipTimer)
    this.tipTimer = null
    if (!this.tip.hidden || performance.now() < this.tipWarmUntil) { this.showTip(tab); return }
    this.tipFor = tab
    this.tipTimer = setTimeout(() => { this.tipTimer = null; if (this.tipFor === tab && tab.isConnected) this.showTip(tab) }, TIP_DELAY_MS)
  }
  private readonly onPointerLeave = (): void => {
    if (!this.tip.hidden) this.tipWarmUntil = performance.now() + TIP_DELAY_MS
    this.hideTip()
  }
  /** The hovered tab's full name, when its face does not already say it all: the §, a dropped extension, a truncation. */
  private showTip(tab: HTMLButtonElement): void {
    this.tipFor = tab
    const record = this.records.find(r => r.button === tab)
    const text = tab.querySelector<HTMLElement>('.ws-tab-label')
    const whole = !!record && record.caption === record.label && !!text && text.scrollWidth <= text.clientWidth
    if (tab.getAttribute('aria-selected') === 'true' || whole) {
      if (!this.tip.hidden) this.tipWarmUntil = performance.now() + TIP_DELAY_MS
      this.tip.hidden = true
      return
    }
    const name = document.createElement('span')
    name.className = 'ws-tab-tip-title'
    name.textContent = record?.doc?.kind === 'fiber' ? this.channel?.name ?? record.label : record?.label ?? ''
    this.tip.replaceChildren(name)
    this.tip.hidden = false
    const head = this.tip.offsetParent?.getBoundingClientRect()
    if (!head) return
    const rect = tab.getBoundingClientRect()
    const half = this.tip.offsetWidth / 2
    this.tip.style.left = `${Math.max(half + 8, Math.min(head.width - half - 8, rect.left + rect.width / 2 - head.left))}px`
  }
  private readonly hideTip = (): void => {
    if (this.tipTimer !== null) clearTimeout(this.tipTimer)
    this.tipTimer = null
    this.tipFor = null
    this.tip.hidden = true
  }
  private readonly onScroll = (): void => { this.scheduleLayout() }
  private readonly onResize = (): void => { this.mark(this.records[this.selectedIndex]?.docIndex ?? -1, false) }
  private readonly onMotionChange = (): void => {
    if (!this.motion?.matches || this.animationFrame === null) return
    this.cancelAnimation()
    this.el.scrollLeft = this.animationTarget
    this.updateFades()
  }
  /** The reader's shared keymap also owns roving focus within the tablist. */
  handleIntent(intent: KeyIntent): boolean {
    const current = this.records.findIndex(({ button }) => button === document.activeElement)
    if (current < 0) return false
    const doc = this.records[current].docIndex, total = this.input?.labels.length ?? this.records.length
    const next = intent === 'next' ? Math.min(total - 1, doc + 1)
      : intent === 'prev' ? Math.max(0, doc - 1)
      : intent === 'first' ? 0 : intent === 'last' ? total - 1 : null
    if (next === null) return false
    if (next !== doc) { this.mark(next, true); this.onSelect(next) }
    this.records.find(record => record.docIndex === next)?.button.focus({ preventScroll: true })
    return true
  }
}
