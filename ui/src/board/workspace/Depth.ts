/** One receding Desk beneath both workspace surfaces; pointer work sleeps between events. */
export class WorkspaceDepth {
  private readonly root: HTMLElement
  private readonly motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly fine = window.matchMedia('(pointer: fine)')
  private active = false
  private frame = 0
  private crossingTimer: ReturnType<typeof setTimeout> | null = null
  private x = 0
  private y = 0
  private crossing = 0

  constructor(root: HTMLElement) {
    this.root = root
    document.addEventListener('pointermove', this.pointer, { passive: true })
    document.addEventListener('pointerleave', this.leave)
    window.addEventListener('blur', this.leave)
    this.motion.addEventListener('change', this.preference)
    this.fine.addEventListener('change', this.preference)
  }
  setActive(active: boolean): void {
    this.active = active
    this.root.classList.toggle('kbn-workspace-raised', active)
    if (!active) this.reset()
  }
  private measure(name: string, fallback: number): number {
    return parseFloat(getComputedStyle(this.root).getPropertyValue(`--ws-${name}`)) || fallback
  }
  /** Page travel is shared as a tiny, bounded counter-motion in the world below. */
  cross(travel: number): void {
    if (!this.enabled) return
    if (this.crossingTimer !== null) clearTimeout(this.crossingTimer)
    const bound = this.measure('desk-crossing-drift', 6)
    this.crossing = Math.max(-bound, Math.min(bound, travel * this.measure('desk-travel-fraction', 0.012)))
    this.schedule()
    this.crossingTimer = setTimeout(() => {
      this.crossingTimer = null
      this.crossing = 0
      this.schedule()
    }, this.measure('crossing', 280))
  }
  private get enabled(): boolean { return this.active && this.fine.matches && !this.motion.matches }
  private readonly pointer = (event: PointerEvent): void => {
    if (!this.enabled || event.pointerType === 'touch') return
    this.x = Math.max(-1, Math.min(1, event.clientX / window.innerWidth * 2 - 1))
    this.y = Math.max(-1, Math.min(1, event.clientY / window.innerHeight * 2 - 1))
    this.schedule()
  }
  private readonly leave = (): void => { this.x = this.y = 0; this.schedule() }
  private readonly preference = (): void => { if (!this.enabled) this.reset() }
  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint() })
  }
  private paint(): void {
    const desk = this.measure('desk-pointer-drift', 8), page = this.measure('page-pointer-drift', 3)
    // Pointer and crossing contributions share the Desk's total eight-pixel budget.
    this.root.style.setProperty('--ws-desk-x', `${Math.max(-desk, Math.min(desk, -this.x * desk + this.crossing))}px`)
    this.root.style.setProperty('--ws-desk-y', `${-this.y * desk}px`)
    this.root.style.setProperty('--ws-page-x', `${-this.x * page}px`)
    this.root.style.setProperty('--ws-page-y', `${-this.y * page}px`)
  }
  private reset(): void {
    cancelAnimationFrame(this.frame); this.frame = 0
    if (this.crossingTimer !== null) clearTimeout(this.crossingTimer)
    this.crossingTimer = null
    this.x = this.y = this.crossing = 0
    this.paint()
  }
  dispose(): void {
    this.setActive(false)
    document.removeEventListener('pointermove', this.pointer)
    document.removeEventListener('pointerleave', this.leave)
    window.removeEventListener('blur', this.leave)
    this.motion.removeEventListener('change', this.preference)
    this.fine.removeEventListener('change', this.preference)
  }
}
