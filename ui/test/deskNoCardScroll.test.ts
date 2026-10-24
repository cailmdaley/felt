import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
import { expect, it } from 'vitest'

const board = fileURLToPath(new URL('../src/board/', import.meta.url))
function styles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? styles(path) : path.endsWith('.css') ? [path] : []
  })
}
function cardScrollViolations(css: string): string[] {
  const violations: string[] = []
  postcss.parse(css).walkDecls(decl => {
    if (!/^overflow(?:-[xy]|-block|-inline)?$/i.test(decl.prop) || !/\b(auto|scroll)\b/i.test(decl.value)) return
    for (let parent = decl.parent; parent; parent = parent.parent) {
      if (parent.type === 'rule' && /\.kbn-card(?:\b|-)/.test(parent.selector)) {
        violations.push(`${decl.source?.start?.line}: ${decl.prop}: ${decl.value}`)
        break
      }
    }
  })
  return violations
}
it('keeps every Desk card free of scrolling: only columns scroll', () => {
  expect(styles(board).flatMap(path => cardScrollViolations(readFileSync(path, 'utf8')).map(v => `${relative(board, path)}:${v}`))).toStrictEqual([])
})
it('guards nested rules, axes, grouped selectors and shorthand without banning clipping', () => {
  for (const property of ['overflow', 'overflow-x', 'overflow-y', 'overflow-inline', 'overflow-block']) {
    for (const value of ['auto', 'scroll', 'hidden auto']) {
      expect(cardScrollViolations(`@media (width > 1px) { .other, .kbn-card { & > .body { ${property}: ${value} } } }`)).toHaveLength(1)
      expect(cardScrollViolations(`.kbn-card-meta { ${property}: ${value} }`)).toHaveLength(1)
    }
  }
  expect(cardScrollViolations('.kbn-card .name { overflow: hidden } .kbn-col-list { overflow-y: auto }')).toStrictEqual([])
})
