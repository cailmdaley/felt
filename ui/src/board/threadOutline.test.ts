// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { card } from './testFixtures.js'
import { ThreadIndex } from './threads.js'
import { rowLabel, sectionOutline } from './threadOutline.js'

const waiting = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'waiting' as const }
const working = { status: 'active' as const, workerState: 'running' as const, runtimePhase: 'working' as const }
// Cail's example: A is your turn, A1 under it is working, B1 under A1 is your turn.
const a = card({ id: 'proj/a', name: 'A', ...waiting })
const a1 = card({ id: 'proj/a/a1', name: 'A1', orchestrator: 'proj/a', ...working })
const b1 = card({ id: 'proj/a/a1/b1', name: 'B1', orchestrator: 'proj/a/a1', ...waiting })
const b2 = card({ id: 'proj/a/a1/b2', name: 'B2', orchestrator: 'proj/a/a1', ...working })
const index = new ThreadIndex([a, a1, b1, b2])

it('groups a family\'s threads beneath its root in each section, the ones between named in the slug path', () => {
  expect(index.frontier().map(c => c.name)).toEqual(['A'])
  expect(index.headers().map(c => [c.name, c.deskSection])).toEqual([['A', 'working']])
  // Your turn: A, and under it a1/b1, with no row for A1.
  expect(sectionOutline(index, a).map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1/b1', 0, 'A']])
  // Working: A heads it, with a1 beneath and A1's own working thread under that.
  expect(sectionOutline(index, a, 'working').map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1', 0, 'A'], ['b2', 1, 'A1']])
  expect(rowLabel(index, a)).toBe('a')
})

it('nests a thread under its nearest shown ancestor, indenting only by the rows shown', () => {
  const c1 = card({ id: 'proj/a/a1/b1/c1', name: 'C1', orchestrator: 'proj/a/a1/b1', ...working })
  const d1 = card({ id: 'proj/a/a1/b1/c1/d1', name: 'D1', orchestrator: 'proj/a/a1/b1/c1', ...waiting })
  const deep = new ThreadIndex([a, a1, b1, b2, c1, d1])
  expect(sectionOutline(deep, a).map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1/b1', 0, 'A'], ['c1/d1', 1, 'B1']])
  expect(sectionOutline(deep, a, 'working').map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1', 0, 'A'], ['b1/c1', 1, 'A1'], ['b2', 1, 'A1']])
})
