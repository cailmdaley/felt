// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { workspaceMeasure } from './measures.js'
it('reads minified second durations and milliseconds on the same clock', () => {
  const el = document.createElement('div'); document.body.append(el)
  for (const value of ['280ms', '.28s', '0.28s']) {
    el.style.setProperty('--ws-crossing', value)
    expect(workspaceMeasure(el, 'crossing', 280)).toBe(280)
  }
  el.style.setProperty('--ws-crossing', '0s')
  expect(workspaceMeasure(el, 'crossing', 280)).toBe(0)
  expect(workspaceMeasure(el, 'unknown', 12)).toBe(12)
  el.remove()
})
