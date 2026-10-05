import type { Channel, WorkspaceDocument } from './documents.js'
import { documentLabelMetadata } from './documents.js'
import { extractEmbeds } from '../attachments.js'
import { Thumbnail } from './Thumbnail.js'

/** A first hover waits this long; a preview already up (or just gone) follows the pointer at once. */
export const PREVIEW_DELAY_MS = 400
/** The pointer may cross the gap between labels, or come back, within this long without a fresh wait. */
export const PREVIEW_GRACE_MS = 300
/** The preview's width, its gap below the label, and its distance from the viewport edges. */
const CARD_WIDTH = 224
const CARD_GAP = 6
const VIEWPORT_MARGIN = 12

/**
 * The index's thumbnails, on demand: hovering a tab shows its document at a
 * legible size beneath it. Pointer only; it never takes focus or input, and
 * a key, a press, Escape or leaving the index dismisses it.
 */
export class TabPreview {
  readonly el: HTMLElement
  private readonly thumbSlot: HTMLElement
  private readonly title: HTMLElement
  private readonly meta: HTMLElement
  private readonly thumbs = new Map<string, Thumbnail>()
  private readonly aspects = new Map<string, number>()
  private readonly shuttleBase: string
  private channel: Channel | null = null
  private labels: string[] = []
  private current: string | null = null
  private anchor: HTMLElement | null = null
  private suppressed: HTMLElement | null = null
  private pending: ReturnType<typeof setTimeout> | null = null
  private leaving: ReturnType<typeof setTimeout> | null = null
  private warmUntil = 0
  private enabled = true

  constructor(shuttleBase: string) {
    this.shuttleBase = shuttleBase
    this.el = document.createElement('div')
    this.el.className = 'ws-tab-preview'
    this.el.dataset.part = 'tab-preview'
    this.el.setAttribute('aria-hidden', 'true')
    this.el.inert = true
    this.el.hidden = true
    this.thumbSlot = document.createElement('div')
    this.thumbSlot.className = 'ws-tab-preview-thumb'
    this.title = document.createElement('div')
    this.title.className = 'ws-tab-preview-title'
    this.meta = document.createElement('div')
    this.meta.className = 'ws-tab-preview-meta'
    this.el.append(this.thumbSlot, this.title, this.meta)
  }

  get open(): boolean { return !this.el.hidden }

  /** Listen on the index; tabs are found by delegation so re-renders need no rebinding. */
  attach(strip: HTMLElement): void {
    strip.addEventListener('pointerover', this.over)
    strip.addEventListener('pointerout', this.out)
    strip.addEventListener('pointerdown', this.press)
    strip.addEventListener('scroll', this.dismissNow, { passive: true })
    strip.addEventListener('wheel', this.dismissNow, { passive: true })
  }

  update(channel: Channel, labels: string[]): void {
    this.channel = channel
    this.labels = labels
    const keys = new Set(channel.documents.map(doc => doc.key))
    for (const [key, thumb] of this.thumbs) if (!keys.has(key)) { thumb.dispose(); this.thumbs.delete(key); this.aspects.delete(key) }
    if (this.current && !keys.has(this.current)) this.dismiss()
    else if (this.current && this.anchor) this.fill(this.current)
  }

  /** The strip is hidden or condensed: nothing may be previewed. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.dismiss()
  }

  /** Hide at once; true when a preview was showing, so Escape can stop there. */
  dismiss(): boolean {
    const was = this.open
    this.clearTimers()
    this.el.hidden = true
    this.current = null
    this.anchor = null
    if (was) this.warmUntil = performance.now() + PREVIEW_GRACE_MS
    for (const thumb of this.thumbs.values()) thumb.schedule()
    return was
  }

  dispose(): void {
    this.dismiss()
    for (const thumb of this.thumbs.values()) thumb.dispose()
    this.thumbs.clear()
    this.el.remove()
  }

