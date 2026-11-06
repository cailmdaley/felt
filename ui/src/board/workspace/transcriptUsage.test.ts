import { describe, expect, it } from 'vitest'
import { tokenLabel } from './transcriptUsage.js'

describe('tokenLabel', () => {
  it('keeps a decimal only below 100k', () => {
    expect([999, 1000, 1540, 99_940, 100_000, 182_340, 999_499, 999_500, 1_240_000].map(tokenLabel))
      .toEqual(['999', '1k', '1.5k', '99.9k', '100k', '182k', '999k', '1M', '1.2M'])
  })
})
