// Browser-only popup and geometry APIs used by UI SDK. Native behavior is tested in e2e.
if (typeof HTMLElement !== 'undefined') {
  if (!('inert' in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get() { return this.hasAttribute('inert') },
    set(value: boolean) { this.toggleAttribute('inert', value) },
  })
  ElementInternals.prototype.setFormValue ??= function () {}
  ElementInternals.prototype.setValidity ??= function () {}
  HTMLElement.prototype.showPopover ??= function () {}
  HTMLElement.prototype.hidePopover ??= function () {}
  Element.prototype.getAnimations ??= () => []
  ElementInternals.prototype.setFormValue ??= function () {}
  ElementInternals.prototype.setValidity ??= function () {}
  Element.prototype.animate ??= () => Object.assign(new EventTarget(), {
    finished: Promise.resolve(), currentTime: 0, pause() {}, cancel() {}, commitStyles() {},
  }) as unknown as Animation
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
