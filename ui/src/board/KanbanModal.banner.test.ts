// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanModal } from './KanbanModal.js'

// Exercise banner lifetimes without starting the board's network polling.
function banner() {
  vi.useFakeTimers()
  const board = new KanbanModal({ shuttleBase: '' }) as unknown as {
    bannerEl: HTMLDivElement
    showBanner(text: string, kind?: 'error' | 'info'): void
  }
  board.bannerEl = document.createElement('div')
  board.bannerEl.setAttribute('role', 'alert')
  document.body.append(board.bannerEl)
  return board
}
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

it.each([['info', 5000], ['error', 12000]] as const)('keeps an %s banner readable for %i ms without moving focus', (kind, duration) => {
  const board = banner()
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  board.showBanner('A message to read', kind)
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('A message to read')
  expect(board.bannerEl.style.display).toBe('')
  expect(document.activeElement).toBe(input)
  vi.advanceTimersByTime(duration - 1)
  expect(board.bannerEl.style.display).toBe('')
  vi.advanceTimersByTime(1)
  expect(board.bannerEl.style.display).toBe('none')
})

it('replaces an info banner with an error and gives the error its full reading time', () => {
  const board = banner()
  board.showBanner('Saved')
  vi.advanceTimersByTime(4000)
  board.showBanner('Could not reach the host', 'error')
  vi.advanceTimersByTime(1000)
  expect(board.bannerEl.textContent).toBe('Could not reach the host')
  expect(board.bannerEl.style.display).toBe('')
  vi.advanceTimersByTime(11000)
  expect(board.bannerEl.style.display).toBe('none')
})
