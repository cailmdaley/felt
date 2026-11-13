// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { showToast } from './utils.js'

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
