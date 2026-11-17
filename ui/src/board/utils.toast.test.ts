// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { CLEAR_UNDO_MS, clearToast, showToast } from './utils.js'

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren() })

it.each([['success', 'status', 'polite'], ['error', 'alert', 'assertive']] as const)('reads a %s toast to screen readers through the %s region without moving focus', (type, role, live) => {
  vi.useFakeTimers()
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  showToast('Copied the path', type)
  vi.advanceTimersByTime(100)
  expect(document.querySelector(`[role="${role}"][aria-live="${live}"]`)?.textContent).toBe('Copied the path')
  expect(document.querySelector('.shuttle-toast .toast-message')?.textContent).toBe('Copied the path')
  expect(document.activeElement).toBe(input)
})

it('takes back every clear still in its window with one undo; a clear after the window starts afresh', () => {
  vi.useFakeTimers()
  const undone: string[] = []
  clearToast("Cleared a's line.", () => undone.push('a'))
  vi.advanceTimersByTime(2000)
  clearToast("Cleared b's line.", () => undone.push('b'))
  expect(document.querySelectorAll('.shuttle-toast')).toHaveLength(1)
  expect(document.querySelector('.shuttle-toast .toast-message')?.textContent).toBe('Cleared 2 lines.')
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  expect(undone).toStrictEqual(['a', 'b'])
  vi.advanceTimersByTime(CLEAR_UNDO_MS + 1000)
  clearToast("Cleared c's line.", () => undone.push('c'))
  expect(document.querySelector('.shuttle-toast .toast-message')?.textContent).toBe("Cleared c's line.")
  document.querySelector<HTMLButtonElement>('.shuttle-toast .toast-undo')!.click()
  expect(undone).toStrictEqual(['a', 'b', 'c'])
})
