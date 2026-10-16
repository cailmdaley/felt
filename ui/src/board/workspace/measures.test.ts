// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { invalidateWorkspaceMeasures, workspaceMeasure, workspaceToken } from './measures.js'
import { APPEARANCE_CHANGED } from '../appearance.js'
it('reads minified second durations and milliseconds on the same clock', () => {
  const el = document.createElement('div'); document.body.append(el)
  for (const value of ['280ms', '.28s', '0.28s']) {
    el.style.setProperty('--ws-crossing', value)
    invalidateWorkspaceMeasures(el)
    expect(workspaceMeasure(el, 'crossing', 280)).toBe(280)
  }
  el.style.setProperty('--ws-crossing', '0s')
  invalidateWorkspaceMeasures(el)
  expect(workspaceMeasure(el, 'crossing', 280)).toBe(0)
  expect(workspaceMeasure(el, 'unknown', 12)).toBe(12)
  el.remove()
})

it('reads style once across transitions and invalidates on appearance and channel theme changes', () => {
  const el = document.createElement('div'); document.body.append(el)
  el.style.setProperty('--ws-crossing', '.28s')
  el.style.setProperty('--ws-ease', 'ease')
  const read = vi.spyOn(window, 'getComputedStyle')
  try {
    expect(workspaceMeasure(el, 'crossing', 0)).toBe(280)
    expect(workspaceToken(el, 'ease')).toBe('ease')
    workspaceMeasure(el, 'crossing', 0)
    expect(read).toHaveBeenCalledOnce()
    el.style.setProperty('--ws-crossing', '100ms')
    el.dispatchEvent(new Event('workspace-theme-change', { bubbles: true }))
    expect(workspaceMeasure(el, 'crossing', 0)).toBe(100)
    window.dispatchEvent(new Event(APPEARANCE_CHANGED))
    expect(workspaceMeasure(el, 'crossing', 0)).toBe(100)
    expect(read).toHaveBeenCalledTimes(3)
  } finally { read.mockRestore(); el.remove() }
})
