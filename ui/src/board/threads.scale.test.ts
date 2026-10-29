// @vitest-environment jsdom
import { ThreadIndex, threadIndexBuilds } from './threads.js'
import { describe, expect, it, vi } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, KanbanSurfaceRenderer, threadIndexFor } from './KanbanSurfaces.js'
import { ThreadRail } from './workspace/ThreadRail.js'

const N = 472
type Shape = Array<[id: string, parent: string | null]>
/** One chain `size` deep: every constitution the thread of the one before. */
function chain(size = N): Shape {
  const rows: Shape = [['c0', null]]
  for (let n = 1; n < size; n++) rows.push([`${rows[n - 1][0]}/c${n}`, rows[n - 1][0]])
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
/**
 * Work done by `run`, counted rather than timed: calls to the named methods
 * of `target`. Wall-clock budgets swing tenfold under a parallel run; a count
 * does not, and its growth between two sizes says linear or not.
 */
function counted<T extends object>(target: T, names: readonly (keyof T)[], run: () => void): number {
  let calls = 0
  const spies = names.map(name => {
    const original = target[name] as (...args: unknown[]) => unknown
    return vi.spyOn(target, name as never).mockImplementation(function (this: unknown, ...args: unknown[]) { calls++; return original.apply(this, args) } as never)
  })
  try { run() } finally { for (const spy of spies) spy.mockRestore() }
  return calls
}
/** Growing the input fourfold grows linear work about fourfold; a quadratic regression gives about sixteen. */
const LINEAR = 6

describe('a family of many threads is still one row', () => {
  // A root in Your turn over ten working threads; a working root over twelve threads in Your turn.
  const family = (rootPhase: string, threadPhase: string, n: number) => parseCompositeFeed({ host: 'owner', fibers: [['cmbx', null, rootPhase], ...Array.from({ length: n }, (_, k) => [`cmbx/t${k}`, 'cmbx', threadPhase])]
    .map(([id, parent, phase]) => ({ origin: 'owner', felt_store: '/store', path: `${id}.md`, orchestrator: parent,
      fiber: { id, name: id, status: 'active', created_at: '2026-10-01T09:00:00Z', shuttle: { kind: 'oneshot' } },
      runtime: { state: 'running', phase, session_uuid: `s-${id}` } })) })
  const draw = (board: ReturnType<typeof buildKanbanResponseFromComposite>) => new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => board,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: () => {} }).renderNowSection(board.now, {})
  it('a root in Your turn over ten working threads shows the working count', () => {
    const board = buildKanbanResponseFromComposite(family('waiting', 'working', 10))
    const desk = draw(board)
    expect(desk.querySelectorAll('.kbn-card')).toHaveLength(1)
    expect(desk.querySelector('.kbn-card')!.getAttribute('data-fiber-id')).toBe('cmbx')
    expect(desk.querySelector('.kbn-count-working')!.textContent).toBe('10 working')
    expect(desk.querySelector('.kbn-count-needs')).toBeNull()
    expect(desk.querySelector('.kbn-family-asks')).toBeNull()
  })
  it('a working root over twelve askers leads with the first, lists three, and folds nine', () => {
    const board = buildKanbanResponseFromComposite(family('working', 'waiting', 12))
    const desk = draw(board)
    expect(desk.querySelectorAll('.kbn-card')).toHaveLength(1)
    expect(desk.querySelector('.kbn-card')!.getAttribute('data-fiber-id')).toBe('cmbx/t0')
    expect(desk.querySelector('.kbn-card-crumb')!.textContent).toBe('cmbx /\u00a0')
    expect([...desk.querySelectorAll('.kbn-family-ask-name')].map(el => el.textContent)).toEqual(['cmbx/t1', 'cmbx/t2', 'cmbx/t3'])
    expect(desk.querySelector('.kbn-family-more')!.textContent).toBe('+8 more')
    expect(desk.querySelector('.kbn-count-needs')!.textContent).toBe('11 need you')
    expect(desk.querySelector('.kbn-count-working')).toBeNull()
    expect(desk.querySelector('.kbn-thread-count')!.getAttribute('title')).toBe('11 your turn, 1 working elsewhere in this family')
  })
})

describe('thread read model at fleet scale', () => {
  for (const [name, shape] of [['one deep chain', chain()], ['groups of twenty', groups()]] as const) {
    it(`builds ${N} constitutions as ${name} without per-card graph rebuilds`, () => {
      const input = feed(shape)
      let board = buildKanbanResponseFromComposite(input)
      expect(boardCards(board)).toHaveLength(N)
      // One graph per response: drawing every family and reading the index
      // again builds nothing more.
      const before = threadIndexBuilds()
      board = buildKanbanResponseFromComposite(input)
      expect(threadIndexBuilds()).toBe(before + 1)
      const renderer = new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => board,
        stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: () => {} })
      const desk = renderer.renderNowSection(board.now, {})
      // Each tree is one row; a family's many askers fold to three sub-lines and a `+N more`.
      expect(desk.querySelectorAll('.kbn-card')).toHaveLength(threadIndexFor(board).frontier().filter(c => board.now.inFlight.includes(c)).length)
      for (const asks of desk.querySelectorAll('.kbn-family-asks')) expect(asks.querySelectorAll('.kbn-family-ask').length).toBeLessThanOrEqual(3)
      expect(desk.querySelector('.kbn-thread-tree')).toBeNull()
      expect(threadIndexFor(board)).toBe(threadIndexFor(board))
      expect(threadIndexBuilds()).toBe(before + 1)
    })
  }
  it('builds the index in work linear in the board', () => {
    // Every map touch the index makes while it builds, at two chain depths.
    const work = (size: number) => {
      const cards = boardCards(buildKanbanResponseFromComposite(feed(chain(size))))
      return counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => { new ThreadIndex(cards) })
    }
    expect(work(N) / work(N / 4)).toBeLessThan(LINEAR)
  })
  it('projects the frontier and reads every family in linear work for a deep chain', () => {
    const work = (size: number) => counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => {
      const board = buildKanbanResponseFromComposite(feed(chain(size)))
      const index = threadIndexFor(board)
      index.frontier()
      for (const card of boardCards(board)) index.family(card)
    })
    expect(work(N) / work(N / 4)).toBeLessThan(LINEAR)
  })
  it('draws the rail for a deep chain in work linear in the subtree, from the response\'s own index', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const reads = (size: number) => {
        const board = buildKanbanResponseFromComposite(feed(chain(size)))
        const root = board.now.inFlight.find(c => c.id === 'c0')!
        const index = threadIndexFor(board), rail = new ThreadRail(vi.fn(), vi.fn())
        const before = threadIndexBuilds()
        // Map touches see the walks inside the index's methods, not only the calls.
        const count = counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => rail.show(root, index))
        expect(threadIndexBuilds()).toBe(before)
        expect(rail.el.querySelectorAll('.ws-thread-group .kbn-thread-row')).toHaveLength(size - 1)
        return count
      }
      expect(reads(N) / reads(N / 4)).toBeLessThan(LINEAR)
    } finally { vi.unstubAllGlobals() }
  })
})
