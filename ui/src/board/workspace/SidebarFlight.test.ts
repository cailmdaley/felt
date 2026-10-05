// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SidebarFlight } from './SidebarFlight.js'
import { card } from '../testFixtures.js'
let root: HTMLElement, sidebar: HTMLElement, source: HTMLElement, row: HTMLElement
let flight: SidebarFlight
let reduced: boolean
let finish: () => void
const animate = vi.fn()
const rect = (x: number, y: number, w: number, h: number) => ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON() {} }) as DOMRect
beforeEach(() => {
  reduced = false
  vi.stubGlobal('matchMedia', () => ({ get matches() { return reduced }, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  animate.mockReset().mockImplementation(() => ({ finished: new Promise<void>(resolve => { finish = resolve }), cancel: vi.fn() }))
  Object.defineProperty(HTMLElement.prototype, 'animate', { configurable: true, value: animate })
  root = document.createElement('div'); sidebar = document.createElement('aside'); source = document.createElement('div'); row = document.createElement('div')
  sidebar.className = 'ws-sidebar'; row.className = 'ws-channel-row'; row.dataset.channelUid = 'a'; row.dataset.channelOwner = 'host'
  row.setAttribute('aria-current', 'true'); sidebar.append(row); root.append(sidebar, source); document.body.append(root)
  source.getBoundingClientRect = () => rect(500, 100, 360, 180)
  row.getBoundingClientRect = () => rect(12, 160, 256, 112)
  flight = new SidebarFlight(root, sidebar)
  flight.capture([{ card: card({ id: 'work/a', uid: 'a', originId: 'host' }), source }])
})
afterEach(() => { flight.dispose(); root.remove(); Reflect.deleteProperty(HTMLElement.prototype, 'animate'); vi.unstubAllGlobals(); vi.restoreAllMocks() })
it('uses real Desk and sidebar rects, animating only transform and opacity on the crossing', async () => {
  flight.setVisible(true)
  expect(source.classList.contains('ws-sidebar-source')).toBe(true)
  expect(animate).toHaveBeenCalledOnce()
  const [frames, options] = animate.mock.calls[0]
  expect(frames).toEqual([
    { transform: 'translate(488px, -60px) scale(1.40625, 1.6071428571428572)', opacity: 1 },
    { transform: 'none', opacity: 1 },
  ])
  expect(options).toEqual({ duration: 280, easing: 'ease', fill: 'both' })
  expect(row.classList.contains('ws-card-travelling')).toBe(true)
  finish(); await Promise.resolve()
  expect(row.classList.contains('ws-card-travelling')).toBe(false)
  flight.setVisible(false); finish(); await Promise.resolve()
  expect(source.classList.contains('ws-sidebar-source')).toBe(false)
})
it('transfers instantly under reduced motion and restores sources on disposal', () => {
  reduced = true
  flight.setVisible(true)
  expect(source.classList.contains('ws-sidebar-source')).toBe(true)
  expect(animate).not.toHaveBeenCalled()
  flight.setVisible(false)
  expect(source.classList.contains('ws-sidebar-source')).toBe(false)
  flight.setVisible(true); flight.dispose()
  expect(source.classList.contains('ws-sidebar-source')).toBe(false)
})
it('moves the current tone on travelling cards when constitution selection changes', () => {
  flight.setVisible(true)
  const ghost = root.querySelector('.ws-sidebar-flight .ws-channel-row')!
  expect(ghost.classList.contains('ws-flight-current')).toBe(true)
  row.setAttribute('aria-current', 'false'); flight.refresh()
  expect(ghost.classList.contains('ws-flight-current')).toBe(false)
})
