/** Small receipt responses never reload or animate the document itself. */
export class ReceiptMotion {
  private readonly motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  private readonly animations = new Set<Animation>()
  constructor() { this.motion?.addEventListener('change', this.motionChanged) }
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
