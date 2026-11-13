// Browser-only popup and geometry APIs used by UI SDK. Native behavior is tested in e2e.
if (typeof HTMLElement !== 'undefined') {
  if (!('inert' in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, 'inert', {
    configurable: true,
    get() { return this.hasAttribute('inert') },
    set(value: boolean) { this.toggleAttribute('inert', value) },
  })
  ElementInternals.prototype.setFormValue ??= function () {}
  ElementInternals.prototype.setValidity ??= function () {}
  globalThis.CSS ??= {} as typeof CSS
  CSS.supports ??= () => false
  CSS.escape ??= (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
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
  // jsdom has no CSS namespace: no feature is supported, and escape covers the ids an external popup trigger names.
  globalThis.CSS ??= {
    supports: () => false,
    escape: (value: string) => value.replace(/[^\w-]/g, ch => `\\${ch}`),
  } as unknown as typeof CSS
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
