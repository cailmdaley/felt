// The family map's model and drawings stay embeddable: nothing in board/family
// may reach the reader, the document host or the rest of the workspace.

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

const FAMILY = resolve('src/board/family')

it('keeps board/family free of workspace imports', () => {
  const imports = readdirSync(FAMILY).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .flatMap(name => [...readFileSync(join(FAMILY, name), 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]))
  expect(imports.length).toBeGreaterThan(10)
  expect(imports.filter(path => path.includes('workspace'))).toEqual([])
})
it('scopes every drawing style under the family map root', () => {
  const css = readFileSync(join(FAMILY, 'family-map.css'), 'utf8')
  const rules = css.split('\n').filter(line => /^[.:[]/.test(line))
  expect(rules.length).toBeGreaterThan(50)
  expect(rules.filter(rule => !/^(:is\()?\.family-map/.test(rule))).toEqual([])
})
it('truncates no name by style', () => {
  const css = readFileSync(join(FAMILY, 'family-map.css'), 'utf8')
  for (const name of ['fm-label-name', 'fm-held-name', 'fm-focus-name', 'fm-row-name', 'fm-fold-name', 'fm-ledger-name']) {
    const rule = css.split('\n').find(line => line.startsWith(`.family-map .${name} {`))!
    expect(rule, name).toBeDefined()
    expect(rule, name).not.toMatch(/ellipsis|line-clamp|nowrap/)
  }
})
