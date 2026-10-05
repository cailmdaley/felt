import type { KeyIntent } from '../keymap.js'
import type { Channel, WorkspaceDocument } from './documents.js'
import { TabPreview } from './TabPreview.js'
import { declaredTitle } from './DocumentTitles.js'
import './tabs.css'
import { ReceiptMotion } from './receiptMotion.js'

export const TAB_CROSSING_MS = 280

/** Clamp the scroll offset that centres a tab inside a horizontally scrolling strip. */
export function centeredScrollLeft(tabLeft: number, tabWidth: number, viewportWidth: number, contentWidth: number): number {
  const maximum = Math.max(0, contentWidth - viewportWidth)
  const centred = tabLeft + tabWidth / 2 - viewportWidth / 2
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
 * The words the index shows. The fiber's own page is its § mark; a label
 * that is a file's name drops its extension (the preview and the label bar
 * name the kind) unless that would make two captions alike.
 */
export function indexCaptions(labels: string[], channel?: Channel): string[] {
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

type TabRecord = { key: string; label: string; button: HTMLButtonElement }
interface StripOptions { shuttleBase: string }

/**
 * The running head's index: one roving-focus tablist of bare serif labels
 * whose selected tab stays centred through one interruptible crossing.
 * Thumbnails come on demand, in a hover preview beneath the hovered label.
 */
export class TabStrip {
  readonly el: HTMLDivElement
  /** Pointer-only previews; mount `preview.el` where it can float over the stage. */
  readonly preview: TabPreview | null
  private readonly onSelect: (index: number) => void
  private readonly onExpand: () => void
  private readonly motion: MediaQueryList | null
  private readonly receiptMotion = new ReceiptMotion()
  private records: TabRecord[] = []
  private selectedIndex = -1
  private animationFrame: number | null = null
  private animationTarget = 0
  private disposed = false
  private visible = true

  constructor(onSelect: (index: number) => void, onExpand: () => void, options?: StripOptions) {
    this.onSelect = onSelect
    this.onExpand = onExpand
    this.el = document.createElement('div')
    this.el.className = 'ws-tabs'
    this.el.dataset.part = 'tab-strip'
    this.el.setAttribute('role', 'tablist')
    this.el.setAttribute('aria-label', 'Documents')
    this.preview = options ? new TabPreview(options.shuttleBase) : null
    this.preview?.attach(this.el)
    this.motion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
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

  setVisible(visible: boolean): void {
    this.visible = visible
    this.preview?.setEnabled(visible)
  }

  render(labels: string[], keys?: string[], channel?: Channel): void {
    if (this.disposed) return
    if (channel) this.preview?.update(channel, labels)
    const captions = indexCaptions(labels, channel)
    if (labels.length === this.records.length && labels.every((label, index) => label === this.records[index].label && (!keys || keys[index] === this.records[index].key))) {
      if (channel) this.records.forEach((record, index) => this.paintLabel(record.button, captions[index], record.label, channel.documents[index]))
      return
    }

    const active = document.activeElement instanceof HTMLButtonElement && this.el.contains(document.activeElement)
      ? this.records.find((record) => record.button === document.activeElement)?.key
      : undefined
    const oldSelectedKey = this.records[this.selectedIndex]?.key
    const available = new Map<string, HTMLButtonElement[]>()
    for (const record of this.records) {
      const identity = keys ? record.key : record.label
      const matches = available.get(identity) ?? []
      matches.push(record.button)
      available.set(identity, matches)
    }

    const seen = new Map<string, number>()
    const next = labels.map((label, index) => {
      const occurrence = seen.get(label) ?? 0
      seen.set(label, occurrence + 1)
      const key = keys?.[index] ?? `${label}\u0000${occurrence}`
      const matches = available.get(keys ? key : label)
      const button = matches?.shift() ?? this.createButton(key)
      button.dataset.tabKey = key
      this.paintLabel(button, captions[index], label, channel?.documents[index])
      button.setAttribute('aria-label', label)
      return { key, label, button }
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
      if (child instanceof HTMLButtonElement && !retained.has(child)) child.remove()
    }
    this.records = next
    this.updateSelection()
    this.updateFades()
    this.scheduleClipping()
    if (active && focusTarget) focusTarget.focus({ preventScroll: true })
  }

  mark(index: number, animate: boolean): void {
    if (this.disposed || index < 0 || index >= this.records.length) return
    this.selectedIndex = index
    this.updateSelection()
    const selected = this.records[index].button
    const target = centeredScrollLeft(selected.offsetLeft, selected.offsetWidth, this.el.clientWidth, this.el.scrollWidth)
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
    const start = performance.now()
    const step = (now: number): void => {
      if (this.disposed) return
      const progress = Math.min(1, Math.max(0, (now - start) / TAB_CROSSING_MS))
      this.el.scrollLeft = from + (this.animationTarget - from) * easeCrossing(progress)
      this.updateFades()
      if (progress < 1) this.animationFrame = this.requestFrame(step)
      else this.animationFrame = null
    }
    this.animationFrame = this.requestFrame(step)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelAnimation()
    this.receiptMotion.dispose()
    this.el.removeEventListener('scroll', this.onScroll)
    window.removeEventListener('resize', this.onResize)
    this.motion?.removeEventListener('change', this.onMotionChange)
    this.preview?.dispose()
    this.el.replaceChildren()
    this.records = []
  }

  /**
   * One serif label per tab. The fiber's own page is anchored by its § mark
   * alone; declared titles and embed titles are marked for themes.
   */
  private paintLabel(button: HTMLButtonElement, caption: string, label: string, doc?: WorkspaceDocument): void {
    let text = button.querySelector<HTMLElement>('.ws-tab-label')
    if (!text) { text = document.createElement('span'); text.className = 'ws-tab-label'; button.replaceChildren(text) }
    text.textContent = caption
    button.classList.toggle('ws-tab-anchor', doc?.kind === 'fiber')
    text.classList.toggle('ws-tab-title', !!doc && (!!declaredTitle(doc.key)?.title || doc.provenance.some(p => p.kind === 'embed' && p.title === label)))
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
      if (index >= 0) { this.mark(index, true); this.onSelect(index) }
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

  private updateFades(): void {
    this.el.classList.toggle('ws-fade-l', this.el.scrollLeft > 2)
    this.el.classList.toggle('ws-fade-r', this.el.scrollLeft + this.el.clientWidth < this.el.scrollWidth - 2)
  }

  private scheduleClipping(): void {
    this.requestFrame(() => {
      if (this.disposed) return
      for (const { button } of this.records) {
        button.classList.toggle('ws-clipped', button.scrollWidth > button.clientWidth + 1)
      }
    })
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

  private readonly onScroll = (): void => { this.updateFades() }
  private readonly onResize = (): void => { this.mark(this.selectedIndex, false); this.updateFades(); this.scheduleClipping() }
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
    const next = intent === 'next' ? Math.min(this.records.length - 1, current + 1)
      : intent === 'prev' ? Math.max(0, current - 1)
      : intent === 'first' ? 0 : intent === 'last' ? this.records.length - 1 : null
    if (next === null) return false
    if (next !== current) { this.mark(next, true); this.onSelect(next) }
    this.records[next]?.button.focus({ preventScroll: true })
    return true
  }
}
