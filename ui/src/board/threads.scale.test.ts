// @vitest-environment jsdom
import { threadIndexBuilds } from './threads.js'
import { describe, expect, it, vi } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, KanbanSurfaceRenderer, threadIndexFor } from './KanbanSurfaces.js'
import type { KanbanResponse } from './KanbanTypes.js'
import { ThreadRail } from './workspace/ThreadRail.js'

const N = 472
type Shape = Array<[id: string, parent: string | null]>
/** One chain N deep: every constitution the thread of the one before. */
function chain(): Shape {
  const rows: Shape = [['c0', null]]
  for (let n = 1; n < N; n++) rows.push([`${rows[n - 1][0]}/c${n}`, rows[n - 1][0]])
  return rows
}
/** Roots of twenty threads each, a quarter of them waiting. */
function groups(): Shape {
  const rows: Shape = []
  for (let g = 0; rows.length < N; g++) {
    rows.push([`g${g}`, null])
    for (let n = 0; n < 20 && rows.length < N; n++) rows.push([`g${g}/t${n}`, `g${g}`])
  }
  return rows
}
function feed(shape: Shape) {
  return parseCompositeFeed({ host: 'owner', fibers: shape.map(([id, parent], n) => ({
    origin: 'owner', felt_store: '/store', path: `${id}.md`, orchestrator: parent,
    fiber: { id, name: id, status: 'active', created_at: '2026-10-01T09:00:00Z',
      shuttle: { kind: 'oneshot', ask: n % 4 === 0 ? { text: 'Which cut?', at: '2026-10-02T09:00:00Z' } : undefined } },
    runtime: n % 4 === 1 ? { state: 'running', phase: 'working', session_uuid: `s-${id}` } : null,
  })) })
}
function fastest(run: () => void): number {
  let best = Infinity
  for (let n = 0; n < 3; n++) { const start = performance.now(); run(); best = Math.min(best, performance.now() - start) }
  return best
}

describe('thread read model at fleet scale', () => {
  for (const [name, shape] of [['one deep chain', chain()], ['groups of twenty', groups()]] as const) {
    it(`builds ${N} constitutions as ${name} without per-card graph rebuilds`, () => {
      const input = feed(shape)
      let board!: KanbanResponse
      const ms = fastest(() => { board = buildKanbanResponseFromComposite(input) })
      expect(boardCards(board)).toHaveLength(N)
      expect(ms).toBeLessThan(60)
      // One graph per response: drawing every family and reading the index
      // again builds nothing more.
      const before = threadIndexBuilds()
      board = buildKanbanResponseFromComposite(input)
      expect(threadIndexBuilds()).toBe(before + 1)
      const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => board,
        stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: () => {}, onRefresh: () => {} })
      const desk = renderer.renderNowSection(board.now, {})
      expect(desk.querySelectorAll('.kbn-thread-family').length).toBeGreaterThan(0)
      expect(threadIndexFor(board)).toBe(threadIndexFor(board))
      expect(threadIndexBuilds()).toBe(before + 1)
    })
  }
  it('draws the rail for a deep chain in bounded time', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const board = buildKanbanResponseFromComposite(feed(chain()))
      const root = board.now.inFlight.find(c => c.id === 'c0')!
      const rail = new ThreadRail(vi.fn(), vi.fn())
      const before = threadIndexBuilds()
      const start = performance.now()
      rail.show(root, threadIndexFor(board))
      expect(performance.now() - start).toBeLessThan(500)
      expect(threadIndexBuilds()).toBe(before)
      expect(rail.el.querySelectorAll('.ws-thread-tree > ul .kbn-thread-row')).toHaveLength(N - 1)
    } finally { vi.unstubAllGlobals() }
  })
})
