import { expect, it } from 'vitest'
import { parseChangeBundle } from './changeValidation.js'

it('accepts the current format and asks for a rebake of other versions', () => {
  expect(parseChangeBundle('{"version":2}').version).toBe(2)
  expect(() => parseChangeBundle('{"version":1}')).toThrow('rebaked with shuttle change')
})

it('reads a description as text and refuses anything else', () => {
  expect(parseChangeBundle('{"version":2,"description":"**Why**"}').description).toBe('**Why**')
  expect(() => parseChangeBundle('{"version":2,"description":7}')).toThrow('description')
})
