import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('a conversation picker anchor refuses iOS link previews and selection under a held finger', () => {
  const css = readFileSync(resolve(__dirname, '../src/board/KanbanModal.css'), 'utf8')
  const rule = /\.kbn-picker-anchor\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  expect(rule).toContain('-webkit-touch-callout: none')
  expect(rule).toContain('user-select: none')
})
