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

  it('folds Latin letters to ASCII as the CLI does', () => {
    expect(slugStem('Café résumé')).toBe('cafe-resume')
    expect(slugStem('Straße')).toBe('strasse')
    expect(slugStem('Æsir Œuvre Øre Đak Łódź Þing Ðe Iı')).toBe('aesir-oeuvre-ore-dak-lodz-thing-de-ii')
  })

  it('always matches the slug convention or is empty', () => {
    for (const title of ['Café résumé', 'Straße', 'ℓ-max', 'ﬁle ² ș ệ', 'Σ only', '[tag] Title', '--a__b--', '日本']) {
      expect(slugStem(title)).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/)
    }
  })
})
