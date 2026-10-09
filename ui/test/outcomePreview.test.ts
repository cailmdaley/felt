import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('clips outcome prose and its containing preview independently', () => {
  const css = readFileSync('src/board/workspace/fiber-prose.css', 'utf8')
  expect(css).toMatch(/\.ws-outcome-preview\s*\{[^}]*overflow:\s*hidden/)
  expect(css).toMatch(/\.ws-outcome-preview \.kbn-detail-lede\s*\{[^}]*max-height:\s*10em;\s*overflow:\s*hidden/)
})
