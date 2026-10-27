import './settings-menu.css'

/**
 * The settings dropdown: a non-modal panel under the ⚙ that opened it, holding
 * only the settings content. Escape or a press outside closes it and returns
 * focus to the opener.
 */
export class SettingsMenu {
  readonly el = document.createElement('div')
  private opener: HTMLElement | null = null
  private afterClose: (() => void) | null = null

  private readonly onVisibility: () => void
  constructor(onVisibility: () => void = (): void => {}) {
    this.onVisibility = onVisibility
    this.el.className = 'ws-settings-menu'
    this.el.dataset.part = 'settings-menu'
    this.el.setAttribute('role', 'group')
    this.el.setAttribute('aria-label', 'Settings')
    this.el.tabIndex = -1
    this.el.setAttribute('popover', 'manual')
    this.el.hidden = true
  }
  get isOpen(): boolean { return !this.el.hidden }
  show(content: HTMLElement, opener: HTMLElement, host: HTMLElement): void {
    if (this.isOpen) { this.close(); return }
    this.opener = opener
    host.append(this.el)
    content.hidden = false
    this.el.replaceChildren(content)
    this.el.hidden = false
    // The top layer lifts it out of the chat's layout containment, which would otherwise make the chat its fixed-position origin.
    try { this.el.showPopover?.() } catch { /* Already shown, or unsupported: fixed positioning still draws it. */ }
    this.position()
    this.el.scrollTop = 0
    opener.setAttribute('aria-expanded', 'true')
    window.addEventListener('resize', this.position)
    document.addEventListener('pointerdown', this.outside, true)
    document.addEventListener('keydown', this.keydown, true)
    this.onVisibility()
    this.el.focus({ preventScroll: true })
  }
  close(after?: () => void): void {
    if (!this.isOpen) { after?.(); return }
    this.afterClose = after ?? null
    this.dismiss(true)
  }
  /** Close without taking focus back, for a navigation that moves it elsewhere. */
  hide(): void { this.afterClose = null; this.dismiss(false) }
  private dismiss(refocus: boolean): void {
    if (!this.isOpen) return
    try { this.el.hidePopover?.() } catch { /* Not shown. */ }
    this.el.hidden = true
    window.removeEventListener('resize', this.position)
    document.removeEventListener('pointerdown', this.outside, true)
    document.removeEventListener('keydown', this.keydown, true)
    const opener = this.opener; this.opener = null
    opener?.setAttribute('aria-expanded', 'false')
    this.onVisibility()
    if (refocus && opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    const after = this.afterClose; this.afterClose = null; after?.()
  }
  private readonly position = (): void => {
    if (!this.opener) return
    const rect = this.opener.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight, gutter = 8
    const width = Math.min(400, vw - 2 * gutter)
    const left = Math.max(gutter, Math.min(rect.left, vw - width - gutter))
    const top = rect.bottom + 6
    this.el.style.setProperty('--ws-menu-left', `${left}px`)
    this.el.style.setProperty('--ws-menu-top', `${top}px`)
    this.el.style.setProperty('--ws-menu-width', `${width}px`)
    this.el.style.setProperty('--ws-menu-height', `${Math.max(160, vh - top - gutter)}px`)
  }
  private readonly outside = (event: Event): void => {
    const target = event.target as Node | null
    if (target && (this.el.contains(target) || this.opener?.contains(target))) return
    this.dismiss(false)
  }
  private readonly keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault(); event.stopPropagation()
    this.dismiss(true)
  }
  dispose(): void { this.hide(); this.el.remove() }
}
