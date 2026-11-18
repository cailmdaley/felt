import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { slugStem } from './slug'

/** Titles and the slugs the CLI's Slugify derives from them. */
const cliSlugs: Record<string, string> = JSON.parse(
  readFileSync(new URL('../../../internal/felt/testdata/slugify.json', import.meta.url), 'utf8'),
)

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

  it('derives the slug the CLI derives', () => {
    for (const [title, slug] of Object.entries(cliSlugs)) {
      expect(slugStem(title), title).toBe(slug)
    }
  })

  it('always matches the slug convention or is empty', () => {
    for (const title of ['Café résumé', 'Straße', 'ℓ-max', 'ﬁle ² ș ệ', 'Σ only', '[tag] Title', '--a__b--', '日本']) {
      expect(slugStem(title)).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/)
    }
  })
})
