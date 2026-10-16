// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { card } from '../testFixtures.js'
import { ConstitutionPicker } from './ConstitutionPicker.js'

let picker: ConstitutionPicker | undefined
afterEach(() => { picker?.dispose(); document.body.replaceChildren(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('defers reveal layout to a frame and does not scroll an already-visible row', () => {
  let frame!: FrameRequestCallback
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const current = card({ id: 'visible' })
  picker = new ConstitutionPicker({ cards: () => [current], current: () => true, onOpen: vi.fn() })
  document.body.append(picker.el)
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 500))
  picker.refresh()
  expect(rect).not.toHaveBeenCalled()
  const row = picker.el.querySelector<HTMLElement>('.ws-channel-row')!
  const scroll = vi.fn()
  row.scrollIntoView = scroll
  let top = 100
  rect.mockImplementation(function (this: HTMLElement) { return this === row ? new DOMRect(10, top, 250, 50) : new DOMRect(0, 0, 300, 500) })
  frame(0)
  expect(scroll).not.toHaveBeenCalled()
  top = 600
  picker.reveal()
  expect(scroll).not.toHaveBeenCalled()
  frame(16)
  expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: 'nearest', inline: 'nearest', behavior: 'smooth' })
})

it('cancels a deferred reveal when selection returns to the already-revealed row', () => {
  const frames = new Map<number, FrameRequestCallback>()
  let nextFrame = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const cards = [card({ id: 'a' }), card({ id: 'b' })]
  let current = cards[0]
  picker = new ConstitutionPicker({ cards: () => cards, current: card => card === current, onOpen: vi.fn() })
  document.body.append(picker.el)
  const scroll = vi.fn()
  picker.refresh()
  for (const row of picker.el.querySelectorAll<HTMLElement>('.ws-channel-row')) row.scrollIntoView = scroll
  for (const callback of frames.values()) callback(0)
  frames.clear(); scroll.mockClear()
  current = cards[1]; picker.refresh()
  current = cards[0]; picker.refresh()
  for (const callback of frames.values()) callback(16)
  expect(scroll).not.toHaveBeenCalled()
})

it('reports only retained, placed rows after every refresh and revision patch, then removes them once', () => {
  let cards = [card({ id: 'a', uid: 'a', name: 'Alpha' }), card({ id: 'b', uid: 'b', name: 'Beta' })]
  const faces: HTMLElement[] = []
  const onRow = vi.fn((el: HTMLElement) => expect(el.parentElement?.className).toBe('ws-channel-list'))
  const onRemove = vi.fn((el: HTMLElement) => expect(el.isConnected).toBe(false))
  picker = new ConstitutionPicker({ cards: () => cards, onOpen: vi.fn(), onRow, onRemove,
    renderCard: card => {
      const el = document.createElement('div')
      el.innerHTML = `<span class="ws-channel-name">${card.name}</span><small class="ws-channel-owner"></small>`
      faces.push(el)
      return el
    },
  })
  document.body.append(picker.el)
  picker.refresh(false)
  const [alpha, beta] = [...picker.el.querySelectorAll<HTMLElement>('.ws-channel-row')]
  expect(onRow.mock.calls.map(([el]) => el)).toEqual([alpha, beta])
  cards = [{ ...cards[0], name: 'Revised Alpha' }, cards[1]]
  picker.refresh(false)
  expect(onRow.mock.calls.map(([el]) => el)).toEqual([alpha, beta, alpha, beta])
  expect(alpha.textContent).toContain('Revised Alpha')
  expect(onRow).not.toHaveBeenCalledWith(faces[2], expect.anything())
  picker.find.value = 'Alpha'; picker.refresh(false)
  expect(onRemove).toHaveBeenCalledExactlyOnceWith(beta)
  picker.dispose()
  expect(onRemove.mock.calls.map(([el]) => el)).toEqual([beta, alpha])
  picker.dispose()
  expect(onRemove).toHaveBeenCalledTimes(2)
})
