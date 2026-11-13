// Browser-only popup and geometry APIs used by UI SDK. Native behavior is tested in e2e.
if (typeof HTMLElement !== 'undefined') {
  if (!('inert' in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get() { return this.hasAttribute('inert') },
    set(value: boolean) { this.toggleAttribute('inert', value) },
  })
  HTMLElement.prototype.showPopover ??= function () {}
  HTMLElement.prototype.hidePopover ??= function () {}
  Element.prototype.getAnimations ??= () => []
  HTMLElement.prototype.scrollIntoView ??= function () {}
  window.matchMedia ??= (media: string): MediaQueryList => ({
    matches: false, media, onchange: null,
    addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
  })
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
