import { expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import { rowLabel } from './threadOutline.js'

it('names a family by its top-level\'s slug, after the path of any ancestor missing from the board', () => {
  const a = card({ id: 'proj/a', name: 'A', status: 'active' })
  const orphan = card({ id: 'proj/gone/b', name: 'B', orchestrator: 'proj/gone', status: 'active' })
  const index = new ThreadIndex([a, orphan])
  expect(index.roots().map(c => c.name)).toEqual(['A', 'B'])
  expect(rowLabel(index, a)).toBe('a')
  expect(rowLabel(index, orphan)).toBe('proj/gone/b')
})
