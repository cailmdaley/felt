// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { DeskKeyboard } from './DeskKeyboard.js'

let keyboard: DeskKeyboard | undefined
afterEach(() => { keyboard?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('restores Desk selection without synchronous layout or scrolling a visible card', () => {
  let frame!: FrameRequestCallback
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const root = document.createElement('div')
  root.innerHTML = '<div data-column="inFlight" style="overflow-y: auto"><div data-card-uid="a" data-card-origin="host"></div></div>'
  document.body.append(root)
  const column = root.firstElementChild as HTMLElement, row = column.firstElementChild as HTMLElement
  const read = vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 10, 100, 100))
  const scroll = vi.fn(); row.scrollIntoView = scroll
  keyboard = new DeskKeyboard(root, vi.fn())
  keyboard.select({ uid: 'a', origin: 'host' })
  expect(row.getAttribute('aria-current')).toBe('true')
  expect(read).not.toHaveBeenCalled()
  frame(0)
  expect(scroll).not.toHaveBeenCalled()
  Object.defineProperty(column, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(column, 'clientHeight', { configurable: true, value: 50 })
  vi.spyOn(column, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 50))
  keyboard.select({ uid: 'a', origin: 'host' })
  frame(16)
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  keyboard.select({ uid: 'a', origin: 'host' })
  const replacement = row.cloneNode() as HTMLElement
  const replacementScroll = vi.fn(); replacement.scrollIntoView = replacementScroll
  replacement.getBoundingClientRect = () => new DOMRect(10, 900, 100, 100)
  row.replaceWith(replacement)
  keyboard.refresh()
  frame(32)
  expect(replacementScroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
  Object.defineProperty(column, 'offsetHeight', { configurable: true, value: 100 })
  Object.defineProperty(column, 'clientHeight', { configurable: true, value: 100 })
  replacement.getBoundingClientRect = () => new DOMRect(10, 40, 100, 30)
  replacementScroll.mockClear()
  keyboard.select({ uid: 'a', origin: 'host' })
  frame(48)
  expect(replacementScroll).toHaveBeenCalledOnce()
})
