import type { KeyIntent } from '../keymap.js'
import type { Channel } from './documents.js'
import { extractEmbeds } from '../attachments.js'
import { Thumbnail } from './Thumbnail.js'
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

type TabRecord = { key: string; label: string; button: HTMLButtonElement; thumb?: Thumbnail }
interface StripOptions { shuttleBase: string; onHeight(height: number): void }

/** One roving-focus tablist whose selected tab stays centred through one interruptible crossing. */
export class TabStrip {
  readonly el: HTMLDivElement
  private readonly onSelect: (index: number) => void
  private readonly onExpand: () => void
  private readonly motion: MediaQueryList | null
  private readonly receiptMotion = new ReceiptMotion()
  private records: TabRecord[] = []
  private selectedIndex = -1
  private animationFrame: number | null = null
  private animationTarget = 0
  private disposed = false
  private compact = false
  private visible = true
  private readonly phone = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 700px)') : null
  private readonly options?: StripOptions

  constructor(onSelect: (index: number) => void, onExpand: () => void, options?: StripOptions) {
    this.options = options
    this.onSelect = onSelect
    this.onExpand = onExpand
    this.el = document.createElement('div')
    this.el.className = 'ws-tabs'
    this.el.dataset.part = 'tab-strip'
    this.el.setAttribute('role', 'tablist')
    this.el.setAttribute('aria-label', 'Documents')
    this.motion = typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)')
      : null
    this.el.addEventListener('scroll', this.onScroll, { passive: true })
    window.addEventListener('resize', this.onResize)
    this.motion?.addEventListener('change', this.onMotionChange)
    this.phone?.addEventListener('change', this.onResize)
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

  setCompact(expanded: boolean): void {
    this.compact = expanded
    this.updateMode()
  }
  setVisible(visible: boolean): void {
    this.visible = visible
    for (const record of this.records) record.thumb?.schedule()
  }
  private updateMode(): void {
    const compact = this.compact || !!this.phone?.matches
    this.el.classList.toggle('ws-strip-film', !!this.options && !compact)
    this.options?.onHeight(this.phone?.matches ? 44 : compact ? 36 : 104)
    for (const record of this.records) record.thumb?.schedule()
  }

  render(labels: string[], keys?: string[], channel?: Channel): void {
    if (this.disposed) return
    if (labels.length === this.records.length && labels.every((label, index) => label === this.records[index].label && (!keys || keys[index] === this.records[index].key))) {
      if (channel) {
        this.records.find(r => r.key === channel.documents[0]?.key)?.thumb?.setProse(extractEmbeds(channel.body).body || channel.outcome || '', channel.name)
        this.records.forEach((record, index) => {
          const doc = channel.documents[index]
          record.button.querySelector('.ws-tab-label')?.classList.toggle('ws-tab-title', !!declaredTitle(doc.key)?.title || doc.provenance.some(p => p.kind === 'embed' && p.title === record.label))
        })
      }
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
      let thumb = this.records.find(r => r.button === button)?.thumb
      if (channel && this.options) {
        const doc = channel.documents[index]
        if (!thumb) {
          const recordKey = key
          thumb = new Thumbnail({ key: `tab:${key}`, shuttleBase: this.options.shuttleBase,
            file: doc.kind === 'fiber' ? undefined : { fullPath: doc.path, owner: doc.owner, basename: doc.name },
            fallback: `\n${extractEmbeds(channel.body).body.slice(0, 400) || channel.outcome || channel.name}`,
            className: `ws-tab-thumb ws-tab-kind-${doc.kind}`, captioned: true,
            priority: () => this.visible && !this.disposed && !this.compact && !this.phone?.matches && this.el.isConnected ? (this.onScreen(button) ? 3 : 1) : 0,
            distance: () => Math.abs(this.records.findIndex(r => r.key === recordKey) - this.selectedIndex),
            onAspect: aspect => {
              button.style.setProperty('--ws-tab-aspect', String(Math.max(0.8, Math.min(2.8, aspect))))
              this.mark(this.selectedIndex, false)
            },
          })
          if (doc.kind === 'fiber') thumb.setProse(extractEmbeds(channel.body).body || channel.outcome || '', channel.name)
          button.replaceChildren(thumb.el)
        }
        let caption = button.querySelector<HTMLElement>('.ws-tab-label')
        if (!caption) { caption = document.createElement('span'); caption.className = 'ws-tab-label'; button.append(caption) }
        caption.textContent = label
        caption.classList.toggle('ws-tab-title', !!declaredTitle(doc.key)?.title || doc.provenance.some(p => p.kind === 'embed' && p.title === label))
      } else button.textContent = label
      button.title = channel ? channel.documents[index].path : label
      button.setAttribute('aria-label', label)
      return { key, label, button, thumb }
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
    for (const record of this.records) if (!retained.has(record.button)) record.thumb?.dispose()
    this.records = next
    this.updateMode()
    this.updateSelection()
    this.updateFades()
    this.scheduleClipping()
    if (active && focusTarget) focusTarget.focus({ preventScroll: true })
  }

  mark(index: number, animate: boolean): void {
    if (this.disposed || index < 0 || index >= this.records.length) return
    this.selectedIndex = index
    this.updateSelection()
    for (const record of this.records) record.thumb?.schedule()
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
    this.phone?.removeEventListener('change', this.onResize)
    for (const record of this.records) record.thumb?.dispose()
    this.el.replaceChildren()
    this.records = []
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

  private onScreen(button: HTMLElement): boolean {
    const band = this.el.getBoundingClientRect(), tab = button.getBoundingClientRect()
    return tab.width > 0 && tab.right > band.left && tab.left < band.right
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

  private readonly onScroll = (): void => { this.updateFades(); for (const record of this.records) record.thumb?.schedule() }
  private readonly onResize = (): void => { this.updateMode(); this.mark(this.selectedIndex, false); this.updateFades(); this.scheduleClipping() }
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