  private readonly over = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || !this.enabled) return
    const tab = (e.target as Element).closest<HTMLElement>('[role="tab"]')
    if (!tab || tab === this.suppressed) return
    if (this.leaving !== null) { clearTimeout(this.leaving); this.leaving = null }
    if (tab === this.anchor) return
    if (this.pending !== null) clearTimeout(this.pending)
    this.pending = null
    if (this.open || performance.now() < this.warmUntil) { this.show(tab); return }
    this.pending = setTimeout(() => { this.pending = null; if (tab.isConnected) this.show(tab) }, PREVIEW_DELAY_MS)
  }
  private readonly out = (e: PointerEvent): void => {
    const from = (e.target as Element).closest<HTMLElement>('[role="tab"]')
    const to = (e.relatedTarget as Element | null)?.closest?.<HTMLElement>('[role="tab"]')
    if (!from || from === to) return
    if (from === this.suppressed) this.suppressed = null
    if (this.pending !== null) { clearTimeout(this.pending); this.pending = null }
    if (!this.open || to) return
    // Leaving the index puts the preview away at once; crossing its own margin keeps a moment's grace.
    const strip = e.currentTarget as HTMLElement
    if (!(e.relatedTarget instanceof Node && strip.contains(e.relatedTarget))) { this.dismiss(); return }
    if (this.leaving !== null) clearTimeout(this.leaving)
    this.leaving = setTimeout(() => { this.leaving = null; this.dismiss() }, PREVIEW_GRACE_MS / 3)
  }
  private readonly press = (e: PointerEvent): void => {
    this.suppressed = (e.target as Element).closest<HTMLElement>('[role="tab"]')
    this.dismiss()
  }
  private readonly dismissNow = (): void => { if (this.open || this.pending !== null) this.dismiss() }

  private clearTimers(): void {
    if (this.pending !== null) clearTimeout(this.pending)
    if (this.leaving !== null) clearTimeout(this.leaving)
    this.pending = this.leaving = null
  }

  private show(tab: HTMLElement): void {
    const key = tab.dataset.tabKey
    if (!key || !this.channel?.documents.some(doc => doc.key === key)) return
    this.anchor = tab
    this.current = key
    this.fill(key)
    this.el.hidden = false
    this.place(tab)
    this.thumbs.get(key)?.schedule()
  }

  private fill(key: string): void {
    const channel = this.channel
    const index = channel?.documents.findIndex(doc => doc.key === key) ?? -1
    const doc = index >= 0 ? channel?.documents[index] : undefined
    if (!channel || !doc) return
    const thumb = this.thumb(doc, channel)
    if (thumb.el.parentElement !== this.thumbSlot) this.thumbSlot.replaceChildren(thumb.el)
    this.thumbSlot.dataset.kind = doc.kind
    const label = this.labels[index] ?? doc.name
    const metadata = documentLabelMetadata(doc, label, channel.owner)
    this.title.textContent = doc.kind === 'fiber' ? channel.name : metadata.title
    const name = doc.kind === 'fiber' || doc.name === metadata.title ? '' : doc.name
    this.meta.textContent = [name, metadata.summary].filter(Boolean).join(' · ')
  }

  private thumb(doc: WorkspaceDocument, channel: Channel): Thumbnail {
    let thumb = this.thumbs.get(doc.key)
    const prose = extractEmbeds(channel.body).body || channel.outcome || ''
    if (!thumb) {
      const key = doc.key
      thumb = new Thumbnail({
        key: `peek:${key}`, shuttleBase: this.shuttleBase,
        file: doc.kind === 'fiber' ? undefined : { fullPath: doc.path, owner: doc.owner, basename: doc.name },
        fallback: `\n${prose.slice(0, 400) || channel.name}`,
        className: `ws-tab-preview-face ws-tab-kind-${doc.kind}`, captioned: true,
        priority: () => this.current === key && this.open ? 3 : 0,
        distance: () => 0,
        onAspect: aspect => {
          this.aspects.set(key, Math.max(0.75, Math.min(2.4, aspect)))
          if (this.current === key) this.paintAspect(key)
        },
      })
      this.thumbs.set(key, thumb)
    }
    if (doc.kind === 'fiber') thumb.setProse(prose, channel.name)
    this.paintAspect(doc.key)
    return thumb
  }

  private paintAspect(key: string): void {
    const aspect = this.aspects.get(key)
    if (aspect) this.thumbSlot.style.setProperty('--ws-preview-aspect', String(aspect))
    else this.thumbSlot.style.removeProperty('--ws-preview-aspect')
  }

  private place(tab: HTMLElement): void {
    const rect = tab.getBoundingClientRect()
    const width = this.el.offsetWidth || CARD_WIDTH
    const left = Math.max(VIEWPORT_MARGIN, Math.min(window.innerWidth - VIEWPORT_MARGIN - width, rect.left + rect.width / 2 - width / 2))
    this.el.style.left = `${Math.round(left)}px`
    this.el.style.top = `${Math.round(rect.bottom + CARD_GAP)}px`
  }
}
