import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

it('stops every animation and drift of the map under reduced motion, whatever else sets them', () => {
  const css = readFileSync(resolve('src/board/family/family-map.css'), 'utf8')
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'))
  expect(reduced).toMatch(/--fm-drift: 0s !important/)
  expect(reduced).toMatch(/animation: none !important/)
})
