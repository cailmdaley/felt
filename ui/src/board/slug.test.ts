import { describe, expect, it } from 'vitest'
import { slugStem } from './slug'

describe('slugStem', () => {
  it('joins lowercase words with single hyphens', () => {
    expect(slugStem('  Hello, World! 2026 ')).toBe('hello-world-2026')
  })

  it('never ends in a hyphen when the cut lands on a separator', () => {
    const title = `${'a'.repeat(59)} tail`
    expect(slugStem(title)).toBe('a'.repeat(59))
  })

  it('is empty for a title with no letters or digits', () => {
    expect(slugStem('— !')).toBe('')
  })
})
