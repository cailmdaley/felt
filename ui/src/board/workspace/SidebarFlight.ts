import type { KanbanCard } from '../KanbanTypes.js'
import { workspaceMeasure } from './measures.js'

export interface SidebarEntry {
  card: KanbanCard
  band?: string
  source?: HTMLElement
}
export const cardIdentity = (card: KanbanCard): string => JSON.stringify([card.originId, card.uid ?? card.id])
type Source = { el: HTMLElement; rect: DOMRect }

/** FLIP copies carry the Desk's cards between their real column and compact slots. */
export class SidebarFlight {
  private readonly root: HTMLElement
  private readonly sidebar: HTMLElement
  private readonly sources = new Map<string, Source>()
  private readonly hidden = new Set<HTMLElement>()
  private readonly animations = new Set<Animation>()
  private readonly ghosts = new Set<HTMLElement>()
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly overlay = document.createElement('div')
  private visible = false
  private revision = 0

  constructor(root: HTMLElement, sidebar: HTMLElement) {
    this.root = root; this.sidebar = sidebar
    this.overlay.className = 'ws-sidebar ws-sidebar-flight'
    this.overlay.inert = true; this.overlay.setAttribute('aria-hidden', 'true')
    this.motion.addEventListener('change', this.preference)
  }
  capture(entries: SidebarEntry[]): void {
    this.cancel()
    this.restoreSources()
    this.sources.clear()
    for (const { card, source } of entries) {
      if (source) this.sources.set(cardIdentity(card), { el: source, rect: source.getBoundingClientRect() })
    }
    this.visible = false
  }
  setVisible(visible: boolean, animate = true): void {
    if (visible === this.visible) return
    const interrupted = new Map([...this.ghosts].map(ghost => [JSON.stringify([ghost.dataset.channelOwner, ghost.dataset.channelUid]), ghost.getBoundingClientRect()]))
    this.visible = visible
    this.cancel()
    if (visible) this.hideSources()
    if (!animate || this.motion.matches || typeof HTMLElement.prototype.animate !== 'function') {
      if (!visible) this.restoreSources()
      return
    }
    const revision = this.revision
    const duration = workspaceMeasure(this.root, 'crossing', 280)
    const easing = getComputedStyle(this.root).getPropertyValue('--ws-ease').trim() || 'ease'
    this.root.append(this.overlay)
    for (const row of this.sidebar.querySelectorAll<HTMLElement>('.ws-channel-row')) {
      const key = JSON.stringify([row.dataset.channelOwner, row.dataset.channelUid])
      const source = this.sources.get(key)
      if (!source || !source.rect.width || !source.rect.height) continue
      const slot = row.getBoundingClientRect()
      if (!slot.width || !slot.height) continue
      const desk = visible ? source.rect : this.returnRect(source)
      const start = interrupted.get(key) ?? (visible ? desk : slot), end = visible ? slot : desk
      const ghost = row.cloneNode(true) as HTMLElement
      ghost.classList.toggle('ws-flight-current', row.getAttribute('aria-current') === 'true')
      ghost.removeAttribute('aria-current'); ghost.removeAttribute('tabindex')
      Object.assign(ghost.style, { position: 'fixed', left: `${end.left}px`, top: `${end.top}px`, width: `${end.width}px`, height: `${end.height}px`, margin: '0', transformOrigin: '0 0' })
      this.overlay.append(ghost); this.ghosts.add(ghost)
      // The underlying selected card is covered by its travelling copy until it lands.
      row.classList.add('ws-card-travelling')
      const animation = ghost.animate([
        { transform: `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width}, ${start.height / end.height})`, opacity: 1 },
        { transform: 'none', opacity: 1 },
      ], { duration, easing, fill: 'both' })
      this.animations.add(animation)
      void animation.finished.then(() => {
        if (revision !== this.revision) return
        ghost.remove(); this.ghosts.delete(ghost); this.animations.delete(animation)
        row.classList.remove('ws-card-travelling')
        if (!this.animations.size) { this.overlay.remove(); if (!this.visible) this.restoreSources() }
      }).catch(() => { /* Interrupted flights continue from their current screen rects. */ })
    }
    if (!this.animations.size) { this.overlay.remove(); if (!visible) this.restoreSources() }
  }
  refresh(): void {
    const selected = this.sidebar.querySelector<HTMLElement>('[aria-current="true"]')
    for (const ghost of this.ghosts) ghost.classList.toggle('ws-flight-current', ghost.dataset.channelUid === selected?.dataset.channelUid && ghost.dataset.channelOwner === selected?.dataset.channelOwner)
  }
  /** Recover the unscaled Desk rect while its receding transform is still reversing. */
  private returnRect(source: Source): DOMRect {
    if (!source.el.isConnected) return source.rect
    const card = source.el.getBoundingClientRect()
    const desk = source.el.closest<HTMLElement>('.kbn-desk')
    if (!desk || !desk.offsetWidth) return card.width ? card : source.rect
    const bounds = desk.getBoundingClientRect(), scale = bounds.width / desk.offsetWidth
    if (!scale) return source.rect
    const css = getComputedStyle(desk)
    const origin = css.transformOrigin.split(' ').map(Number.parseFloat)
    const matrix = new DOMMatrixReadOnly(css.transform === 'none' ? undefined : css.transform)
    const left = bounds.left - matrix.m41 - origin[0] * (1 - scale)
    const top = bounds.top - matrix.m42 - origin[1] * (1 - scale)
    return new DOMRect(left + (card.left - bounds.left) / scale, top + (card.top - bounds.top) / scale, card.width / scale, card.height / scale)
  }
  private hideSources(): void {
    for (const { el } of this.sources.values()) { el.classList.add('ws-sidebar-source'); this.hidden.add(el) }
  }
  private restoreSources(): void { for (const el of this.hidden) el.classList.remove('ws-sidebar-source'); this.hidden.clear() }
  private cancel(): void {
    this.revision++
    for (const animation of this.animations) animation.cancel()
    this.animations.clear()
    for (const ghost of this.ghosts) ghost.remove()
    this.ghosts.clear(); this.overlay.remove()
    for (const row of this.sidebar.querySelectorAll('.ws-card-travelling')) row.classList.remove('ws-card-travelling')
  }
  private readonly preference = (): void => {
    if (this.motion.matches) { this.cancel(); if (!this.visible) this.restoreSources() }
  }
  dispose(): void { this.cancel(); this.restoreSources(); this.motion.removeEventListener('change', this.preference) }
}
