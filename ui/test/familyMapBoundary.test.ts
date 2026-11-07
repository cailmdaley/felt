// A constitution's page keeps its model embeddable and its styles calm: nothing
// in board/family may reach the reader, the document host or the rest of the
// workspace, and no style truncates a name or moves under reduced motion.

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const FAMILY = resolve('src/board/family')
const PAGE = resolve('src/board/workspace/family-page.css')

it('keeps board/family free of workspace imports', () => {
  const imports = readdirSync(FAMILY).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap(name => [...readFileSync(join(FAMILY, name), 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]))
  expect(imports.length).toBeGreaterThan(4)
  expect(imports.filter(path => path.includes('workspace'))).toEqual([])
})
it('scopes every shared state style under the family map root', () => {
  const rules = readFileSync(join(FAMILY, 'family-map.css'), 'utf8').split('\n').filter(line => /^[.:[]/.test(line))
  expect(rules.length).toBeGreaterThan(5)
  expect(rules.filter(rule => !/^\.family-map/.test(rule))).toEqual([])
})
it('truncates no name by style', () => {
  const css = readFileSync(PAGE, 'utf8')
  for (const name of ['fp-name', 'fp-file-name']) {
    const rule = css.split('\n').find(line => line.startsWith(`.${name} {`))!
    expect(rule, name).toBeDefined()
    expect(rule, name).not.toMatch(/ellipsis|line-clamp|nowrap/)
  }
})
it('runs nothing forever, and moves nothing under reduced motion', () => {
  const css = readFileSync(PAGE, 'utf8')
  expect(css).not.toMatch(/\binfinite\b|animation:/)
  const moving = [...css.matchAll(/^(\.[^{]+)\{[^}]*transition:/gm)].map(match => match[1].trim())
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion'))
  for (const selector of moving) expect(reduced, selector).toContain(`${selector} { transition: none; }`)
})
