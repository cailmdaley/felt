// @vitest-environment jsdom
import { ThreadIndex, threadIndexBuilds } from './threads.js'
import { describe, expect, it, vi } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { KanbanSurfaceRenderer } from './KanbanSurfaces.js'
import { boardCards, threadIndexFor } from './threads.js'
import { FamilyPage } from './workspace/FamilyPage.js'
import { deskOrder } from './deskOrdering.js'
import { servedFeed } from './testFixtures.js'

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
  return parseCompositeFeed(servedFeed({ host: 'owner', fibers: shape.map(([id, parent], n) => ({
    origin: 'owner', felt_store: '/store', path: `${id}.md`, orchestrator: parent,
    fiber: { id, name: id, status: 'active', created_at: '2026-10-01T09:00:00Z',
      shuttle: { kind: 'oneshot', ask: n % 4 === 0 ? { text: 'Which cut?', at: '2026-10-02T09:00:00Z' } : undefined } },
    runtime: n % 4 === 1 ? { state: 'running', phase: 'working', session_uuid: `s-${id}` } : null,
  })) }))
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

describe('a family is one card on the Desk', () => {
  const family = (rootPhase: string, threadPhase: string, n: number) => parseCompositeFeed(servedFeed({ host: 'owner', fibers: [['cmbx', null, rootPhase], ...Array.from({ length: n }, (_, k) => [`cmbx/t${k}`, 'cmbx', threadPhase])]
    .map(([id, parent, phase]) => ({ origin: 'owner', felt_store: '/store', path: `${id}.md`, orchestrator: parent,
      fiber: { id, name: id, status: 'active', created_at: '2026-10-01T09:00:00Z', shuttle: { kind: 'oneshot' } },
      runtime: { state: 'running', phase, session_uuid: `s-${id}` } })) }))
  const draw = (board: ReturnType<typeof buildKanbanResponseFromComposite>) => {
    const index = threadIndexFor(board)
    return new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: () => {}, clear: () => {} }).renderDesk(deskOrder(index, new Map()), index)
  }
  it('draws every member that waits as a line of the one card, uncapped, its working top-level said by its dot alone', () => {
    const desk = draw(buildKanbanResponseFromComposite(family('working', 'attention', 12)))
    expect(desk.querySelectorAll('.kbn-family')).toHaveLength(1)
    expect(desk.querySelectorAll('[data-column="waiting"] .kbn-family-line[data-kind]')).toHaveLength(12)
    expect([desk.querySelectorAll('.kbn-family-line').length, desk.querySelector('.kbn-family-meta')!.textContent]).toStrictEqual([12, ''])
  })
  it('puts a family whose workers are idle in Working, a line naming each one below the top-level', () => {
    const desk = draw(buildKanbanResponseFromComposite(family('waiting', 'waiting', 3)))
    expect(desk.querySelectorAll('[data-column="working"] .kbn-family')).toHaveLength(1)
    expect([...desk.querySelectorAll<HTMLElement>('.kbn-family-line')].map(line => [line.dataset.fiberId, line.querySelector('.thread-row-doing')!.textContent])).toStrictEqual([
      ['cmbx/t0', 'idle'], ['cmbx/t1', 'idle'], ['cmbx/t2', 'idle'],
    ])
    expect(desk.querySelector('.kbn-family-meta')!.textContent).toBe('')
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
      const renderer = new KanbanSurfaceRenderer({ waits: () => new Map(), openDetail: () => {}, clear: () => {} })
      const index = threadIndexFor(board)
      const desk = renderer.renderDesk(deskOrder(index, new Map()), index)
      // Each family once.
      expect(desk.querySelectorAll('.kbn-family')).toHaveLength(index.roots().length)
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
  it('places every family on the Desk in linear work for a deep chain', () => {
    const work = (size: number) => counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => {
      const board = buildKanbanResponseFromComposite(feed(chain(size)))
      deskOrder(threadIndexFor(board), new Map())
    })
    expect(work(N) / work(N / 4)).toBeLessThan(LINEAR)
  })
  it('draws the view of a deep chain\'s deepest thread, its orchestrators above, in work linear in the chain, from the response\'s own index', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const reads = (size: number) => {
        const board = buildKanbanResponseFromComposite(feed(chain(size)))
        const deepest = boardCards(board).find(c => c.id.endsWith(`/c${size - 1}`))!
        const index = threadIndexFor(board), page = new FamilyPage({ marks: () => undefined, reach: () => 14 * 86_400_000, files: () => [], refresh: () => {}, lead: async () => undefined, said: () => undefined, open: () => {}, link: () => {}, view: () => {}, seen: () => {}, waits: () => new Map(), shuttleBase: '' }, vi.fn())
        const before = threadIndexBuilds()
        // Map touches see the walks inside the index's methods, not only the calls.
        const count = counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => page.update(deepest, index))
        expect(threadIndexBuilds()).toBe(before)
        expect(page.el.querySelectorAll('.ov-ancestor')).toHaveLength(size - 1)
        return count
      }
      expect(reads(N) / reads(N / 4)).toBeLessThan(LINEAR)
    } finally { vi.unstubAllGlobals() }
  })
})
