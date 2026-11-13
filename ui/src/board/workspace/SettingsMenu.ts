import '@ui-sdk/web/popover'
import './settings-menu.css'

/**
 * The settings dropdown: a non-modal SDK popover beneath the header, holding
 * only the settings content. Escape, a press outside or focus leaving closes
 * it; focus returns to the ⚙ that opened it.
 */
export class SettingsMenu {
  readonly el = document.createElement('ui-popover')
  private readonly panel = document.createElement('ui-popover-content')
  private opener: HTMLElement | null = null
  private afterClose: (() => void) | null = null

  constructor() {
    this.el.setAttribute('modal', 'false')
    const panel = this.panel
    panel.className = 'ws-settings-menu'
    panel.dataset.part = 'settings-menu'
    panel.setAttribute('aria-label', 'Settings')
    panel.setAttribute('initial-focus', 'content')
    panel.setAttribute('align', 'start')
    panel.setAttribute('side-offset', '6')
    panel.setAttribute('collision-padding', '8')
    this.el.append(panel)
    this.el.addEventListener('openchange', event => {
      if (event.detail.value) return
      // A press on the ⚙ is its toggle's, which closes the menu on click.
      if (event.detail.reason === 'outside-press' && this.opener?.contains(event.detail.event?.target as Node)) { event.preventDefault(); return }
      this.opener?.setAttribute('aria-expanded', 'false')
      this.opener = null
    })
    this.el.addEventListener('openchangecomplete', event => {
      if (event.detail.value) return
      const after = this.afterClose; this.afterClose = null; after?.()
    })
  }
  get isOpen(): boolean { return this.el.open }
  show(content: HTMLElement, opener: HTMLElement, host: HTMLElement): void {
    // The ⚙ that opened it closes it; another ⚙ moves it there.
    if (this.isOpen && this.opener === opener) { this.close(); return }
    if (this.isOpen) this.close()
    this.opener = opener
    host.append(this.el)
    content.hidden = false
    this.panel.replaceChildren(content)
    opener.setAttribute('aria-expanded', 'true')
    // Beneath the whole header when the ⚙ sits in it, aligned with the ⚙.
    const anchor = {
      getBoundingClientRect: (): DOMRect => {
        const own = opener.getBoundingClientRect()
        const header = opener.closest('.ws-band-head')?.getBoundingClientRect() ?? own
        return new DOMRect(own.left, header.top, own.width, header.bottom - header.top)
      },
    }
    // Controller-opened popups return focus to the element focused when they open.
    opener.focus({ preventScroll: true })
    void this.el.api.open({ anchor })
    this.panel.scrollTop = 0
  }
  close(after?: () => void): void {
    if (!this.isOpen) { after?.(); return }
    this.afterClose = after ?? null
    this.el.api.close()
  }
  dispose(): void { this.close(); this.el.remove() }
}
