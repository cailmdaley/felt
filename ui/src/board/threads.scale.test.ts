// @vitest-environment jsdom
import { ThreadIndex, threadIndexBuilds } from './threads.js'
import { describe, expect, it, vi } from 'vitest'
import { buildKanbanResponseFromComposite } from './KanbanReadModel.js'
import { parseCompositeFeed } from './KanbanComposite.js'
import { boardCards, KanbanSurfaceRenderer, threadIndexFor } from './KanbanSurfaces.js'
import { FamilyPage, placeAt } from './workspace/FamilyPage.js'
import { conversations } from './testFixtures.js'

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

describe('a family splits across the sections its threads stand in', () => {
  // A root in Your turn over ten working threads; a working root over twelve threads in Your turn; a waiting hub over twelve waiting threads.
  const family = (rootPhase: string, threadPhase: string, n: number) => parseCompositeFeed({ host: 'owner', fibers: [['cmbx', null, rootPhase], ...Array.from({ length: n }, (_, k) => [`cmbx/t${k}`, 'cmbx', threadPhase])]
    .map(([id, parent, phase]) => ({ origin: 'owner', felt_store: '/store', path: `${id}.md`, orchestrator: parent,
      fiber: { id, name: id, status: 'active', created_at: '2026-10-01T09:00:00Z', shuttle: { kind: 'oneshot' } },
      runtime: { state: 'running', phase, session_uuid: `s-${id}` } })) })
  const draw = (board: ReturnType<typeof buildKanbanResponseFromComposite>) => new KanbanSurfaceRenderer({ getDragSourceId: () => null, setDragSourceId: () => {}, getLastResponse: () => board,
    stopDragAutoScroll: () => {}, transition: () => {}, setSurface: () => {}, openDetail: () => {} }).renderNowSection(board.now, {})
  it('threads in another state group beneath their root heading that section, named by slug', () => {
    const desk = draw(buildKanbanResponseFromComposite(family('waiting', 'working', 10)))
    expect([...desk.querySelectorAll('.kbn-card')].map(el => [el.querySelector('.kbn-card-name')!.textContent, el.classList.contains('kbn-card-header')])).toEqual([['cmbx', false], ['cmbx', true]])
    expect(desk.querySelector('.kbn-card-header .kbn-count-working')!.textContent).toBe('10 working')
  })
  it('threads in the row\'s own state hang beneath it, open where they need you', () => {
    const desk = draw(buildKanbanResponseFromComposite(family('waiting', 'waiting', 12)))
    expect(desk.querySelectorAll('.kbn-card')).toHaveLength(1)
    expect([...desk.querySelectorAll('.kbn-desk-threads .kbn-thread-name')].map(el => el.textContent)).toEqual(Array.from({ length: 12 }, (_, k) => `t${k}`).sort())
    expect(desk.querySelector('.kbn-count-needs')!.textContent).toBe('13 need you')
  })
  it('working threads beneath a working row stay folded until opened', () => {
    const desk = draw(buildKanbanResponseFromComposite(family('working', 'working', 3)))
    expect(desk.querySelector('.kbn-count-working')!.textContent).toBe('4 working')
    expect(desk.querySelector<HTMLElement>('.kbn-desk-threads')!.hidden).toBe(true)
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
      // Each family's root, and its header in each other section of work.
      expect(desk.querySelectorAll('.kbn-card')).toHaveLength(board.now.inFlight.length)
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
  it('draws the family page for a deep chain in work linear in the subtree, from the response\'s own index', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    try {
      const reads = (size: number) => {
        const board = buildKanbanResponseFromComposite(feed(chain(size)))
        const root = board.now.inFlight.find(c => c.id === 'c0')!
        const deepest = boardCards(board).find(c => c.id.endsWith(`/c${size - 1}`))!
        const index = threadIndexFor(board), page = new FamilyPage(conversations(), { marks: () => undefined, reach: () => 14 * 86_400_000, files: () => [], refresh: () => {}, lead: async () => undefined, embed: () => ({ el: document.createElement('div'), dispose: () => {} }), seen: () => {} }, placeAt(deepest), vi.fn())
        const before = threadIndexBuilds()
        // Map touches see the walks inside the index's methods, not only the calls.
        const count = counted(Map.prototype, ['get', 'set', 'has', 'delete'], () => page.update(root, index))
        expect(threadIndexBuilds()).toBe(before)
        expect(page.el.querySelectorAll('.fp-row')).toHaveLength(size)
        return count
      }
      expect(reads(N) / reads(N / 4)).toBeLessThan(LINEAR)
    } finally { vi.unstubAllGlobals() }
  })
})
