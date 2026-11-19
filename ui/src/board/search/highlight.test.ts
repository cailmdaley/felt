// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { FOUND_MARK, highlight, unhighlight } from './highlight.js'

it('marks a match inside rendered markup, and takes the marks out again leaving the text whole', () => {
  const root = document.createElement('div')
  root.innerHTML = '<p>The <strong>Mask</strong> threshold and the mask footprint</p>'
  const before = root.innerHTML
  expect(highlight(root, 'mask')).toBe(true)
  expect([...root.querySelectorAll(`mark.${FOUND_MARK}`)].map(mark => mark.textContent)).toEqual(['Mask', 'mask'])
  expect(root.querySelector('strong > mark')).not.toBeNull()
  expect(root.textContent).toBe('The Mask threshold and the mask footprint')
  unhighlight(root)
  expect(root.innerHTML).toBe(before)
  expect(highlight(root, 'nowhere')).toBe(false)
})
