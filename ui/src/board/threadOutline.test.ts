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

it('splits a family by state: each section holds its own threads, the ones between named in the slug path', () => {
  expect(index.frontier().map(c => c.name)).toEqual(['A', 'A1'])
  // Your turn: A, and under it a1/b1, with no row for A1.
  expect(sectionOutline(index, a).map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1/b1', 0, 'A']])
  // Working: A1 stands as a top row named from the root, B2 under it.
  expect(rowLabel(index, a1)).toBe('a/a1')
  expect(sectionOutline(index, a1).map(row => [row.path, row.depth])).toEqual([['b2', 0]])
  expect(rowLabel(index, a)).toBe('A')
})

it('nests a thread under its nearest shown ancestor, indenting only by the rows shown', () => {
  const c1 = card({ id: 'proj/a/a1/b1/c1', name: 'C1', orchestrator: 'proj/a/a1/b1', ...working })
  const d1 = card({ id: 'proj/a/a1/b1/c1/d1', name: 'D1', orchestrator: 'proj/a/a1/b1/c1', ...waiting })
  const deep = new ThreadIndex([a, a1, b1, b2, c1, d1])
  expect(sectionOutline(deep, a).map(row => [row.path, row.depth, row.parent.name])).toEqual([['a1/b1', 0, 'A'], ['c1/d1', 1, 'B1']])
  expect(deep.frontier().map(c => c.name)).toEqual(['A', 'A1'])
})
