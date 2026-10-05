import type { Channel, DocKey, WorkspaceDocument } from './documents.js'

const receipts = (doc: WorkspaceDocument): string => JSON.stringify(doc.provenance
  .filter(p => p.kind === 'sent').map(p => JSON.stringify(p)).sort())

/** Loading and entering a channel establish a baseline; only another receipt moves a tab. */
export class ReceiptArrivals {
  private readonly channels = new Map<string, Map<DocKey, string>>()
  observe(channel: Channel, ready: boolean): Set<DocKey> {
    if (!ready) return new Set()
    const id = JSON.stringify([channel.owner, channel.uid])
    const prior = this.channels.get(id)
    const next = new Map(channel.documents.filter(doc => doc.kind !== 'fiber').map(doc => [doc.key, receipts(doc)]))
    this.channels.set(id, next)
    return new Set(prior ? [...next].filter(([key, stamp]) => stamp !== '[]' && stamp !== prior.get(key)).map(([key]) => key) : [])
  }
}

/** Small receipt responses never reload or animate the document itself. */
export class ReceiptMotion {
  private readonly motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  private readonly animations = new Set<Animation>()
  constructor() { this.motion?.addEventListener('change', this.motionChanged) }
  tab(el: HTMLElement): void {
    this.run(el, [{ transform: 'translateX(-24px)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], 280)
  }
  folio(el: HTMLElement): void {
    const shadow = getComputedStyle(el).getPropertyValue('--ws-chrome-shadow').trim() || '0 8px 18px rgba(0,0,0,.15)'
    this.run(el, [
      { transform: 'translateY(0)', boxShadow: 'none' },
      { transform: 'translateY(-4px)', boxShadow: shadow, offset: 0.5 },
      { transform: 'translateY(0)', boxShadow: 'none' },
    ], 400)
  }
  private run(el: HTMLElement, frames: Keyframe[], duration: number): void {
    if (this.motion?.matches || !el.animate) return
    const animation = el.animate(frames, { duration, easing: 'ease' })
    this.animations.add(animation)
    const done = (): void => { this.animations.delete(animation) }
    animation.addEventListener('finish', done, { once: true })
    animation.addEventListener('cancel', done, { once: true })
  }
  private readonly motionChanged = (): void => { if (this.motion?.matches) this.cancel() }
  private cancel(): void { for (const animation of this.animations) animation.cancel(); this.animations.clear() }
  dispose(): void { this.cancel(); this.motion?.removeEventListener('change', this.motionChanged) }
}
