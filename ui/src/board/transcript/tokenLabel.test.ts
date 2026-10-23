import { expect, it } from 'vitest'
import { tokenLabel } from './tokenLabel.js'

it('keeps a decimal only below 100k, where it still says something', () => {
  expect([999, 53_300, 99_949, 177_300, 999_600, 1_250_000].map(tokenLabel)).toEqual(['999', '53.3k', '99.9k', '177k', '1M', '1.3M'])
})
